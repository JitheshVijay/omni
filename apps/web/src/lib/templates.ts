// Curated, static template registry for the generator hubs: the data behind
// the Genspark-style template galleries on the Docs / Slides / Sheets / Images
// pages. Each template is a preview-thumbnail card that, when used, seeds the
// generator with a strong starting prompt (plus kind-specific knobs in `extra`).
//
// This is purely frontend data reusing the existing generator flows, with no new
// routes, no backend, no generation happens from a template until the user
// runs the seeded form.

export type GenKind = "doc" | "slides" | "sheet" | "image" | "webapp";

export interface GenTemplate {
  id: string;
  kind: GenKind;
  title: string;
  category: string;
  description: string;
  /** A genuinely useful full seed prompt (one or two sentences). */
  prompt: string;
  /** Tailwind gradient, e.g. 'from-sky-500 to-indigo-500'. */
  accent: string;
  extra?: {
    length?: "short" | "medium" | "long";
    // doc structural type (mirrors the backend doc generator's DOC_TYPES)
    doc_type?:
      | "auto"
      | "report"
      | "how_to"
      | "prd"
      | "meeting_notes"
      | "proposal"
      | "blog_post"
      | "letter"
      | "faq"
      | "checklist"
      | "comparison"
      | "study_notes"
      | "resume"
      | "release_notes"
      | "case_study"
      | "one_pager"
      | "press_release"
      | "essay";
    theme?: string; // slides theme preset id
    slide_count?: number;
    rows_hint?: number;
    aspect_ratio?: string;
    style?: "clean" | "playful" | "dark" | "minimal"; // webapp visual style
  };
}

