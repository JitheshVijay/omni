// Curated built-in Skills — the "Community" set users browse on /skills.
// Each carries a genuinely useful prompt_template (with an optional {{input}}
// placeholder the run route substitutes) and a stable id so seedBuiltinSkills()
// can INSERT OR IGNORE idempotently on every boot. Publishers are spread
// across Omni / Anthropic / OpenAI. All rows belong to the single local user
// (env.LOCAL_USER_ID) but are marked is_builtin=1 so they surface under
// Community rather than "My Own".

import { run as dbRun } from "@omni/sdk";
import { env } from "@omni/env-config";

export type SkillRole =
  | "Sales"
  | "Marketer"
  | "Product"
  | "Researcher"
  | "Designer"
  | "Engineer"
  | "Founder"
  | "General";

export type SkillOutput = "doc" | "slides" | "sheet" | "image" | "chat" | "data";

export interface SeedSkill {
  id: string;
  name: string;
  description: string;
  publisher: "Omni" | "Anthropic" | "OpenAI";
  role: SkillRole;
  output: SkillOutput;
  /** A registered generator name, or 'chat'. */
  target: string;
  prompt_template: string;
  /** Gradient utility classes used to tint the card preview. */
  accent: string;
}

// Card tint per output — matches the generator colours used across the app so
// the library reads as one system with /tools.
export const OUTPUT_ACCENT: Record<SkillOutput, string> = {
  doc: "from-accent to-accent2",
  slides: "from-sky-500 to-accent",
  sheet: "from-emerald-500 to-teal-400",
  image: "from-fuchsia-500 to-accent2",
  chat: "from-indigo-500 to-accent",
  data: "from-amber-500 to-orange-400",
};

