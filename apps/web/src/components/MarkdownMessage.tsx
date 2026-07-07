// The markdown body of a chat turn: GFM + math (KaTeX) + syntax-highlighted
// fenced code. Memoized on `content`, since parsing markdown and Prism-
// highlighting code is the heavy part of a turn, and the composer's input
// lives on the page component, so every keystroke re-renders the page.
// Keying on the content string means typing never re-parses finished
// replies. (The streaming draft re-renders per delta by design.)

import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { CodeBlock } from "@/components/CodeBlock";

export const MarkdownMessage = memo(function MarkdownMessage({
  content,
}: {
  content: string;
}) {
  return (
    <div className="omni-prose min-w-0 text-[15px] leading-relaxed text-ink/90">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={{
          a: ({ href, children, ...rest }) => (
            <a
              href={typeof href === "string" ? href : ""}
              target="_blank"
              rel="noopener noreferrer"
              {...rest}
            >
              {children}
            </a>
          ),
          // A fenced block (language- class OR multiline) becomes a
          // syntax-highlighted CodeBlock with a language label + copy; a
          // short inline span stays an inline chip. `pre` is a passthrough
          // so we don't double-wrap in a <pre>.
          code: ({ className, children }) => {
            const match = /language-(\w+)/.exec(className || "");
            const text = String(children ?? "").replace(/\n$/, "");
            const isBlock = !!match || text.includes("\n");
            if (!isBlock) {
              return (
                <code className="rounded bg-ink/[0.07] px-1.5 py-0.5 font-mono text-[0.85em] text-ink">
                  {children}
                </code>
              );
            }
            return <CodeBlock code={text} lang={match?.[1] ?? "text"} />;
          },
          pre: ({ children }) => <>{children}</>,
          table: ({ children, ...rest }) => (
            <div className="overflow-x-auto scrollbar-thin">
              <table {...rest}>{children}</table>
            </div>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
});
