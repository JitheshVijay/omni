// Deep Research pipeline: a question fans out into 3-5 focused sub-queries,
// each searched on Exa and its top pages fetched, then an LLM synthesises a
// cited markdown report streamed token-by-token. The result is persisted as
// a doc artifact (kind 'doc') so it opens in the existing DocEditorPage and
// exports/narrates like any other document.
//
// Content shape (matches generators/doc.ts DocContent):
//   { markdown, blocks: null, sources: [{idx,label,file_id,snippet}] }
// meta: { subtype: "research", question, source_count }
import {
  LLM_REQUEST_OPTS,
  MODELS,
  callLLMJSON,
  getExaContents,
  openai,
  providerRoutingForCache,
  searchExa,
  wrapSystemForCache,
} from "@omni/sdk";
import {
  insertArtifact,
  toArtifactSummary,
  type ArtifactSummary,
} from "../generators/types.js";

// ─── Events (mirrors GenEvent so the SSE route can forward as-is) ────

export type ResearchEvent =
  | { type: "status"; label: string }
  | { type: "delta"; channel: string; data: unknown }
  | { type: "artifact"; artifact: ArtifactSummary };

export interface ResearchCtx {
  signal: AbortSignal;
  emit: (e: ResearchEvent) => void;
}

// One numbered, deduped source backing the report. `idx` is the [n] the
// report cites; the persisted DocSource maps label<-title, file_id=null.
interface ResearchSource {
  idx: number;
  title: string;
  url: string;
  snippet: string;
}

const MAX_SOURCES = 14;
const NUM_RESULTS_PER_QUERY = 4;
const CONTENT_CHARS_PER_URL = 1500;
// Top URLs per sub-query we pay to fetch full-ish text for.
const CONTENTS_TOP_N = 3;

// ─── Sub-query planning ─────────────────────────────────────────────

interface QueryPlan {
  queries: string[];
}

async function planQueries(question: string, signal: AbortSignal): Promise<string[]> {
  if (signal.aborted) throw new Error("aborted");
  const system =
    "You are a research strategist. Given a user's research question, break it " +
    "into 3-5 focused, non-overlapping web-search queries that together cover " +
    "the question comprehensively. Each query should be a concise search string " +
    "(not a full sentence), targeting a distinct facet, angle, or sub-topic.";
  const prompt =
    `Research question: ${question}\n\n` +
    'Respond with JSON of the form {"queries": ["...", "..."]} — 3 to 5 queries, ' +
    "most important first.";
  try {
    const plan = await callLLMJSON<QueryPlan>({
      system,
      prompt,
      model: MODELS.default,
      maxTokens: 512,
    });
    const queries = (plan.queries ?? [])
      .filter((q): q is string => typeof q === "string" && q.trim().length > 0)
      .map((q) => q.trim())
      .slice(0, 5);
    // Always keep at least the original question as a search.
    return queries.length > 0 ? queries : [question];
  } catch {
    return [question];
  }
}

// ─── Source gathering ───────────────────────────────────────────────

async function gatherSources(
  queries: string[],
  ctx: ResearchCtx,
): Promise<ResearchSource[]> {
  const byUrl = new Map<string, ResearchSource>();

  for (const q of queries) {
    if (ctx.signal.aborted) throw new Error("aborted");
    if (byUrl.size >= MAX_SOURCES) break;

    ctx.emit({ type: "status", label: `Searching: ${q}` });
    const results = await searchExa(q, { numResults: NUM_RESULTS_PER_QUERY });
    if (results.length === 0) continue; // fail-soft: skip empty query

    // Fetch fuller text for the top few URLs of this query; the search
    // snippet is the fallback when /contents returns nothing for a URL.
    const topUrls = results
      .slice(0, CONTENTS_TOP_N)
      .map((r) => r.url)
      .filter((u) => !byUrl.has(u));
    const contents =
      topUrls.length > 0
        ? await getExaContents(topUrls, { maxCharactersPerUrl: CONTENT_CHARS_PER_URL })
        : [];
    const textByUrl = new Map(contents.map((c) => [c.url, c.text]));

    let added = 0;
    for (const r of results) {
      if (byUrl.size >= MAX_SOURCES) break;
      if (byUrl.has(r.url)) continue;
      const fullText = textByUrl.get(r.url);
      const snippet = (fullText ?? r.snippet ?? "").slice(0, CONTENT_CHARS_PER_URL).trim();
      if (!snippet) continue;
      byUrl.set(r.url, {
        idx: byUrl.size + 1,
        title: r.title || r.url,
        url: r.url,
        snippet,
      });
      added++;
    }
    if (added > 0) {
      ctx.emit({ type: "status", label: `Read ${byUrl.size} sources` });
    }
  }

  return [...byUrl.values()];
}

// ─── Report synthesis (streamed) ────────────────────────────────────

interface StreamChunk {
  choices?: Array<{ delta?: { content?: string | null } }>;
}

// The OpenAI SDK's create() overloads fight structural message arrays under
// strict TS; bind a loosely-typed alias once (same pattern as doc.ts).
const createChatStream = openai.chat.completions.create.bind(
  openai.chat.completions,
) as unknown as (
  body: Record<string, unknown>,
  options?: Record<string, unknown>,
) => Promise<AsyncIterable<StreamChunk>>;