export const SEED_SKILLS: SeedSkill[] = [
  // ── Sales ─────────────────────────────────────────────────────────────
  {
    id: "builtin:daily-call-list",
    name: "Build a daily sales call list",
    description:
      "Turn a target segment into a prioritized call sheet with reason-to-call and a one-line opener for each account.",
    publisher: "Omni",
    role: "Sales",
    output: "sheet",
    target: "sheet",
    prompt_template:
      "Build a prioritized daily sales call list as a spreadsheet for this target segment: {{input}}.\n" +
      "Columns: Priority (1-3), Company, Contact name & title, Phone/Email, Reason to call (a trigger event or signal), One-line opener, Best time to call, Next step.\n" +
      "Generate 15-20 realistic-looking rows ordered by priority. Keep openers specific and non-generic.",
    accent: OUTPUT_ACCENT.sheet,
  },
  {
    id: "builtin:cold-email-sequence",
    name: "Cold email sequence (5 touches)",
    description:
      "Draft a 5-email cold outbound sequence with varied angles, tight subject lines, and clear CTAs.",
    publisher: "OpenAI",
    role: "Sales",
    output: "doc",
    target: "doc",
    prompt_template:
      "Write a 5-touch cold email sequence selling this offer to this audience: {{input}}.\n" +
      "For each email give: send-day (Day 1, 3, 7, 12, 18), subject line (<45 chars), preview text, body (<120 words, one idea, one CTA), and the angle it takes (pain, social proof, insight, breakup, etc.).\n" +
      "Vary the angle every email, keep it human, avoid corporate filler, and make CTAs easy to say yes to.",
    accent: OUTPUT_ACCENT.doc,
  },
  {
    id: "builtin:discovery-call-prep",
    name: "Discovery call prep brief",
    description:
      "A one-page pre-call brief: company snapshot, likely pains, tailored questions, and objection handling.",
    publisher: "Omni",
    role: "Sales",
    output: "doc",
    target: "doc",
    prompt_template:
      "Create a one-page discovery-call prep brief for this prospect: {{input}}.\n" +
      "Sections: Company snapshot (what they do, size, recent news), Likely pains we can address, 6 open-ended discovery questions tailored to them, 3 likely objections with crisp responses, and a suggested next step to propose.",
    accent: OUTPUT_ACCENT.doc,
  },

  // ── Marketer ─────────────────────────────────────────────────────────
  {
    id: "builtin:seo-blog-outline",
    name: "SEO blog outline",
    description:
      "A search-intent-driven outline: H2/H3 structure, target keywords, FAQs, and a suggested meta description.",
    publisher: "OpenAI",
    role: "Marketer",
    output: "doc",
    target: "doc",
    prompt_template:
      "Create an SEO-optimized blog post outline for the topic: {{input}}.\n" +
      "Include: the primary keyword and 5-8 secondary keywords, a working title with 3 alternates, the search intent, a full H2/H3 heading structure with a sentence describing each section, a People-Also-Ask FAQ block (5 questions), an internal-link idea list, and a 155-char meta description.",
    accent: OUTPUT_ACCENT.doc,
  },
  {
    id: "builtin:launch-announcement",
    name: "Product launch announcement",
    description:
      "A ready-to-ship launch post plus matching social copy for X, LinkedIn, and email.",
    publisher: "Omni",
    role: "Marketer",
    output: "doc",
    target: "doc",
    prompt_template:
      "Write a product launch announcement for: {{input}}.\n" +
      "Deliver: a 200-word blog/announcement post, an X/Twitter thread (5 posts), a LinkedIn post, and a short launch email (subject + 120-word body). Lead with the customer benefit, keep the tone confident but not hypey, and end each with a clear CTA.",
    accent: OUTPUT_ACCENT.doc,
  },
  {
    id: "builtin:content-calendar",
    name: "30-day content calendar",
    description:
      "A month of channel-mapped content ideas with formats, hooks, and CTAs in a ready-to-edit sheet.",
    publisher: "OpenAI",
    role: "Marketer",
    output: "sheet",
    target: "sheet",
    prompt_template:
      "Build a 30-day content calendar as a spreadsheet for this brand/topic: {{input}}.\n" +
      "Columns: Day, Channel (X, LinkedIn, Blog, Email, Instagram), Format, Working title/hook, Key message, CTA, Status. Balance the channels across the month and mix educational, social-proof, and promotional posts (roughly 60/20/20).",
    accent: OUTPUT_ACCENT.sheet,
  },
  {
    id: "builtin:brand-voice-guide",
    name: "Brand voice & messaging guide",
    description:
      "Codify voice, tone pillars, do/don't examples, and boilerplate from a short brand description.",
    publisher: "Anthropic",
    role: "Marketer",
    output: "doc",
    target: "doc",
    prompt_template:
      "Create a brand voice & messaging guide for: {{input}}.\n" +
      "Include: a one-line positioning statement, 3-4 voice pillars (each with a description and a do/don't example pair), tone shifts by context (sales vs support vs social), 5 approved taglines, and short/medium/long boilerplate blurbs.",
    accent: OUTPUT_ACCENT.doc,
  },

  // ── Product ──────────────────────────────────────────────────────────
  {
    id: "builtin:prd-draft",
    name: "One-page PRD draft",
    description:
      "Turn a feature idea into a crisp PRD: problem, goals, user stories, scope, and success metrics.",
    publisher: "Anthropic",
    role: "Product",
    output: "doc",
    target: "doc",
    prompt_template:
      "Write a one-page PRD for this feature idea: {{input}}.\n" +
      "Sections: Problem & context, Goals and non-goals, Target user & top user stories (As a… I want… so that…), Proposed solution overview, Scope for v1 vs later, Success metrics, Open questions and risks. Be concrete and opinionated.",
    accent: OUTPUT_ACCENT.doc,
  },
  {
    id: "builtin:okr-tracker",
    name: "OKR tracker",
    description:
      "A quarter of objectives and measurable key results with baselines, targets, and progress columns.",
    publisher: "Omni",
    role: "Product",
    output: "sheet",
    target: "sheet",
    prompt_template:
      "Build an OKR tracker spreadsheet for this team/quarter goal: {{input}}.\n" +
      "Structure: 3-4 Objectives, each with 3 measurable Key Results. Columns: Objective, Key Result, Owner, Baseline, Target, Current, Progress %, Confidence (R/Y/G). Make the key results quantitative and outcome-focused, not task lists.",
    accent: OUTPUT_ACCENT.sheet,
  },
  {
    id: "builtin:user-interview-guide",
    name: "User interview guide",
    description:
      "A non-leading discovery script: warm-up, jobs-to-be-done probes, and wrap-up, tuned to your goal.",
    publisher: "Anthropic",
    role: "Product",
    output: "doc",
    target: "doc",
    prompt_template:
      "Create a user interview guide to learn about: {{input}}.\n" +
      "Include: the research goal, a warm-up section, 8-10 open, non-leading questions organized around jobs-to-be-done and current workarounds, follow-up probes for each, things to avoid asking, and a wrap-up. Keep questions about past behavior, not hypotheticals.",
    accent: OUTPUT_ACCENT.doc,
  },

  // ── Researcher ───────────────────────────────────────────────────────
  {
    id: "builtin:competitor-brief",
    name: "Weekly competitor brief",
    description:
      "A structured teardown of a competitor: positioning, pricing, strengths, gaps, and what to counter.",
    publisher: "Anthropic",
    role: "Researcher",
    output: "doc",
    target: "doc",
    prompt_template:
      "Write a weekly competitor brief on: {{input}}.\n" +
      "Sections: One-line positioning, Target customer, Pricing & packaging (best guess), Notable strengths, Weaknesses/gaps we can exploit, Recent moves worth noting, and 3 recommended responses for our team. Be specific and cite what would need verification.",
    accent: OUTPUT_ACCENT.doc,
  },
  {
    id: "builtin:literature-summary",
    name: "Summarize a research topic",
    description:
      "A structured briefing on any topic: key concepts, competing views, open questions, and further reading.",
    publisher: "Anthropic",
    role: "Researcher",
    output: "doc",
    target: "doc",
    prompt_template:
      "Write a structured research briefing on: {{input}}.\n" +
      "Sections: TL;DR (5 bullets), Key concepts & definitions, The main schools of thought / competing views, What's well-established vs contested, Open questions, and Suggested directions for deeper reading. Flag where claims would need a primary source.",
    accent: OUTPUT_ACCENT.doc,
  },
  {
    id: "builtin:survey-designer",
    name: "Survey questionnaire designer",
    description:
      "A balanced questionnaire with the right scales and screening logic for your research goal.",
    publisher: "OpenAI",
    role: "Researcher",
    output: "doc",
    target: "doc",
    prompt_template:
      "Design a survey questionnaire to answer this research question: {{input}}.\n" +
      "Include: the objective, a screening question, 10-14 questions with appropriate types (single-select, multi-select, Likert 1-5, open text), sensible answer options, a logical section order, and notes on avoiding leading or double-barreled questions.",
    accent: OUTPUT_ACCENT.doc,
  },

  // ── Designer ─────────────────────────────────────────────────────────
  {
    id: "builtin:headshot-portrait",
    name: "Headshot portrait prompt",
    description:
      "Generate a clean, professional headshot from a short subject and style description.",
    publisher: "OpenAI",
    role: "Designer",
    output: "image",
    target: "image",
    prompt_template:
      "Professional studio headshot portrait of {{input}}. Soft key light with a subtle rim light, shallow depth of field, neutral seamless background, natural skin tones, sharp focus on the eyes, shot on an 85mm lens at f/2. Confident, approachable expression. Photorealistic, high detail, color-graded, magazine quality.",
    accent: OUTPUT_ACCENT.image,
  },
  {
    id: "builtin:app-icon",
    name: "App icon concept",
    description:
      "A modern, flat app-icon concept from a one-line description of your product.",
    publisher: "Omni",
    role: "Designer",
    output: "image",
    target: "image",
    prompt_template:
      "A modern flat mobile app icon for {{input}}. Bold simple central symbol, rounded-square canvas, vibrant gradient background, clean geometric shapes, subtle depth and soft shadow, no text, centered composition, crisp vector style, high contrast, App Store quality.",
    accent: OUTPUT_ACCENT.image,
  },
  {
    id: "builtin:hero-illustration",
    name: "Landing-page hero illustration",
    description:
      "A polished, on-brand hero image concept for a website landing page.",
    publisher: "Omni",
    role: "Designer",
    output: "image",
    target: "image",
    prompt_template:
      "A polished landing-page hero illustration for {{input}}. Modern tech-brand aesthetic, abstract geometric composition with soft gradients, generous negative space for headline text on the left, cohesive accent palette (deep indigo and electric violet), subtle grain, clean and premium, wide 16:9 framing.",
    accent: OUTPUT_ACCENT.image,
  },

  // ── Engineer ─────────────────────────────────────────────────────────
  {
    id: "builtin:code-reviewer",
    name: "Pragmatic code reviewer",
    description:
      "Paste a diff or snippet and get a focused review: bugs first, then clarity and simplifications.",
    publisher: "Anthropic",
    role: "Engineer",
    output: "chat",
    target: "chat",
    prompt_template:
      "Review this code as a pragmatic senior engineer. Report correctness bugs first (with the exact failing scenario), then clarity/simplification and efficiency suggestions. Be concrete, cite line context, and skip nitpicks that don't matter.\n\n{{input}}",
    accent: OUTPUT_ACCENT.chat,
  },
  {
    id: "builtin:rca-writeup",
    name: "Incident post-mortem",
    description:
      "Turn an incident summary into a blameless post-mortem: timeline, root cause, and action items.",
    publisher: "Omni",
    role: "Engineer",
    output: "doc",
    target: "doc",
    prompt_template:
      "Write a blameless incident post-mortem for: {{input}}.\n" +
      "Sections: Summary & impact, Timeline (detection → mitigation → resolution), Root cause (with contributing factors), What went well, What went wrong, and Action items (each with an owner and a category: prevent / detect / mitigate). Keep it blameless and factual.",
    accent: OUTPUT_ACCENT.doc,
  },
  {
    id: "builtin:regex-explainer",
    name: "Explain & build a regex",
    description:
      "Describe what you want to match and get a tested regex with a plain-English breakdown.",
    publisher: "OpenAI",
    role: "Engineer",
    output: "chat",
    target: "chat",
    prompt_template:
      "I need a regular expression for the following: {{input}}.\n" +
      "Provide the regex, a token-by-token plain-English explanation, 3 strings it should match and 3 it should not, and any edge cases or flavor differences (JS vs PCRE) I should watch for.",
    accent: OUTPUT_ACCENT.chat,
  },

  // ── Founder ──────────────────────────────────────────────────────────
  {
    id: "builtin:investor-update",
    name: "Investor update draft",
    description:
      "A tight monthly investor update: metrics, wins, lowlights, asks, and runway — from a few bullets.",
    publisher: "Omni",
    role: "Founder",
    output: "doc",
    target: "doc",
    prompt_template:
      "Draft a monthly investor update from these notes: {{input}}.\n" +
      "Structure: a one-line TL;DR, Key metrics (MRR, growth, burn, runway), Wins, Lowlights & what we're doing about them, Asks (intros, hires, advice), and a short closing. Keep it honest, skimmable, and under 400 words.",
    accent: OUTPUT_ACCENT.doc,
  },
  {
    id: "builtin:pitch-deck",
    name: "Product launch deck",
    description:
      "A 10-slide investor/launch deck outline covering problem, solution, market, and the ask.",
    publisher: "Omni",
    role: "Founder",
    output: "slides",
    target: "slides",
    prompt_template:
      "Create a 10-slide launch/pitch deck for: {{input}}.\n" +
      "Slides: 1 Title & tagline, 2 Problem, 3 Solution, 4 How it works, 5 Market size, 6 Product/demo, 7 Business model, 8 Traction, 9 Competition & moat, 10 The ask / call to action. Give each slide a punchy headline and 3-4 tight supporting points.",
    accent: OUTPUT_ACCENT.slides,
  },
  {
    id: "builtin:lean-canvas",
    name: "Lean canvas",
    description:
      "Fill out all nine lean-canvas boxes from a one-line startup idea to pressure-test it fast.",
    publisher: "OpenAI",
    role: "Founder",
    output: "doc",
    target: "doc",
    prompt_template:
      "Fill out a Lean Canvas for this startup idea: {{input}}.\n" +
      "Cover all nine boxes: Problem, Customer Segments, Unique Value Proposition, Solution, Channels, Revenue Streams, Cost Structure, Key Metrics, and Unfair Advantage. Be specific and note the single riskiest assumption to validate first.",
    accent: OUTPUT_ACCENT.doc,
  },

  // ── General ──────────────────────────────────────────────────────────
  {
    id: "builtin:meeting-notes-summarizer",
    name: "Meeting-notes summarizer",
    description:
      "Paste raw notes or a transcript and get a clean summary, decisions, and owned action items.",
    publisher: "Anthropic",
    role: "General",
    output: "chat",
    target: "chat",
    prompt_template:
      "Summarize these meeting notes/transcript into: a 3-bullet TL;DR, Key decisions, Action items (owner → task → due if mentioned), Open questions, and any risks raised. Be concise and don't invent details that aren't present.\n\n{{input}}",
    accent: OUTPUT_ACCENT.chat,
  },
  {
    id: "builtin:email-rewriter",
    name: "Rewrite this email",
    description:
      "Make any draft clearer, warmer, and shorter — with the tone you pick — in one pass.",
    publisher: "OpenAI",
    role: "General",
    output: "chat",
    target: "chat",
    prompt_template:
      "Rewrite the following email to be clearer, more concise, and appropriately warm while keeping my intent. Fix grammar, tighten wording, and improve the subject line. Then give one optional shorter variant.\n\n{{input}}",
    accent: OUTPUT_ACCENT.chat,
  },
  {
    id: "builtin:budget-tracker",
    name: "Monthly budget tracker",
    description:
      "A categorized budget sheet with planned vs actual and variance from a short description.",
    publisher: "Omni",
    role: "General",
    output: "sheet",
    target: "sheet",
    prompt_template:
      "Build a monthly budget tracker spreadsheet for: {{input}}.\n" +
      "Columns: Category, Subcategory, Planned, Actual, Variance, Notes. Include common income and expense categories (housing, food, transport, subscriptions, savings, etc.) with realistic example rows and a totals row at the bottom.",
    accent: OUTPUT_ACCENT.sheet,
  },
];

/**
 * Idempotently seed the curated built-in skills for the local user. Uses
 * INSERT OR IGNORE keyed on the stable string ids, so it is safe to call on
 * every boot. Descriptions/templates are refreshed for existing rows via a
 * lightweight UPDATE so edits to this file propagate without a migration.
 */
export function seedBuiltinSkills(): void {
  const userId = env.LOCAL_USER_ID;
  for (const s of SEED_SKILLS) {
    dbRun(
      `INSERT OR IGNORE INTO skills
         (id, user_id, name, description, publisher, role, output, target,
          prompt_template, accent, is_builtin)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      s.id,
      userId,
      s.name,
      s.description,
      s.publisher,
      s.role,
      s.output,
      s.target,
      s.prompt_template,
      s.accent,
    );
    // Keep built-in content in sync with this file on subsequent boots
    // (only touches builtin rows; never clobbers user-authored skills).
    dbRun(
      `UPDATE skills
          SET name = ?, description = ?, publisher = ?, role = ?, output = ?,
              target = ?, prompt_template = ?, accent = ?,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ? AND is_builtin = 1`,
      s.name,
      s.description,
      s.publisher,
      s.role,
      s.output,
      s.target,
      s.prompt_template,
      s.accent,
      s.id,
    );
  }
}