// ─── Docs ────────────────────────────────────────────────────────────
const DOC_TEMPLATES: GenTemplate[] = [
  {
    id: "doc-project-brief",
    kind: "doc",
    title: "Project brief",
    category: "Business",
    description: "Goals, scope, risks, and timeline on one page.",
    prompt:
      "Write a one-page project brief for an upcoming initiative. Cover the objective and background, in-scope and out-of-scope items, key milestones with a timeline, primary risks with mitigations, and the success metrics we'll track.",
    accent: "from-sky-500 to-indigo-500",
    extra: { length: "medium", doc_type: "report" },
  },
  {
    id: "doc-prd",
    kind: "doc",
    title: "Product requirements (PRD)",
    category: "Business",
    description: "Problem, users, requirements, and success metrics.",
    prompt:
      "Draft a product requirements document for a new feature. Include the problem statement, target users and their jobs-to-be-done, goals and non-goals, functional requirements, edge cases, a rollout plan, and the metrics that define success.",
    accent: "from-indigo-500 to-violet-500",
    extra: { length: "long", doc_type: "prd" },
  },
  {
    id: "doc-meeting-notes",
    kind: "doc",
    title: "Meeting agenda & notes",
    category: "Work",
    description: "Structured agenda with owners and action items.",
    prompt:
      "Create a structured meeting agenda and notes template for a weekly team sync. Include the agenda with time boxes, discussion topics, decisions made, action items with owners and due dates, and a parking-lot section.",
    accent: "from-cyan-500 to-sky-500",
    extra: { length: "short", doc_type: "meeting_notes" },
  },
  {
    id: "doc-status-update",
    kind: "doc",
    title: "Weekly status update",
    category: "Work",
    description: "Progress, blockers, and next steps for stakeholders.",
    prompt:
      "Write a concise weekly status update for stakeholders. Summarize progress against goals, what shipped this week, current blockers with the help needed, key metrics, and the plan for next week.",
    accent: "from-teal-500 to-emerald-500",
    extra: { length: "short", doc_type: "report" },
  },
  {
    id: "doc-lesson-plan",
    kind: "doc",
    title: "Lesson plan",
    category: "Education",
    description: "Objectives, activities, and assessment for a class.",
    prompt:
      "Design a 60-minute lesson plan for a chosen topic and grade level. Include learning objectives, required materials, a warm-up, the main activity with timing, differentiation for varied learners, and an assessment to check understanding.",
    accent: "from-amber-500 to-orange-500",
    extra: { length: "medium", doc_type: "how_to" },
  },
  {
    id: "doc-study-guide",
    kind: "doc",
    title: "Study guide",
    category: "Education",
    description: "Key concepts, definitions, and practice questions.",
    prompt:
      "Produce a comprehensive study guide for an exam on a given subject. Summarize the key concepts and definitions, include worked examples, highlight common mistakes, and finish with a set of practice questions and answers.",
    accent: "from-orange-500 to-rose-500",
    extra: { length: "long", doc_type: "study_notes" },
  },
  {
    id: "doc-blog-post",
    kind: "doc",
    title: "Blog post",
    category: "Content",
    description: "SEO-friendly article with a clear structure.",
    prompt:
      "Write an engaging, SEO-friendly blog post on a topic of my choice. Use a compelling hook, clear headings and subheadings, practical examples, and a conclusion with a call to action. Aim for a friendly, authoritative tone.",
    accent: "from-fuchsia-500 to-pink-500",
    extra: { length: "medium", doc_type: "blog_post" },
  },
  {
    id: "doc-cover-letter",
    kind: "doc",
    title: "Cover letter",
    category: "Career",
    description: "Tailored letter that maps skills to the role.",
    prompt:
      "Write a tailored, one-page cover letter for a job application. Open with a strong hook, connect my most relevant experience and achievements to the role's requirements, convey genuine enthusiasm for the company, and close with a confident call to action.",
    accent: "from-emerald-500 to-teal-500",
    extra: { length: "short", doc_type: "letter" },
  },
  {
    id: "doc-resume",
    kind: "doc",
    title: "Resume / CV",
    category: "Career",
    description: "ATS-friendly resume with quantified achievements.",
    prompt:
      "Write a professional, ATS-friendly resume for a role and industry I specify. Include a contact header, a concise professional summary, a grouped skills section, work experience in reverse-chronological order with achievement bullets that quantify impact, education, and relevant certifications.",
    accent: "from-slate-500 to-gray-600",
    extra: { length: "medium", doc_type: "resume" },
  },
  {
    id: "doc-release-notes",
    kind: "doc",
    title: "Release notes",
    category: "Product",
    description: "User-facing changelog: features, fixes, breaking changes.",
    prompt:
      "Write release notes for a new product version. Include the version and date, a one-line summary, and user-facing sections for new features, improvements, bug fixes, and any breaking changes or deprecations, with a short bullet describing each change.",
    accent: "from-violet-500 to-purple-500",
    extra: { length: "short", doc_type: "release_notes" },
  },
  {
    id: "doc-case-study",
    kind: "doc",
    title: "Case study",
    category: "Marketing",
    description: "Customer success story: challenge, solution, results.",
    prompt:
      "Write a customer success case study for a B2B SaaS scenario I describe. Cover the client overview, the challenge they faced, the solution delivered, and quantified results with headline metrics, include a customer quote, and end with a short call to action.",
    accent: "from-emerald-500 to-green-600",
    extra: { length: "medium", doc_type: "case_study" },
  },
  {
    id: "doc-one-pager",
    kind: "doc",
    title: "One-pager",
    category: "Business",
    description: "A single-page pitch: problem, solution, traction, ask.",
    prompt:
      "Write a one-page overview (one-pager) for a startup or product. Include a headline and tagline, the problem, the solution, key features and benefits, traction and metrics, the market opportunity, and a clear ask or next step. Keep it dense and scannable.",
    accent: "from-sky-500 to-cyan-500",
    extra: { length: "short", doc_type: "one_pager" },
  },
  {
    id: "doc-press-release",
    kind: "doc",
    title: "Press release",
    category: "Marketing",
    description: "AP-style announcement with dateline, quotes, boilerplate.",
    prompt:
      "Write a press release in standard AP style announcing a product launch or company milestone. Include the FOR IMMEDIATE RELEASE line, a headline and subheadline, a dateline and lead paragraph, body paragraphs with a spokesperson quote, an 'About' boilerplate, and a media contact.",
    accent: "from-rose-500 to-red-500",
    extra: { length: "short", doc_type: "press_release" },
  },
];

