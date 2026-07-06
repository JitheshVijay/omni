// Curated AgentBase system templates — the ready-made "systems" users clone
// from the gallery on /agentbase. Each template is a full blueprint: a named
// workspace with one or two TABLES (a typed column schema + a handful of real
// sample rows) and 3-4 DASHBOARD TILES that aggregate over them. Cloning a
// template (POST /api/agentbase/systems { from_template }) copies this shape
// verbatim into the systems / system_tables / system_records / system_tiles
// tables — no LLM call. The same shape is what agentbase-gen.ts asks the model
// to produce for a "just describe it" flow, so the two paths converge on one
// persistence routine.
//
// Column types: text | number | date | select | url | currency
// Tile kinds:   stat (big number) | bar (grouped) | donut (grouped)
// Tile aggs:    count | sum | avg   (+ optional field / group_by column keys)

export type ColumnType = "text" | "number" | "date" | "select" | "url" | "currency";

export interface TemplateColumn {
  key: string;
  label: string;
  type: ColumnType;
  /** Allowed values for a `select` column. */
  options?: string[];
}

export type TileKind = "stat" | "bar" | "donut";
export type TileAgg = "count" | "sum" | "avg";

export interface TemplateTileConfig {
  agg: TileAgg;
  /** Column key to sum/avg over (required for sum/avg). */
  field?: string;
  /** Column key to group by (required for bar/donut). */
  group_by?: string;
}

export interface TemplateTile {
  title: string;
  kind: TileKind;
  /** Name of the table (within this template) the tile aggregates over. */
  tableName: string;
  config: TemplateTileConfig;
}

export interface TemplateTable {
  name: string;
  columns: TemplateColumn[];
  sampleRows: Record<string, string | number>[];
}

export interface AgentBaseTemplate {
  id: string;
  name: string;
  description: string;
  category: string;
  /** A lucide icon name mapped to a component on the frontend. */
  icon: string;
  /** Gradient utility classes used to tint the preview / header. */
  accent: string;
  tables: TemplateTable[];
  tiles: TemplateTile[];
}

export const AGENTBASE_CATEGORIES = [
  "Sales & CRM",
  "Inventory",
  "Projects",
  "Marketing",
  "HR",
  "Personal",
] as const;

