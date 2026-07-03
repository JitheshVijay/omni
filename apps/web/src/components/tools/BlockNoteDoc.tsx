// BlockNote editor wrapper for AI Docs. Adapted from Flo101's ThreadEditor +
// BlockNoteCitation: default schema plus a `citation` inline-content spec
// (the pill fires an "omni:citation-click" CustomEvent the host page picks
// up to scroll/highlight the matching source card).
//
// Markdown round-trip keeps citations alive in BOTH directions:
//   - setMarkdown(): editor.tryParseMarkdownToBlocks(), then a post-parse
//     walk splits text runs on [[cite:IDX:LABEL]] tokens and replaces them
//     with {type:"citation"} inline items.
//   - getMarkdown(): the inverse walk turns citation items back into tokens
//     before blocksToMarkdownLossy(), so content.markdown (the export + TTS
//     source) never loses the citations.
//
// BlockNote/Mantine CSS is imported HERE (not in globals) so the styles ship
// with the lazy doc-page chunks and the chat bundle stays lean.

import { useEffect, useImperativeHandle, useRef } from "react";
import {
  BlockNoteSchema,
  defaultInlineContentSpecs,
  type PartialBlock,
} from "@blocknote/core";
import {
  FormattingToolbar,
  FormattingToolbarController,
  createReactInlineContentSpec,
  getFormattingToolbarItems,
  useCreateBlockNote,
} from "@blocknote/react";
import { BlockNoteView } from "@blocknote/mantine";
import "@blocknote/core/fonts/inter.css";
import "@blocknote/mantine/style.css";
import { useTheme } from "@/components/theme";
import type { DocSource } from "@/lib/types";
import { cn } from "@/lib/utils";

export const CITATION_CLICK_EVENT = "omni:citation-click";

export interface CitationClickDetail {
  label: string;
  source_idx: number;
}

// Citation pill rendered inline inside BlockNote text. Clicking fires a
// window event so the pill stays decoupled from the page's React state
// (which lives outside BlockNote's tree).
const Citation = createReactInlineContentSpec(
  {
    type: "citation",
    propSchema: {
      label: { default: "" },
      source_idx: { default: 1 },
    },
    content: "none",
  },
  {
    render: (props) => {
      const { label, source_idx } = props.inlineContent.props;
      return (
        <button
          type="button"
          contentEditable={false}
          title={`Source ${source_idx}${label ? ` — ${label}` : ""}`}
          onClick={() => {
            window.dispatchEvent(
              new CustomEvent<CitationClickDetail>(CITATION_CLICK_EVENT, {
                detail: { label, source_idx },
              }),
            );
          }}
          className="mx-0.5 inline-flex select-none items-center gap-1 rounded-md border border-accent/25 bg-accent/10 px-1.5 py-0.5 align-baseline font-mono text-[11px] leading-none text-accent transition hover:border-accent/50 hover:bg-accent/20"
        >
          <span className="tabular-nums">{source_idx}</span>
          {label && <span className="max-w-[140px] truncate font-sans">{label}</span>}
        </button>
      );
    },
  },
);

const schema = BlockNoteSchema.create({
  inlineContentSpecs: {
    ...defaultInlineContentSpecs,
    citation: Citation,
  },
});

// ── [[cite:IDX:LABEL]] ⇄ citation inline items ──────────────────────────

const CITE_TOKEN_RE = /\[\[cite:(\d+):([^\]]*?)\]\]/g;

// Minimal structural types for walking BlockNote block JSON — the real
// generics don't unify across schema instances, and the persistence layer
// round-trips plain JSON anyway.
interface InlineItemish {
  type: string;
  text?: string;
  styles?: Record<string, unknown>;
  props?: Record<string, unknown>;
  [key: string]: unknown;
}
interface Blockish {
  type?: string;
  content?: unknown;
  children?: Blockish[];
  [key: string]: unknown;
}

function splitTextRun(item: InlineItemish, sources: DocSource[]): InlineItemish[] {
  const text = item.text ?? "";
  CITE_TOKEN_RE.lastIndex = 0;
  if (!CITE_TOKEN_RE.test(text)) return [item];
  CITE_TOKEN_RE.lastIndex = 0;

  const out: InlineItemish[] = [];
  let last = 0;
  for (const m of text.matchAll(CITE_TOKEN_RE)) {
    const idx = m.index ?? 0;
    if (idx > last) {
      out.push({ ...item, text: text.slice(last, idx) });
    }
    const sourceIdx = Number(m[1]) || 1;
    const label =
      m[2] || sources.find((s) => s.idx === sourceIdx)?.label || "";
    out.push({
      type: "citation",
      props: { label, source_idx: sourceIdx },
    });
    last = idx + m[0].length;
  }
  if (last < text.length) out.push({ ...item, text: text.slice(last) });
  return out;
}

/** Post-parse pass: replace [[cite:IDX:LABEL]] tokens inside text runs with
 *  citation inline items. Non-array content (tables) is left untouched. */
export function tokensToCitations(blocks: Blockish[], sources: DocSource[]): Blockish[] {
  return blocks.map((block) => {
    const next: Blockish = { ...block };
    if (Array.isArray(block.content)) {
      next.content = (block.content as InlineItemish[]).flatMap((item) =>
        item.type === "text" ? splitTextRun(item, sources) : [item],
      );
    }
    if (Array.isArray(block.children) && block.children.length > 0) {
      next.children = tokensToCitations(block.children, sources);
    }
    return next;
  });
}

/** Inverse pass for markdown export: citation items → literal tokens so
 *  blocksToMarkdownLossy keeps them in content.markdown. */