// ─── Slides ──────────────────────────────────────────────────────────
const SLIDE_TEMPLATES: GenTemplate[] = [
  {
    id: "slides-pitch-deck",
    kind: "slides",
    title: "Investor pitch deck",
    category: "Fundraising",
    description: "Problem, market, product, traction, and the ask.",
    prompt:
      "Create a 12-slide seed-round investor pitch deck for a startup. Cover the problem, the solution and product, market size, business model, traction, competition, the team, and a clear funding ask with use of funds.",
    accent: "from-indigo-500 to-violet-500",
    extra: { theme: "midnight", slide_count: 12 },
  },
  {
    id: "slides-sales-deck",
    kind: "slides",
    title: "Sales deck",
    category: "Fundraising",
    description: "Value prop, ROI, and objection handling for buyers.",
    prompt:
      "Build a 10-slide B2B sales deck for a prospective customer. Lead with their pain point, present our solution and differentiators, show ROI with a case study, address common objections, and end with pricing and next steps.",
    accent: "from-violet-500 to-purple-500",
    extra: { theme: "midnight", slide_count: 10 },
  },
  {
    id: "slides-product-launch",
    kind: "slides",
    title: "Product launch",
    category: "Marketing",
    description: "Announce a new product with features and rollout.",
    prompt:
      "Design a 9-slide product launch presentation. Introduce the product with a bold hook, explain the customer problem it solves, showcase the top features and benefits, share the launch timeline, and close with pricing and availability.",
    accent: "from-fuchsia-500 to-pink-500",
    extra: { theme: "sunrise", slide_count: 9 },
  },
  {
    id: "slides-marketing-plan",
    kind: "slides",
    title: "Marketing strategy",
    category: "Marketing",
    description: "Audience, channels, campaigns, and KPIs.",
    prompt:
      "Create an 11-slide marketing strategy presentation. Define the target audience and positioning, outline the channel mix and campaign calendar, set the budget and KPIs, and include projected outcomes with a measurement plan.",
    accent: "from-rose-500 to-orange-500",
    extra: { theme: "sunrise", slide_count: 11 },
  },
  {
    id: "slides-qbr",
    kind: "slides",
    title: "Quarterly business review",
    category: "Business",
    description: "Results vs goals, wins, risks, and next-quarter plan.",
    prompt:
      "Prepare a 10-slide quarterly business review. Summarize performance against goals with key metrics and charts, highlight wins and misses, review pipeline and risks, and lay out priorities and targets for next quarter.",
    accent: "from-sky-500 to-cyan-500",
    extra: { theme: "daylight", slide_count: 10 },
  },
  {
    id: "slides-company-overview",
    kind: "slides",
    title: "Company overview",
    category: "Business",
    description: "Mission, offering, team, and traction at a glance.",
    prompt:
      "Build an 8-slide company overview deck. Cover the mission and story, the problem and solution, the product offering, key customers and traction, the team, and how to get in touch.",
    accent: "from-blue-500 to-indigo-500",
    extra: { theme: "daylight", slide_count: 8 },
  },
  {
    id: "slides-lecture",
    kind: "slides",
    title: "Lecture / course module",
    category: "Education",
    description: "Teach a topic with clear sections and takeaways.",
    prompt:
      "Create a 10-slide lecture presentation that teaches a specific topic to students. Start with learning objectives, break the content into logical sections with clear explanations and examples, and finish with a summary of key takeaways and discussion questions.",
    accent: "from-emerald-500 to-teal-500",
    extra: { theme: "forest", slide_count: 10 },
  },
  {
    id: "slides-workshop",
    kind: "slides",
    title: "Training workshop",
    category: "Education",
    description: "Hands-on session with exercises and checkpoints.",
    prompt:
      "Design a 9-slide hands-on training workshop. Set the agenda and goals, teach core concepts step by step, include practical exercises and checkpoints, and end with resources and a recap of what participants learned.",
    accent: "from-teal-500 to-green-500",
    extra: { theme: "forest", slide_count: 9 },
  },
];