function buildReportSystem(hasSources: boolean): string {
  const parts = [
    "You are a meticulous research analyst. Write a well-structured research " +
      "report in GitHub-flavored Markdown that directly answers the user's question.",
    [
      "Rules:",
      "- Output ONLY the report markdown — no preamble, no commentary, no code fence wrapping the whole report.",
      "- Start with a single H1 title line (`# Title`).",
      "- Open with a short introduction framing the question, then organise the body into thematic `##` sections, and end with a `## Conclusion`.",
      "- Write tight, substantive prose; use lists and tables only where they genuinely help.",
      "- Do NOT write a Sources/References section yourself — it is appended automatically.",
    ].join("\n"),
  ];
  if (hasSources) {
    parts.push(
      [
        "Numbered source excerpts are provided below. Ground every factual claim in them.",
        "Cite sources inline as bracketed numbers matching the source list — e.g. [1], [2]. Place the citation immediately after the claim it supports; combine as [1][3] when multiple apply.",
        "Never invent a source number you were not given.",
      ].join("\n"),
    );
  } else {
    parts.push(
      "No external sources were retrievable. Answer from your own knowledge, and " +
        "add a short italic note near the top stating the report is based on the " +
        "model's own knowledge without live web sources.",
    );
  }
  return parts.join("\n\n");
}

function buildSourcesBlock(sources: ResearchSource[]): string {
  const parts = ["Numbered sources for citation:"];
  for (const s of sources) {
    parts.push(`[${s.idx}] ${s.title} — ${s.url}\n${s.snippet}`);
  }
  return parts.join("\n\n---\n\n");
}

async function streamReport(
  question: string,
  sources: ResearchSource[],
  ctx: ResearchCtx,
): Promise<string> {
  const system = buildReportSystem(sources.length > 0);
  const model = MODELS.default;

  const messages: Array<{ role: "system" | "user"; content: unknown }> = [
    { role: "system", content: wrapSystemForCache(system, model) },
  ];
  if (sources.length > 0) {
    messages.push({ role: "system", content: buildSourcesBlock(sources) });
  }
  messages.push({
    role: "user",
    content: `Research question: ${question}\n\nWrite the full research report now.`,
  });

  const stream = await createChatStream(
    {
      model,
      messages,
      stream: true,
      max_tokens: 4000,
      // Disable extended thinking; otherwise the report budget is spent on
      // reasoning tokens and the synthesis comes back empty after all the
      // (already-paid-for) search + fetch work.
      reasoning: { enabled: false },
      ...providerRoutingForCache(model),
    },
    { ...LLM_REQUEST_OPTS, signal: ctx.signal },
  );

  let markdown = "";
  for await (const chunk of stream) {
    if (ctx.signal.aborted) throw new Error("aborted");
    const delta = chunk.choices?.[0]?.delta?.content;
    if (typeof delta === "string" && delta.length > 0) {
      markdown += delta;
      ctx.emit({ type: "delta", channel: "markdown", data: delta });
    }
  }
  if (!markdown.trim()) throw new Error("The report came back empty");
  return markdown;
}

// ─── Title + sources footer ─────────────────────────────────────────

function extractTitle(markdown: string): string | null {
  for (const line of markdown.split("\n")) {
    const m = /^#\s+(.+)$/.exec(line.trim());
    if (m) {
      const title = m[1].replace(/\s*#+\s*$/, "").trim();
      if (title) return title;
    }
  }
  return null;
}

function titleFromQuestion(question: string): string {
  const flat = question.replace(/\s+/g, " ").trim();
  return flat.length > 80 ? `${flat.slice(0, 77)}...` : flat;
}

function appendSourcesSection(markdown: string, sources: ResearchSource[]): string {
  if (sources.length === 0) return markdown;
  const lines = ["", "## Sources", ""];
  for (const s of sources) {
    lines.push(`${s.idx}. [${s.title}](${s.url})`);
  }
  const body = markdown.trimEnd();
  return `${body}\n${lines.join("\n")}\n`;
}

// ─── Entry point ────────────────────────────────────────────────────

export async function runResearch(
  userId: string,
  question: string,
  ctx: ResearchCtx,
): Promise<ArtifactSummary> {
  if (ctx.signal.aborted) throw new Error("aborted");

  // (a) Plan focused sub-queries.
  ctx.emit({ type: "status", label: "Planning research" });
  const queries = await planQueries(question, ctx.signal);

  // (b) Search + read sources for each sub-query (fail-soft per query).
  const sources = await gatherSources(queries, ctx);
  if (sources.length === 0) {
    ctx.emit({
      type: "status",
      label: "No web sources found — using model knowledge",
    });
  }

  // (c) Synthesise the report, streaming markdown deltas.
  ctx.emit({ type: "status", label: "Writing the report" });
  const reportBody = await streamReport(question, sources, ctx);

  // Append the numbered Sources list (also streamed so the preview shows it).
  const sourcesFooter = sources.length > 0 ? appendSourcesSection("", sources) : "";
  if (sourcesFooter) {
    ctx.emit({ type: "delta", channel: "markdown", data: sourcesFooter });
  }
  const markdown = appendSourcesSection(reportBody, sources);

  // (d) Persist as a doc artifact.
  const title = extractTitle(reportBody) || titleFromQuestion(question);
  const content = {
    markdown,
    blocks: null,
    sources: sources.map((s) => ({
      idx: s.idx,
      label: s.title,
      file_id: null as string | null,
      snippet: s.snippet.slice(0, 240),
    })),
  };
  const row = insertArtifact({
    userId,
    kind: "doc",
    title,
    content,
    meta: { subtype: "research", question, source_count: sources.length },
  });
  return toArtifactSummary(row);
}
