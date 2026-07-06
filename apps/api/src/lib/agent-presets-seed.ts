// Curated built-in agent presets — the "Community" set users browse in the
// Custom Agents store (/agents). Each is a ready-made Super-Agent preset: a
// goal_template (with an optional {{input}} placeholder the launch route
// substitutes) plus a sensible default budget. Stable ids like
// 'builtin:deep-research' let seedAgentPresets() INSERT OR IGNORE idempotently
// on every boot. Publishers are spread across Omni / Anthropic / OpenAI. All
// rows belong to the single local user (env.LOCAL_USER_ID) but are marked
// is_builtin=1 so they surface under Community rather than "My Own".

import { run as dbRun } from "@omni/sdk";
import { env } from "@omni/env-config";

export type PresetCategory =
  | "Research"
  | "Business"
  | "Content"
  | "Personal"
  | "Ops";

export interface SeedAgentPreset {
  id: string;
  name: string;
  description: string;
  publisher: "Omni" | "Anthropic" | "OpenAI";
  category: PresetCategory;
  /** A lucide icon name string used to render the card badge. */
  icon: string;
  /** Gradient utility classes used to tint the card badge. */
  accent: string;
  /** The agent goal; may contain a single {{input}} placeholder. */
  goal_template: string;
  budget_usd: number;
}