// ─── Sheets ──────────────────────────────────────────────────────────
const SHEET_TEMPLATES: GenTemplate[] = [
  {
    id: "sheet-budget",
    kind: "sheet",
    title: "Monthly budget tracker",
    category: "Finance",
    description: "Categories, budgeted vs actual, and variance.",
    prompt:
      "Build a monthly personal budget tracker. Include columns for category, subcategory, budgeted amount, actual amount, variance, and notes, with realistic sample rows across income and common spending categories.",
    accent: "from-emerald-500 to-teal-500",
    extra: { rows_hint: 20 },
  },
  {
    id: "sheet-expense-log",
    kind: "sheet",
    title: "Expense log",
    category: "Finance",
    description: "Itemized expenses with date, category, and amount.",
    prompt:
      "Create a business expense log spreadsheet. Include columns for date, vendor, category, payment method, amount, reimbursable (yes/no), and description, with sample rows spanning a typical month.",
    accent: "from-green-500 to-emerald-500",
    extra: { rows_hint: 25 },
  },
  {
    id: "sheet-competitor",
    kind: "sheet",
    title: "Competitor analysis",
    category: "Research",
    description: "Compare rivals across pricing and features.",
    prompt:
      "Build a competitor analysis matrix comparing the leading companies in a chosen market. Include columns for competitor, positioning, pricing, key features, target audience, strengths, and weaknesses.",
    accent: "from-sky-500 to-blue-500",
    extra: { rows_hint: 12 },
  },
  {
    id: "sheet-literature",
    kind: "sheet",
    title: "Literature review",
    category: "Research",
    description: "Track sources, findings, and citations.",
    prompt:
      "Create a literature review tracker for a research topic. Include columns for title, authors, year, source, key findings, methodology, relevance, and citation, with example rows for representative papers.",
    accent: "from-indigo-500 to-blue-500",
    extra: { rows_hint: 15 },
  },
  {
    id: "sheet-content-calendar",
    kind: "sheet",
    title: "Content calendar",
    category: "Marketing",
    description: "Plan posts by date, channel, and status.",
    prompt:
      "Build a social media content calendar. Include columns for publish date, channel, content type, topic/hook, caption, call to action, asset link, and status, with a month of sample entries across channels.",
    accent: "from-fuchsia-500 to-pink-500",
    extra: { rows_hint: 24 },
  },
  {
    id: "sheet-campaign-tracker",
    kind: "sheet",
    title: "Campaign performance",
    category: "Marketing",
    description: "Spend, impressions, conversions, and ROAS.",
    prompt:
      "Create a marketing campaign performance tracker. Include columns for campaign, channel, start date, spend, impressions, clicks, conversions, cost per acquisition, and ROAS, with realistic sample data.",
    accent: "from-pink-500 to-rose-500",
    extra: { rows_hint: 15 },
  },
  {
    id: "sheet-crm",
    kind: "sheet",
    title: "Sales pipeline / CRM",
    category: "Sales",
    description: "Deals by stage, value, and next action.",
    prompt:
      "Build a sales pipeline tracker. Include columns for company, contact, deal value, stage, probability, expected close date, owner, and next action, with sample deals spread across pipeline stages.",
    accent: "from-orange-500 to-amber-500",
    extra: { rows_hint: 20 },
  },
  {
    id: "sheet-project-tasks",
    kind: "sheet",
    title: "Project task tracker",
    category: "Ops",
    description: "Tasks with owner, status, priority, and due date.",
    prompt:
      "Create a project task tracker. Include columns for task, owner, priority, status, start date, due date, dependencies, and notes, with sample tasks across a typical project plan.",
    accent: "from-violet-500 to-indigo-500",
    extra: { rows_hint: 25 },
  },
];

