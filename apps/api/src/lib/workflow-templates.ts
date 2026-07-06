// Curated workflow templates for the "Start from a template" gallery
// (frontend WorkflowsPage). Each template is a ready-to-run LINEAR chain in
// the exact {nodes, edges} shape the runner validates (see workflow-runner.ts
// validateGraph + the per-type config schemas). Cloning a template copies its
// graph into a fresh, DISABLED workflow row the user then reviews in the
// editor — so node configs here must satisfy the same zod schemas as any
// hand-built or LLM-generated graph.
//
// Kept intentionally static (no DB table): these are product content, not
// user data, so they ship in code and evolve with deploys.

import type { WorkflowGraph } from "./workflow-runner.js";

export interface WorkflowTemplate {
  id: string;
  name: string;
  description: string;
  category: string;
  graph: WorkflowGraph;
}

// Linear chain helper: edge each node to the next in order.
function chain(nodes: WorkflowGraph["nodes"]): WorkflowGraph {
  return {
    nodes,
    edges: nodes.slice(1).map((n, i) => ({ from: nodes[i].id, to: n.id })),
  };
}

export const WORKFLOW_TEMPLATES: WorkflowTemplate[] = [
  {
    id: "daily-news-brief",
    name: "Daily news brief",
    description: "Search the day's headlines on a topic and write a tidy briefing you can read over coffee.",
    category: "News",
    graph: chain([
      {
        id: "n1",
        type: "search",
        config: { query: "latest news and developments about {{input}} today", num_results: 6 },
      },
      {
        id: "n2",
        type: "generate",
        config: {
          generator: "doc",
          input: {
            prompt:
              "Write a concise daily news brief from the search results below. Group by theme, lead with the most important story, and end each item with its source link.\n\n{{previous}}",
          },
        },
      },
    ]),
  },
  {
    id: "competitor-watch",
    name: "Competitor watch",
    description: "Track what a competitor is up to and get a short intelligence memo on their latest moves.",
    category: "Research",
    graph: chain([
      {
        id: "n1",
        type: "search",
        config: { query: "{{input}} product launch pricing news announcements", num_results: 6 },
      },
      {
        id: "n2",
        type: "generate",
        config: {
          generator: "doc",
          input: {
            prompt:
              "Write a competitor-intelligence memo from the findings below. Cover new launches, pricing/positioning changes, notable hires or funding, and what it means for us.\n\n{{previous}}",
          },
        },
      },
    ]),
  },
  {
    id: "weekly-report",
    name: "Weekly report",
    description: "Let an agent gather the week's progress and turn it into a polished status report.",
    category: "Reports",
    graph: chain([
      {
        id: "n1",
        type: "agent_task",
        config: {
          goal: "Research the most important updates, decisions, shipped work, and metrics from the past week and compile the key developments with brief context.",
        },
      },
      {
        id: "n2",
        type: "generate",
        config: {
          generator: "doc",
          input: {
            prompt:
              "Write a polished weekly status report from these findings. Use sections: Highlights, In progress, Metrics, and Next week.\n\n{{previous}}",
          },
        },
      },
    ]),
  },
  {
    id: "blog-from-url",
    name: "Blog from a URL",
    description: "Read any article and spin it into an original, well-structured blog post.",
    category: "Content",
    graph: chain([
      {
        id: "n1",
        type: "read_url",
        config: { url: "https://example.com/article" },
      },
      {
        id: "n2",
        type: "generate",
        config: {
          generator: "doc",
          input: {
            prompt:
              "Using the source article below as reference, write an original, engaging blog post in your own words with a strong hook, clear subheadings, and a takeaway. Do not copy sentences verbatim.\n\n{{previous}}",
          },
        },
      },
    ]),
  },
  {
    id: "topic-deck",
    name: "Topic deck",
    description: "Research a topic and generate a presentation-ready slide deck about it.",
    category: "Presentations",
    graph: chain([
      {
        id: "n1",
        type: "search",
        config: { query: "{{input}} overview key facts trends and outlook", num_results: 6 },
      },
      {
        id: "n2",
        type: "generate",
        config: {
          generator: "slides",
          input: {
            prompt:
              "Create a clear, well-organized slide deck that explains this topic to a general business audience, grounded in the research below.\n\n{{previous}}",
          },
        },
      },
    ]),
  },
  {
    id: "lead-list",
    name: "Lead list",
    description: "Find companies matching a profile and organize them into a structured spreadsheet.",
    category: "Sales",
    graph: chain([
      {
        id: "n1",
        type: "search",
        config: { query: "companies and vendors in {{input}} with website and location", num_results: 8 },
      },
      {
        id: "n2",
        type: "generate",
        config: {
          generator: "sheet",
          input: {
            prompt:
              "Build a spreadsheet of leads from the results below. Columns: Company, Website, What they do, Location, and a Notes column with why they fit.\n\n{{previous}}",
          },
        },
      },
    ]),
  },
  {
    id: "market-deep-dive",
    name: "Market deep-dive",
    description: "Search, have an agent analyze the landscape, and produce a full market-analysis report.",
    category: "Research",
    graph: chain([
      {
        id: "n1",
        type: "search",
        config: { query: "{{input}} market size key players trends and outlook", num_results: 8 },
      },
      {
        id: "n2",
        type: "agent_task",
        config: {
          goal: "Analyze the market research below and produce a structured analysis covering market size, segments, key players, trends, risks, and outlook.\n\n{{previous}}",
        },
      },
      {
        id: "n3",
        type: "generate",
        config: {
          generator: "doc",
          input: {
            prompt: "Turn this analysis into a clean, executive-ready market report.\n\n{{previous}}",
          },
        },
      },
    ]),
  },
  {
    id: "trend-visual",
    name: "Trend visual",
    description: "Research a trend and generate an infographic-style illustration that captures it.",
    category: "Creative",
    graph: chain([
      {
        id: "n1",
        type: "search",
        config: { query: "{{input}} latest trends and notable statistics", num_results: 6 },
      },
      {
        id: "n2",
        type: "generate",
        config: {
          generator: "image",
          input: {
            prompt:
              "Create a clean, modern infographic-style illustration that visually summarizes the key trend and statistics described below.\n\n{{previous}}",
          },
        },
      },
    ]),
  },
];

export function getWorkflowTemplate(id: string): WorkflowTemplate | undefined {
  return WORKFLOW_TEMPLATES.find((t) => t.id === id);
}