export const SEED_AGENT_PRESETS: SeedAgentPreset[] = [
  // ── Research ───────────────────────────────────────────────────────────
  {
    id: "builtin:deep-research",
    name: "Deep research & report",
    description:
      "Researches any topic thoroughly with web search across multiple sources and writes a well-structured, cited report.",
    publisher: "Anthropic",
    category: "Research",
    icon: "Telescope",
    accent: "from-accent to-accent2",
    goal_template:
      "Research {{input}} thoroughly using web search. Consult multiple independent, credible sources, cross-check the key facts, and then write a well-structured report with an executive summary, the main findings organized into sections, and a list of the sources you used. Cite sources inline where claims come from them.",
    budget_usd: 2.5,
  },
  {
    id: "builtin:company-dossier",
    name: "Company dossier",
    description:
      "Builds a full profile of a company: what they do, funding, leadership, products, recent news, and risks.",
    publisher: "Omni",
    category: "Research",
    icon: "Building2",
    accent: "from-sky-500 to-accent",
    goal_template:
      "Build a detailed company dossier on {{input}}. Use web search to gather: what the company does and its core products, founding date and headquarters, funding history and investors, key leadership, business model and rough scale, notable customers or partners, recent news from the last 12 months, and any risks or controversies. Write it up as a clean one-page briefing with sources.",
    budget_usd: 2.0,
  },
  {
    id: "builtin:weekly-market-brief",
    name: "Weekly market brief",
    description:
      "Scans the web for the latest developments in a market or topic and writes a dated, skimmable brief.",
    publisher: "OpenAI",
    category: "Research",
    icon: "Newspaper",
    accent: "from-indigo-500 to-accent",
    goal_template:
      "Write a weekly market brief on {{input}}. Search the web for the most recent developments, announcements, funding rounds, product launches, and notable commentary from roughly the past week. Summarize the 5-8 most important items as short, skimmable bullets, each with a one-line 'why it matters', and finish with a short 'what to watch next' section. Include source links.",
    budget_usd: 1.5,
  },

  // ── Business ───────────────────────────────────────────────────────────
  {
    id: "builtin:competitor-teardown",
    name: "Competitor teardown",
    description:
      "A structured teardown of a competitor: positioning, pricing, strengths, gaps, and how to counter them.",
    publisher: "Anthropic",
    category: "Business",
    icon: "Swords",
    accent: "from-rose-500 to-accent2",
    goal_template:
      "Do a competitor teardown of {{input}}. Use web search to investigate their positioning and target customer, pricing and packaging, headline features, notable strengths, weaknesses and gaps, and recent moves. Then write a structured teardown with a one-line positioning summary, a strengths/weaknesses table, and 3 concrete recommendations for how a competitor should respond. Cite what you found.",
    budget_usd: 2.0,
  },
  {
    id: "builtin:lead-gen-list",
    name: "Lead-gen list builder",
    description:
      "Finds and profiles a list of prospect companies matching your criteria, ready to import as a sheet.",
    publisher: "Omni",
    category: "Business",
    icon: "Users",
    accent: "from-emerald-500 to-teal-400",
    goal_template:
      "Build a lead-generation list for this target profile: {{input}}. Use web search to find 15-20 companies that match, and for each capture: company name, what they do, approximate size, location, website, a relevant contact role to target, and a one-line reason they're a good fit. Produce the result as a spreadsheet ordered by fit, and note where any field is an estimate.",
    budget_usd: 2.5,
  },
  {
    id: "builtin:investor-brief",
    name: "Investment brief",
    description:
      "Researches a company or asset and produces a balanced bull/bear investment brief with sources.",
    publisher: "OpenAI",
    category: "Business",
    icon: "TrendingUp",
    accent: "from-amber-500 to-orange-400",
    goal_template:
      "Produce a balanced investment brief on {{input}}. Research the fundamentals, market position, recent performance and news using web search. Write it up with: a snapshot, the bull case, the bear case, key risks, and an even-handed takeaway. Be explicit that this is not financial advice and cite your sources.",
    budget_usd: 2.0,
  },

  // ── Content ────────────────────────────────────────────────────────────
  {
    id: "builtin:content-repurposer",
    name: "Content repurposer",
    description:
      "Takes a source piece or topic and spins it into a blog post, an X thread, a LinkedIn post, and an email.",
    publisher: "Omni",
    category: "Content",
    icon: "Recycle",
    accent: "from-fuchsia-500 to-accent2",
    goal_template:
      "Repurpose this into a multi-channel content pack: {{input}}. If it's a URL, read the page first; otherwise research the topic with web search. Then produce: a 250-word blog post, an X/Twitter thread of 5 posts, a LinkedIn post, and a short promotional email (subject + body). Keep the core message consistent, adapt tone and length per channel, and end each with a clear call to action.",
    budget_usd: 1.5,
  },
  {
    id: "builtin:seo-article",
    name: "SEO article writer",
    description:
      "Researches a keyword topic and writes a complete, search-optimized long-form article with sources.",
    publisher: "OpenAI",
    category: "Content",
    icon: "PenLine",
    accent: "from-violet-500 to-accent",
    goal_template:
      "Write a complete, SEO-optimized long-form article on {{input}}. Research the topic and what currently ranks using web search, identify the primary and secondary keywords and the search intent, then write a 1,000-1,400 word article with a compelling title, a clear H2/H3 structure, a short FAQ section, and a meta description. Keep it genuinely useful and cite any facts or statistics.",
    budget_usd: 2.0,
  },

  // ── Personal ───────────────────────────────────────────────────────────
  {
    id: "builtin:trip-planner",
    name: "Trip planner",
    description:
      "Researches a destination and builds a day-by-day itinerary with activities, food, and logistics.",
    publisher: "Omni",
    category: "Personal",
    icon: "Plane",
    accent: "from-cyan-500 to-sky-400",
    goal_template:
      "Plan a trip based on this: {{input}}. Use web search to research the destination and build a practical day-by-day itinerary covering top sights and activities, suggested restaurants, neighborhoods to stay in, getting-around logistics, rough budget guidance, and a few insider tips. Note the best time to visit and any bookings worth making ahead. Include source links for key recommendations.",
    budget_usd: 1.5,
  },
  {
    id: "builtin:buying-guide",
    name: "Buying decision guide",
    description:
      "Researches options for a purchase and produces a shortlist with a clear recommendation and reasoning.",
    publisher: "Anthropic",
    category: "Personal",
    icon: "ShoppingCart",
    accent: "from-lime-500 to-emerald-400",
    goal_template:
      "Help me make a buying decision on {{input}}. Use web search to research the leading options, comparing them on price, key features, pros and cons, and reviewer consensus. Produce a comparison table of the top 4-5 options, a clear top pick with the reasoning, and a runner-up for a different budget or use case. Cite the sources behind the recommendations.",
    budget_usd: 1.5,
  },

  // ── Ops ────────────────────────────────────────────────────────────────
  {
    id: "builtin:meeting-prep",
    name: "Meeting prep brief",
    description:
      "Researches the people and company you're meeting and produces a one-page pre-meeting brief.",
    publisher: "Omni",
    category: "Ops",
    icon: "CalendarCheck",
    accent: "from-teal-500 to-accent",
    goal_template:
      "Prepare a one-page meeting brief for this upcoming meeting: {{input}}. Use web search to research the company and the people involved. Cover: a company snapshot, recent relevant news, background on the attendees, the likely goals on both sides, smart questions to ask, and possible objections with suggested responses. Keep it to a single skimmable page and cite your sources.",
    budget_usd: 1.5,
  },
];

/**
 * Idempotently seed the curated built-in agent presets for the local user.
 * Uses INSERT OR IGNORE keyed on the stable string ids, so it is safe to call
 * on every boot. Built-in content is refreshed for existing rows via a
 * lightweight UPDATE so edits to this file propagate without a migration
 * (only touches builtin rows; never clobbers user-authored presets).
 */
export function seedAgentPresets(): void {
  const userId = env.LOCAL_USER_ID;
  for (const p of SEED_AGENT_PRESETS) {
    dbRun(
      `INSERT OR IGNORE INTO agent_presets
         (id, user_id, name, description, category, icon, accent,
          goal_template, budget_usd, publisher, is_builtin)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      p.id,
      userId,
      p.name,
      p.description,
      p.category,
      p.icon,
      p.accent,
      p.goal_template,
      p.budget_usd,
      p.publisher,
    );
    dbRun(
      `UPDATE agent_presets
          SET name = ?, description = ?, category = ?, icon = ?, accent = ?,
              goal_template = ?, budget_usd = ?, publisher = ?,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ? AND is_builtin = 1`,
      p.name,
      p.description,
      p.category,
      p.icon,
      p.accent,
      p.goal_template,
      p.budget_usd,
      p.publisher,
      p.id,
    );
  }
}