// ─── Images ──────────────────────────────────────────────────────────
const IMAGE_TEMPLATES: GenTemplate[] = [
  {
    id: "img-hero-banner",
    kind: "image",
    title: "Website hero banner",
    category: "Marketing",
    description: "Clean, modern header artwork with depth.",
    prompt:
      "A modern website hero banner: an abstract gradient landscape with soft geometric shapes and gentle light rays, clean and minimal, plenty of negative space for headline text, professional tech aesthetic.",
    accent: "from-sky-500 to-indigo-500",
    extra: { aspect_ratio: "16:9" },
  },
  {
    id: "img-ad-creative",
    kind: "image",
    title: "Ad creative",
    category: "Marketing",
    description: "Eye-catching promo visual for a campaign.",
    prompt:
      "A vibrant, eye-catching advertisement visual for a product promotion: bold colors, dynamic composition, a floating product hero with dramatic studio lighting and a bright complementary background, high energy and polished.",
    accent: "from-rose-500 to-orange-500",
    extra: { aspect_ratio: "1:1" },
  },
  {
    id: "img-social-post",
    kind: "image",
    title: "Social media post",
    category: "Social",
    description: "Scroll-stopping square graphic.",
    prompt:
      "A scroll-stopping square social media graphic: a striking flat-illustration scene with a confident color palette, playful shapes, and clear focal point, designed to feel fresh and shareable.",
    accent: "from-fuchsia-500 to-purple-500",
    extra: { aspect_ratio: "1:1" },
  },
  {
    id: "img-story",
    kind: "image",
    title: "Story / Reel background",
    category: "Social",
    description: "Vertical backdrop for stories and reels.",
    prompt:
      "A vertical full-bleed background for a social story: a dreamy gradient sky with soft bokeh and subtle grain, atmospheric and moody, leaving the center clear for text overlay.",
    accent: "from-violet-500 to-fuchsia-500",
    extra: { aspect_ratio: "9:16" },
  },
  {
    id: "img-product-shot",
    kind: "image",
    title: "Product photo",
    category: "Product",
    description: "Studio-quality product on a clean set.",
    prompt:
      "A photorealistic studio product shot of a sleek consumer gadget on a minimalist podium, soft diffused lighting, subtle reflections, neutral seamless background, shallow depth of field, premium e-commerce look.",
    accent: "from-slate-500 to-gray-500",
    extra: { aspect_ratio: "1:1" },
  },
  {
    id: "img-app-icon",
    kind: "image",
    title: "App icon",
    category: "Product",
    description: "Bold, rounded icon with a simple mark.",
    prompt:
      "A modern app icon: a simple, memorable symbol centered on a smooth diagonal gradient, rounded-square format, crisp edges, subtle depth and highlight, clean and instantly recognizable.",
    accent: "from-blue-500 to-cyan-500",
    extra: { aspect_ratio: "1:1" },
  },
  {
    id: "img-blog-illustration",
    kind: "image",
    title: "Blog illustration",
    category: "Content",
    description: "Editorial artwork to headline an article.",
    prompt:
      "An editorial illustration to accompany an article: a conceptual flat-design scene with a clear metaphor, warm harmonious colors, textured shading, and a friendly modern style suitable for a blog header.",
    accent: "from-amber-500 to-orange-500",
    extra: { aspect_ratio: "16:9" },
  },
  {
    id: "img-thumbnail",
    kind: "image",
    title: "Video thumbnail",
    category: "Content",
    description: "High-contrast, click-worthy cover art.",
    prompt:
      "A high-contrast video thumbnail background: a bold dramatic scene with punchy saturated colors, strong lighting and a clear focal subject, cinematic and attention-grabbing, with space for large overlaid title text.",
    accent: "from-red-500 to-rose-500",
    extra: { aspect_ratio: "16:9" },
  },
];

