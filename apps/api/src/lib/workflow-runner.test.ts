import { describe, expect, it } from "vitest";
import {
  AgentTaskConfigSchema,
  GenerateConfigSchema,
  ReadUrlConfigSchema,
  SearchConfigSchema,
  applyTemplate,
  outputText,
  previousFromUpstream,
  templateStringValues,
  topologicalOrder,
  upstreamOf,
  validateGraph,
  type WorkflowGraph,
  type WorkflowNode,
} from "./workflow-runner.js";

function node(id: string, type: WorkflowNode["type"] = "search", config: Record<string, unknown> = { query: "q" }): WorkflowNode {
  return { id, type, config };
}

describe("topologicalOrder", () => {
  it("orders a linear chain", () => {
    const graph: WorkflowGraph = {
      nodes: [node("a"), node("b"), node("c")],
      edges: [
        { from: "a", to: "b" },
        { from: "b", to: "c" },
      ],
    };
    expect(topologicalOrder(graph)).toEqual(["a", "b", "c"]);
  });

  it("orders a diamond with both branches before the join", () => {
    const graph: WorkflowGraph = {
      nodes: [node("a"), node("b"), node("c"), node("d")],
      edges: [
        { from: "a", to: "b" },
        { from: "a", to: "c" },
        { from: "b", to: "d" },
        { from: "c", to: "d" },
      ],
    };
    const order = topologicalOrder(graph);
    expect(order.indexOf("a")).toBe(0);
    expect(order.indexOf("d")).toBe(3);
    expect(order.indexOf("b")).toBeLessThan(order.indexOf("d"));
    expect(order.indexOf("c")).toBeLessThan(order.indexOf("d"));
  });

  it("keeps disconnected nodes and ignores duplicate edges", () => {
    const graph: WorkflowGraph = {
      nodes: [node("a"), node("b"), node("lonely")],
      edges: [
        { from: "a", to: "b" },
        { from: "a", to: "b" },
      ],
    };
    expect(topologicalOrder(graph).sort()).toEqual(["a", "b", "lonely"]);
  });

  it("throws on a cycle", () => {
    const graph: WorkflowGraph = {
      nodes: [node("a"), node("b")],
      edges: [
        { from: "a", to: "b" },
        { from: "b", to: "a" },
      ],
    };
    expect(() => topologicalOrder(graph)).toThrow(/cycle/i);
  });
});

describe("upstreamOf", () => {
  it("returns direct parents, deduped, in edge order", () => {
    const graph: WorkflowGraph = {
      nodes: [node("a"), node("b"), node("c")],
      edges: [
        { from: "a", to: "c" },
        { from: "b", to: "c" },
        { from: "a", to: "c" },
      ],
    };
    expect(upstreamOf(graph, "c")).toEqual(["a", "b"]);
    expect(upstreamOf(graph, "a")).toEqual([]);
  });
});

describe("applyTemplate", () => {
  it("substitutes {{previous}} and {{input}}", () => {
    expect(applyTemplate("Summarize: {{previous}} for {{input}}", { previous: "TEXT", input: "me" })).toBe(
      "Summarize: TEXT for me",
    );
  });

  it("tolerates whitespace inside the braces and repeats", () => {
    expect(applyTemplate("{{ previous }} + {{previous}}", { previous: "x" })).toBe("x + x");
  });

  it("replaces missing vars with empty strings", () => {
    expect(applyTemplate("a{{previous}}b{{input}}c", {})).toBe("abc");
  });

  it("leaves unknown tokens alone", () => {
    expect(applyTemplate("{{other}}", { previous: "x" })).toBe("{{other}}");
  });
});

describe("templateStringValues", () => {
  it("templates only top-level string values", () => {
    const out = templateStringValues(
      { prompt: "Use {{previous}}", n: 3, nested: { keep: "{{previous}}" } },
      { previous: "P" },
    );
    expect(out.prompt).toBe("Use P");
    expect(out.n).toBe(3);
    expect((out.nested as { keep: string }).keep).toBe("{{previous}}");
  });
});

describe("previous text assembly", () => {
  it("prefers text, then preview, then title", () => {
    expect(outputText({ preview: "p", text: "t" })).toBe("t");
    expect(outputText({ preview: "p" })).toBe("p");
    expect(outputText({ preview: "", title: "T" })).toBe("");
    expect(outputText(null)).toBe("");
  });

  it("joins multiple upstream outputs with two newlines", () => {
    expect(
      previousFromUpstream([{ preview: "a", text: "A" }, undefined, { preview: "B" }]),
    ).toBe("A\n\nB");
  });
});

describe("node config schemas", () => {
  it("agent_task applies defaults and bounds", () => {
    const parsed = AgentTaskConfigSchema.parse({ goal: "do it" });
    expect(parsed.budget_usd).toBe(0.5);
    expect(parsed.max_iterations).toBe(15);
    expect(AgentTaskConfigSchema.safeParse({ goal: "" }).success).toBe(false);
    expect(AgentTaskConfigSchema.safeParse({ goal: "x", budget_usd: -1 }).success).toBe(false);
    expect(AgentTaskConfigSchema.safeParse({ goal: "x", max_iterations: 3.5 }).success).toBe(false);
  });

  it("generate requires a generator name and defaults input to {}", () => {
    const parsed = GenerateConfigSchema.parse({ generator: "doc" });
    expect(parsed.input).toEqual({});
    expect(GenerateConfigSchema.safeParse({ input: {} }).success).toBe(false);
  });

  it("search defaults num_results to 6 and caps at 8", () => {
    expect(SearchConfigSchema.parse({ query: "q" }).num_results).toBe(6);
    expect(SearchConfigSchema.safeParse({ query: "q", num_results: 9 }).success).toBe(false);
    expect(SearchConfigSchema.safeParse({ query: "" }).success).toBe(false);
  });

  it("read_url requires a url", () => {
    expect(ReadUrlConfigSchema.safeParse({}).success).toBe(false);
    expect(ReadUrlConfigSchema.safeParse({ url: "https://example.com" }).success).toBe(true);
  });
});

describe("validateGraph", () => {
  it("accepts a valid chain", () => {
    const res = validateGraph({
      nodes: [
        { id: "a", type: "search", config: { query: "news" } },
        { id: "b", type: "agent_task", config: { goal: "summarize {{previous}}" } },
      ],
      edges: [{ from: "a", to: "b" }],
    });
    expect("graph" in res && res.graph.nodes).toHaveLength(2);
  });

  it("rejects duplicate node ids", () => {
    const res = validateGraph({
      nodes: [node("a"), node("a")],
      edges: [],
    });
    expect("error" in res && res.error).toMatch(/duplicate/i);
  });

  it("rejects a bad per-type config", () => {
    const res = validateGraph({
      nodes: [{ id: "a", type: "read_url", config: {} }],
      edges: [],
    });
    expect("error" in res && res.error).toMatch(/read_url/);
  });

  it("rejects edges to missing nodes and self-edges", () => {
    expect(
      "error" in
        validateGraph({ nodes: [node("a")], edges: [{ from: "a", to: "ghost" }] }),
    ).toBe(true);
    expect(
      "error" in validateGraph({ nodes: [node("a")], edges: [{ from: "a", to: "a" }] }),
    ).toBe(true);
  });

  it("rejects an unknown node type", () => {
    const res = validateGraph({
      nodes: [{ id: "a", type: "explode", config: {} }],
      edges: [],
    });
    expect("error" in res).toBe(true);
  });
});