export function citationsToTokens(blocks: Blockish[]): Blockish[] {
  return blocks.map((block) => {
    const next: Blockish = { ...block };
    if (Array.isArray(block.content)) {
      next.content = (block.content as InlineItemish[]).map((item) =>
        item.type === "citation"
          ? {
              type: "text",
              text: `[[cite:${Number(item.props?.source_idx) || 1}:${String(item.props?.label ?? "")}]]`,
              styles: {},
            }
          : item,
      );
    }
    if (Array.isArray(block.children) && block.children.length > 0) {
      next.children = citationsToTokens(block.children);
    }
    return next;
  });
}

// ── Component ────────────────────────────────────────────────────────────

export interface BlockNoteDocHandle {
  /** Current doc as markdown, citation pills serialized back to tokens. */
  getMarkdown: () => string;
  /** Current doc as BlockNote block JSON (persisted in content.blocks). */
  getBlocks: () => unknown[];
  /** Parse markdown (+ citation conversion) and replace the whole doc.
   *  Used for streaming re-parses and the final artifact load. Pass
   *  `sources` when they were fetched in the same tick — the prop update
   *  hasn't rendered yet, so the internal ref would be stale. */
  setMarkdown: (markdown: string, sources?: DocSource[]) => void;
  /** Replace the whole doc with saved block JSON. */
  setBlocks: (blocks: unknown[]) => void;
}

export interface BlockNoteDocProps {
  initialMarkdown?: string;
  blocks?: unknown[] | null;
  sources: DocSource[];
  editable: boolean;
  /** Fired (debounced ~600ms) after user edits; programmatic replaces are
   *  suppressed so streaming never marks the doc dirty. */
  onDirtyChange?: (dirty: boolean) => void;
  editorRef?: React.Ref<BlockNoteDocHandle>;
  className?: string;
}

export function BlockNoteDoc({
  initialMarkdown,
  blocks,
  sources,
  editable,
  onDirtyChange,
  editorRef,
  className,
}: BlockNoteDocProps) {
  const editor = useCreateBlockNote({
    schema,
    initialContent:
      blocks && blocks.length > 0
        ? (blocks as PartialBlock[])
        : [{ type: "paragraph" }],
  });

  const { resolvedTheme } = useTheme();

  // Programmatic replaces (streaming, artifact load) must not read as user
  // edits — the suppress flag gates the onChange → dirty pipeline.
  const suppressRef = useRef(false);
  const sourcesRef = useRef(sources);
  sourcesRef.current = sources;
  const dirtyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const replaceAll = (next: PartialBlock[]) => {
    suppressRef.current = true;
    try {
      editor.replaceBlocks(
        editor.document,
        next.length > 0 ? next : [{ type: "paragraph" }],
      );
    } finally {
      // BlockNote dispatches onChange synchronously within replaceBlocks.
      suppressRef.current = false;
    }
  };

  useImperativeHandle(
    editorRef,
    () => ({
      getMarkdown: () =>
        editor.blocksToMarkdownLossy(
          citationsToTokens(editor.document as unknown as Blockish[]) as PartialBlock[],
        ),
      getBlocks: () => editor.document as unknown[],
      setMarkdown: (markdown: string, freshSources?: DocSource[]) => {
        if (freshSources) sourcesRef.current = freshSources;
        const parsed = editor.tryParseMarkdownToBlocks(markdown);
        replaceAll(
          tokensToCitations(
            parsed as unknown as Blockish[],
            sourcesRef.current,
          ) as PartialBlock[],
        );
      },
      setBlocks: (next: unknown[]) => replaceAll(next as PartialBlock[]),
    }),
    [editor],
  );

  // Seed from markdown when no saved blocks were provided (first open of a
  // freshly generated doc). Runs once per mount.
  useEffect(() => {
    if ((blocks?.length ?? 0) > 0 || !initialMarkdown) return;
    const parsed = editor.tryParseMarkdownToBlocks(initialMarkdown);
    replaceAll(
      tokensToCitations(
        parsed as unknown as Blockish[],
        sourcesRef.current,
      ) as PartialBlock[],
    );
  }, [editor]);

  // Debounced dirty signal on real user edits.
  useEffect(() => {
    const off = editor.onChange(() => {
      if (suppressRef.current || !onDirtyChange) return;
      if (dirtyTimerRef.current) clearTimeout(dirtyTimerRef.current);
      dirtyTimerRef.current = setTimeout(() => onDirtyChange(true), 600);
    });
    return () => {
      off?.();
      if (dirtyTimerRef.current) clearTimeout(dirtyTimerRef.current);
    };
  }, [editor, onDirtyChange]);

  return (
    <div className={cn("omni-doc-shell", className)}>
      <BlockNoteView
        editor={editor}
        editable={editable}
        theme={resolvedTheme}
        formattingToolbar={false}
      >
        {/* The onMouseDownCapture -> preventDefault wrapper is what makes
            Bold/Italic/Heading/Align actually apply on desktop in BlockNote
            0.50: toolbar buttons no longer preventDefault on mousedown, so a
            desktop click blurs ProseMirror and collapses the selection before
            the button's onClick runs. Eating mousedown in the capture phase
            keeps the selection intact (see Flo101 ThreadEditor for the full
            forensic note). */}
        <FormattingToolbarController
          formattingToolbar={() => (
            <div onMouseDownCapture={(e) => e.preventDefault()}>
              <FormattingToolbar>{getFormattingToolbarItems()}</FormattingToolbar>
            </div>
          )}
        />
      </BlockNoteView>
    </div>
  );
}