// ─── Web apps ────────────────────────────────────────────────────────
const WEBAPP_TEMPLATES: GenTemplate[] = [
  {
    id: "webapp-landing",
    kind: "webapp",
    title: "Landing page",
    category: "Marketing",
    description: "Hero, features, and a call-to-action for a product.",
    prompt:
      "Build a polished marketing landing page for a modern SaaS product. Include a sticky nav, a hero with a headline, subheadline and primary CTA button, a three-up feature section with inline SVG icons, a testimonial, a simple pricing hint, and a footer. Make the CTA button show a friendly confirmation when clicked.",
    accent: "from-sky-500 to-indigo-500",
    extra: { style: "clean" },
  },
  {
    id: "webapp-todo",
    kind: "webapp",
    title: "Todo app",
    category: "Productivity",
    description: "Add, complete, filter, and clear tasks, with persistence.",
    prompt:
      "Build a fully working todo app. Let me add tasks, mark them complete, edit and delete them, filter by all/active/completed, and show a live count of remaining tasks. Persist everything to localStorage so it survives a reload, and animate items in and out.",
    accent: "from-violet-500 to-fuchsia-500",
    extra: { style: "playful" },
  },
  {
    id: "webapp-pricing",
    kind: "webapp",
    title: "Pricing page",
    category: "Marketing",
    description: "Three tiers with a monthly / yearly toggle.",
    prompt:
      "Build a pricing page with three plan cards (Starter, Pro, Enterprise), a highlighted 'most popular' tier, a feature checklist per plan, and a monthly/yearly billing toggle that updates the prices live with an annual discount. Clean and conversion-focused.",
    accent: "from-emerald-500 to-teal-500",
    extra: { style: "clean" },
  },
  {
    id: "webapp-calculator",
    kind: "webapp",
    title: "Calculator",
    category: "Tools",
    description: "A working calculator with keyboard support.",
    prompt:
      "Build a fully functional calculator: a display and a grid of buttons for digits, the four operations, decimal, clear, sign toggle, and percent. Handle chained operations and division-by-zero gracefully, and support keyboard input. Give it a tactile, satisfying look.",
    accent: "from-slate-500 to-gray-600",
    extra: { style: "dark" },
  },
  {
    id: "webapp-portfolio",
    kind: "webapp",
    title: "Portfolio",
    category: "Personal",
    description: "A one-page personal site with projects and contact.",
    prompt:
      "Build a one-page personal portfolio site for a designer/developer. Include an intro hero with a short bio, an about section, a grid of project cards with hover states, a skills list, and a contact section with a form that validates and shows a thank-you message on submit. Smooth-scroll the nav links.",
    accent: "from-rose-500 to-orange-500",
    extra: { style: "minimal" },
  },
  {
    id: "webapp-dashboard",
    kind: "webapp",
    title: "Dashboard UI",
    category: "Product",
    description: "Analytics dashboard with sidebar, stats, and charts.",
    prompt:
      "Build an analytics dashboard UI. Include a sidebar with nav items, a top bar with a search field and avatar, a row of KPI stat cards with trend indicators, a bar chart and a line chart drawn with inline SVG or canvas from sample data, and a recent-activity table. Make it responsive and give it a premium dark look.",
    accent: "from-indigo-500 to-blue-500",
    extra: { style: "dark" },
  },
];

const ALL: Record<GenKind, GenTemplate[]> = {
  doc: DOC_TEMPLATES,
  slides: SLIDE_TEMPLATES,
  sheet: SHEET_TEMPLATES,
  image: IMAGE_TEMPLATES,
  webapp: WEBAPP_TEMPLATES,
};

/** All templates for a kind, in curated order. */
export function templatesForKind(kind: GenKind): GenTemplate[] {
  return ALL[kind];
}

/** Unique categories for a kind, with 'All' first. */
export function categoriesForKind(kind: GenKind): string[] {
  const seen: string[] = [];
  for (const t of ALL[kind]) {
    if (!seen.includes(t.category)) seen.push(t.category);
  }
  return ["All", ...seen];
}