export const AGENTBASE_TEMPLATES: AgentBaseTemplate[] = [
  // ── Sales & CRM ───────────────────────────────────────────────────────
  {
    id: "tmpl:sales-crm",
    name: "Sales CRM",
    description:
      "Track leads through your pipeline with owners, deal value, and stage — plus tiles for pipeline value and win rate.",
    category: "Sales & CRM",
    icon: "Users",
    accent: "from-indigo-500 to-accent2",
    tables: [
      {
        name: "Leads",
        columns: [
          { key: "company", label: "Company", type: "text" },
          { key: "contact", label: "Contact", type: "text" },
          {
            key: "stage",
            label: "Stage",
            type: "select",
            options: ["New", "Qualified", "Proposal", "Negotiation", "Won", "Lost"],
          },
          { key: "value", label: "Deal Value", type: "currency" },
          { key: "owner", label: "Owner", type: "text" },
          { key: "next_step_at", label: "Next Step", type: "date" },
        ],
        sampleRows: [
          { company: "Northwind Traders", contact: "Priya Shah", stage: "Proposal", value: 24000, owner: "Alex", next_step_at: "2026-07-10" },
          { company: "Acme Robotics", contact: "Dan Lee", stage: "Qualified", value: 12000, owner: "Sam", next_step_at: "2026-07-08" },
          { company: "Globex", contact: "Maria Ruiz", stage: "Won", value: 38000, owner: "Alex", next_step_at: "2026-07-02" },
          { company: "Initech", contact: "Tom Byrne", stage: "New", value: 6000, owner: "Sam", next_step_at: "2026-07-12" },
          { company: "Umbrella Co", contact: "Nina Patel", stage: "Negotiation", value: 51000, owner: "Alex", next_step_at: "2026-07-09" },
          { company: "Soylent Corp", contact: "Erik Ng", stage: "Lost", value: 9000, owner: "Sam", next_step_at: "2026-07-01" },
          { company: "Hooli", contact: "Grace Kim", stage: "Qualified", value: 30000, owner: "Alex", next_step_at: "2026-07-15" },
        ],
      },
    ],
    tiles: [
      { title: "Open Deals", kind: "stat", tableName: "Leads", config: { agg: "count" } },
      { title: "Pipeline Value", kind: "stat", tableName: "Leads", config: { agg: "sum", field: "value" } },
      { title: "Deals by Stage", kind: "bar", tableName: "Leads", config: { agg: "count", group_by: "stage" } },
      { title: "Value by Owner", kind: "donut", tableName: "Leads", config: { agg: "sum", field: "value", group_by: "owner" } },
    ],
  },
  {
    id: "tmpl:client-success",
    name: "Client Success Tracker",
    description:
      "Monitor account health, renewal dates, and MRR so no customer slips through the cracks.",
    category: "Sales & CRM",
    icon: "HeartHandshake",
    accent: "from-emerald-500 to-teal-400",
    tables: [
      {
        name: "Accounts",
        columns: [
          { key: "account", label: "Account", type: "text" },
          { key: "csm", label: "CSM", type: "text" },
          {
            key: "health",
            label: "Health",
            type: "select",
            options: ["Green", "Yellow", "Red"],
          },
          { key: "mrr", label: "MRR", type: "currency" },
          { key: "renewal_at", label: "Renewal", type: "date" },
          { key: "seats", label: "Seats", type: "number" },
        ],
        sampleRows: [
          { account: "Northwind", csm: "Jamie", health: "Green", mrr: 2400, renewal_at: "2026-11-01", seats: 40 },
          { account: "Acme", csm: "Riley", health: "Yellow", mrr: 1200, renewal_at: "2026-08-15", seats: 18 },
          { account: "Globex", csm: "Jamie", health: "Green", mrr: 3800, renewal_at: "2027-01-10", seats: 65 },
          { account: "Initech", csm: "Riley", health: "Red", mrr: 600, renewal_at: "2026-07-20", seats: 8 },
          { account: "Umbrella", csm: "Jamie", health: "Green", mrr: 5100, renewal_at: "2026-12-05", seats: 90 },
          { account: "Hooli", csm: "Riley", health: "Yellow", mrr: 3000, renewal_at: "2026-09-30", seats: 50 },
        ],
      },
    ],
    tiles: [
      { title: "Accounts", kind: "stat", tableName: "Accounts", config: { agg: "count" } },
      { title: "Total MRR", kind: "stat", tableName: "Accounts", config: { agg: "sum", field: "mrr" } },
      { title: "Health Mix", kind: "donut", tableName: "Accounts", config: { agg: "count", group_by: "health" } },
      { title: "MRR by CSM", kind: "bar", tableName: "Accounts", config: { agg: "sum", field: "mrr", group_by: "csm" } },
    ],
  },

  // ── Inventory ─────────────────────────────────────────────────────────
  {
    id: "tmpl:inventory",
    name: "Inventory Tracker",
    description:
      "Keep tabs on stock levels, categories, and reorder points across your product catalog.",
    category: "Inventory",
    icon: "Boxes",
    accent: "from-amber-500 to-orange-400",
    tables: [
      {
        name: "Products",
        columns: [
          { key: "sku", label: "SKU", type: "text" },
          { key: "name", label: "Product", type: "text" },
          {
            key: "category",
            label: "Category",
            type: "select",
            options: ["Apparel", "Electronics", "Home", "Outdoor", "Grocery"],
          },
          { key: "qty", label: "In Stock", type: "number" },
          { key: "reorder_at", label: "Reorder At", type: "number" },
          { key: "unit_cost", label: "Unit Cost", type: "currency" },
        ],
        sampleRows: [
          { sku: "AP-001", name: "Merino Tee", category: "Apparel", qty: 120, reorder_at: 40, unit_cost: 14 },
          { sku: "EL-014", name: "USB-C Hub", category: "Electronics", qty: 18, reorder_at: 25, unit_cost: 22 },
          { sku: "HM-207", name: "Ceramic Mug", category: "Home", qty: 300, reorder_at: 80, unit_cost: 5 },
          { sku: "OD-050", name: "Trail Bottle", category: "Outdoor", qty: 12, reorder_at: 30, unit_cost: 9 },
          { sku: "GR-088", name: "Cold Brew 6pk", category: "Grocery", qty: 64, reorder_at: 50, unit_cost: 11 },
          { sku: "EL-021", name: "Wireless Mouse", category: "Electronics", qty: 45, reorder_at: 20, unit_cost: 17 },
        ],
      },
    ],
    tiles: [
      { title: "SKUs", kind: "stat", tableName: "Products", config: { agg: "count" } },
      { title: "Units in Stock", kind: "stat", tableName: "Products", config: { agg: "sum", field: "qty" } },
      { title: "Stock by Category", kind: "bar", tableName: "Products", config: { agg: "sum", field: "qty", group_by: "category" } },
      { title: "SKUs by Category", kind: "donut", tableName: "Products", config: { agg: "count", group_by: "category" } },
    ],
  },

  // ── Projects ──────────────────────────────────────────────────────────
  {
    id: "tmpl:bug-tracker",
    name: "Bug & Issue Tracker",
    description:
      "Log bugs with severity, status, and assignee — with tiles for open count and severity breakdown.",
    category: "Projects",
    icon: "Bug",
    accent: "from-rose-500 to-accent2",
    tables: [
      {
        name: "Issues",
        columns: [
          { key: "title", label: "Title", type: "text" },
          {
            key: "severity",
            label: "Severity",
            type: "select",
            options: ["Low", "Medium", "High", "Critical"],
          },
          {
            key: "status",
            label: "Status",
            type: "select",
            options: ["Open", "In Progress", "In Review", "Closed"],
          },
          { key: "assignee", label: "Assignee", type: "text" },
          { key: "opened_at", label: "Opened", type: "date" },
        ],
        sampleRows: [
          { title: "Login redirect loops on Safari", severity: "High", status: "Open", assignee: "Dana", opened_at: "2026-07-01" },
          { title: "CSV export drops last row", severity: "Medium", status: "In Progress", assignee: "Kai", opened_at: "2026-07-02" },
          { title: "Crash on empty search", severity: "Critical", status: "In Review", assignee: "Dana", opened_at: "2026-07-03" },
          { title: "Typo in onboarding copy", severity: "Low", status: "Closed", assignee: "Kai", opened_at: "2026-06-28" },
          { title: "Slow dashboard load", severity: "High", status: "Open", assignee: "Mira", opened_at: "2026-07-04" },
          { title: "Avatar upload 500s", severity: "Medium", status: "Open", assignee: "Mira", opened_at: "2026-07-05" },
        ],
      },
    ],
    tiles: [
      { title: "Total Issues", kind: "stat", tableName: "Issues", config: { agg: "count" } },
      { title: "By Status", kind: "bar", tableName: "Issues", config: { agg: "count", group_by: "status" } },
      { title: "By Severity", kind: "donut", tableName: "Issues", config: { agg: "count", group_by: "severity" } },
      { title: "By Assignee", kind: "bar", tableName: "Issues", config: { agg: "count", group_by: "assignee" } },
    ],
  },
  {
    id: "tmpl:project-tracker",
    name: "Project Tracker",
    description:
      "Coordinate deliverables across owners with status, priority, and estimated hours.",
    category: "Projects",
    icon: "ListChecks",
    accent: "from-sky-500 to-accent",
    tables: [
      {
        name: "Tasks",
        columns: [
          { key: "task", label: "Task", type: "text" },
          { key: "owner", label: "Owner", type: "text" },
          {
            key: "status",
            label: "Status",
            type: "select",
            options: ["Todo", "Doing", "Blocked", "Done"],
          },
          {
            key: "priority",
            label: "Priority",
            type: "select",
            options: ["Low", "Medium", "High"],
          },
          { key: "est_hours", label: "Est. Hours", type: "number" },
          { key: "due_at", label: "Due", type: "date" },
        ],
        sampleRows: [
          { task: "Draft launch blog", owner: "Lee", status: "Doing", priority: "High", est_hours: 6, due_at: "2026-07-09" },
          { task: "Wire up billing", owner: "Ade", status: "Blocked", priority: "High", est_hours: 12, due_at: "2026-07-11" },
          { task: "Design email templates", owner: "Rae", status: "Todo", priority: "Medium", est_hours: 4, due_at: "2026-07-14" },
          { task: "QA mobile flows", owner: "Lee", status: "Todo", priority: "Medium", est_hours: 8, due_at: "2026-07-16" },
          { task: "Finalize pricing page", owner: "Ade", status: "Done", priority: "Low", est_hours: 3, due_at: "2026-07-03" },
          { task: "Set up analytics", owner: "Rae", status: "Doing", priority: "High", est_hours: 5, due_at: "2026-07-10" },
        ],
      },
    ],
    tiles: [
      { title: "Tasks", kind: "stat", tableName: "Tasks", config: { agg: "count" } },
      { title: "Est. Hours Left", kind: "stat", tableName: "Tasks", config: { agg: "sum", field: "est_hours" } },
      { title: "By Status", kind: "donut", tableName: "Tasks", config: { agg: "count", group_by: "status" } },
      { title: "Hours by Owner", kind: "bar", tableName: "Tasks", config: { agg: "sum", field: "est_hours", group_by: "owner" } },
    ],
  },

  // ── Marketing ─────────────────────────────────────────────────────────
  {
    id: "tmpl:content-calendar",
    name: "Content Calendar",
    description:
      "Plan posts across channels with status and publish dates — see what's shipping and where.",
    category: "Marketing",
    icon: "CalendarDays",
    accent: "from-fuchsia-500 to-accent2",
    tables: [
      {
        name: "Content",
        columns: [
          { key: "title", label: "Title", type: "text" },
          {
            key: "channel",
            label: "Channel",
            type: "select",
            options: ["Blog", "LinkedIn", "X", "Newsletter", "YouTube"],
          },
          {
            key: "status",
            label: "Status",
            type: "select",
            options: ["Idea", "Drafting", "Scheduled", "Published"],
          },
          { key: "owner", label: "Owner", type: "text" },
          { key: "publish_at", label: "Publish", type: "date" },
        ],
        sampleRows: [
          { title: "How we cut onboarding time 40%", channel: "Blog", status: "Scheduled", owner: "Nia", publish_at: "2026-07-10" },
          { title: "5 pipeline mistakes", channel: "LinkedIn", status: "Drafting", owner: "Omar", publish_at: "2026-07-08" },
          { title: "Feature teaser thread", channel: "X", status: "Idea", owner: "Nia", publish_at: "2026-07-15" },
          { title: "July product recap", channel: "Newsletter", status: "Published", owner: "Omar", publish_at: "2026-07-01" },
          { title: "Founder interview", channel: "YouTube", status: "Drafting", owner: "Nia", publish_at: "2026-07-20" },
          { title: "Customer story: Globex", channel: "Blog", status: "Idea", owner: "Omar", publish_at: "2026-07-25" },
        ],
      },
    ],
    tiles: [
      { title: "Pieces Planned", kind: "stat", tableName: "Content", config: { agg: "count" } },
      { title: "By Channel", kind: "bar", tableName: "Content", config: { agg: "count", group_by: "channel" } },
      { title: "By Status", kind: "donut", tableName: "Content", config: { agg: "count", group_by: "status" } },
      { title: "By Owner", kind: "bar", tableName: "Content", config: { agg: "count", group_by: "owner" } },
    ],
  },
  {
    id: "tmpl:campaign-tracker",
    name: "Campaign Tracker",
    description:
      "Track marketing campaigns by channel with spend, leads generated, and cost per lead.",
    category: "Marketing",
    icon: "Megaphone",
    accent: "from-violet-500 to-accent",
    tables: [
      {
        name: "Campaigns",
        columns: [
          { key: "name", label: "Campaign", type: "text" },
          {
            key: "channel",
            label: "Channel",
            type: "select",
            options: ["Search", "Social", "Email", "Events", "Referral"],
          },
          { key: "spend", label: "Spend", type: "currency" },
          { key: "leads", label: "Leads", type: "number" },
          {
            key: "status",
            label: "Status",
            type: "select",
            options: ["Planned", "Live", "Paused", "Ended"],
          },
        ],
        sampleRows: [
          { name: "Q3 Brand Push", channel: "Social", spend: 8000, leads: 220, status: "Live" },
          { name: "Search Always-On", channel: "Search", spend: 12000, leads: 540, status: "Live" },
          { name: "July Webinar", channel: "Events", spend: 3500, leads: 130, status: "Ended" },
          { name: "Reactivation Blast", channel: "Email", spend: 900, leads: 75, status: "Paused" },
          { name: "Partner Referrals", channel: "Referral", spend: 2000, leads: 90, status: "Live" },
          { name: "Fall Teaser", channel: "Social", spend: 4200, leads: 60, status: "Planned" },
        ],
      },
    ],
    tiles: [
      { title: "Campaigns", kind: "stat", tableName: "Campaigns", config: { agg: "count" } },
      { title: "Total Spend", kind: "stat", tableName: "Campaigns", config: { agg: "sum", field: "spend" } },
      { title: "Leads by Channel", kind: "bar", tableName: "Campaigns", config: { agg: "sum", field: "leads", group_by: "channel" } },
      { title: "Spend by Channel", kind: "donut", tableName: "Campaigns", config: { agg: "sum", field: "spend", group_by: "channel" } },
    ],
  },

  // ── HR ────────────────────────────────────────────────────────────────
  {
    id: "tmpl:applicant-tracker",
    name: "Applicant Tracker",
    description:
      "Move candidates through your hiring funnel by role and stage, with source attribution.",
    category: "HR",
    icon: "UserCheck",
    accent: "from-teal-500 to-emerald-400",
    tables: [
      {
        name: "Candidates",
        columns: [
          { key: "name", label: "Candidate", type: "text" },
          { key: "role", label: "Role", type: "text" },
          {
            key: "stage",
            label: "Stage",
            type: "select",
            options: ["Applied", "Screen", "Interview", "Offer", "Hired", "Rejected"],
          },
          {
            key: "source",
            label: "Source",
            type: "select",
            options: ["Referral", "LinkedIn", "Job Board", "Inbound"],
          },
          { key: "applied_at", label: "Applied", type: "date" },
        ],
        sampleRows: [
          { name: "Priya N.", role: "Backend Eng", stage: "Interview", source: "Referral", applied_at: "2026-06-20" },
          { name: "Marcus D.", role: "Designer", stage: "Screen", source: "LinkedIn", applied_at: "2026-06-25" },
          { name: "Lena K.", role: "Backend Eng", stage: "Offer", source: "Inbound", applied_at: "2026-06-15" },
          { name: "Tomas R.", role: "PM", stage: "Applied", source: "Job Board", applied_at: "2026-07-01" },
          { name: "Aya S.", role: "Designer", stage: "Hired", source: "Referral", applied_at: "2026-06-05" },
          { name: "Owen B.", role: "PM", stage: "Rejected", source: "Job Board", applied_at: "2026-06-18" },
        ],
      },
    ],
    tiles: [
      { title: "Candidates", kind: "stat", tableName: "Candidates", config: { agg: "count" } },
      { title: "By Stage", kind: "bar", tableName: "Candidates", config: { agg: "count", group_by: "stage" } },
      { title: "By Source", kind: "donut", tableName: "Candidates", config: { agg: "count", group_by: "source" } },
      { title: "By Role", kind: "bar", tableName: "Candidates", config: { agg: "count", group_by: "role" } },
    ],
  },

  // ── Personal ──────────────────────────────────────────────────────────
  {
    id: "tmpl:budget-tracker",
    name: "Budget Tracker",
    description:
      "Log expenses by category and see where your money goes each month at a glance.",
    category: "Personal",
    icon: "Wallet",
    accent: "from-emerald-500 to-lime-400",
    tables: [
      {
        name: "Expenses",
        columns: [
          { key: "item", label: "Item", type: "text" },
          {
            key: "category",
            label: "Category",
            type: "select",
            options: ["Rent", "Groceries", "Transport", "Dining", "Utilities", "Fun"],
          },
          { key: "amount", label: "Amount", type: "currency" },
          {
            key: "method",
            label: "Method",
            type: "select",
            options: ["Card", "Cash", "Transfer"],
          },
          { key: "spent_at", label: "Date", type: "date" },
        ],
        sampleRows: [
          { item: "July rent", category: "Rent", amount: 1800, method: "Transfer", spent_at: "2026-07-01" },
          { item: "Weekly shop", category: "Groceries", amount: 96, method: "Card", spent_at: "2026-07-03" },
          { item: "Metro pass", category: "Transport", amount: 75, method: "Card", spent_at: "2026-07-02" },
          { item: "Dinner out", category: "Dining", amount: 48, method: "Card", spent_at: "2026-07-04" },
          { item: "Electric bill", category: "Utilities", amount: 62, method: "Transfer", spent_at: "2026-07-05" },
          { item: "Movie night", category: "Fun", amount: 32, method: "Cash", spent_at: "2026-07-06" },
          { item: "Coffee beans", category: "Groceries", amount: 18, method: "Card", spent_at: "2026-07-06" },
        ],
      },
    ],
    tiles: [
      { title: "Transactions", kind: "stat", tableName: "Expenses", config: { agg: "count" } },
      { title: "Total Spent", kind: "stat", tableName: "Expenses", config: { agg: "sum", field: "amount" } },
      { title: "Spend by Category", kind: "bar", tableName: "Expenses", config: { agg: "sum", field: "amount", group_by: "category" } },
      { title: "By Method", kind: "donut", tableName: "Expenses", config: { agg: "sum", field: "amount", group_by: "method" } },
    ],
  },
  {
    id: "tmpl:habit-tracker",
    name: "Reading List",
    description:
      "Keep a personal library of books to read with status, genre, and a rating for finished reads.",
    category: "Personal",
    icon: "BookOpen",
    accent: "from-orange-500 to-amber-400",
    tables: [
      {
        name: "Books",
        columns: [
          { key: "title", label: "Title", type: "text" },
          { key: "author", label: "Author", type: "text" },
          {
            key: "genre",
            label: "Genre",
            type: "select",
            options: ["Fiction", "Nonfiction", "Sci-Fi", "Business", "Biography"],
          },
          {
            key: "status",
            label: "Status",
            type: "select",
            options: ["Want to Read", "Reading", "Finished"],
          },
          { key: "rating", label: "Rating", type: "number" },
        ],
        sampleRows: [
          { title: "The Making of a Manager", author: "Julie Zhuo", genre: "Business", status: "Finished", rating: 5 },
          { title: "Project Hail Mary", author: "Andy Weir", genre: "Sci-Fi", status: "Reading", rating: 0 },
          { title: "Steve Jobs", author: "Walter Isaacson", genre: "Biography", status: "Want to Read", rating: 0 },
          { title: "Deep Work", author: "Cal Newport", genre: "Nonfiction", status: "Finished", rating: 4 },
          { title: "Klara and the Sun", author: "Kazuo Ishiguro", genre: "Fiction", status: "Finished", rating: 4 },
          { title: "The Lean Startup", author: "Eric Ries", genre: "Business", status: "Reading", rating: 0 },
        ],
      },
    ],
    tiles: [
      { title: "Books", kind: "stat", tableName: "Books", config: { agg: "count" } },
      { title: "By Status", kind: "donut", tableName: "Books", config: { agg: "count", group_by: "status" } },
      { title: "By Genre", kind: "bar", tableName: "Books", config: { agg: "count", group_by: "genre" } },
      { title: "Avg Rating", kind: "stat", tableName: "Books", config: { agg: "avg", field: "rating" } },
    ],
  },
];

export function getTemplate(id: string): AgentBaseTemplate | undefined {
  return AGENTBASE_TEMPLATES.find((t) => t.id === id);
}
