// LinkedIn profile scraping via Apify. Runs a configurable Apify actor
// synchronously (run-sync-get-dataset-items) and normalizes the actor's (messy,
// actor-specific) output into a clean LinkedInProfile the agent can hand to a
// generator. Fail-soft: without APIFY_API_KEY it throws a clear, actionable
// message. LinkedIn scraping is against LinkedIn's ToS — the user opts in by
// providing their own Apify key; keep to profiles you're allowed to use.
import { env } from "@omni/env-config";

export interface LinkedInExperience {
  title?: string;
  company?: string;
  dates?: string;
  description?: string;
}
export interface LinkedInEducation {
  school?: string;
  degree?: string;
  field?: string;
  dates?: string;
}
export interface LinkedInProfile {
  url: string;
  name: string;
  headline?: string;
  location?: string;
  about?: string;
  experience: LinkedInExperience[];
  education: LinkedInEducation[];
  skills: string[];
}

// ── normalization helpers (pure, exported for tests) ──────────────────
// Apify LinkedIn actors disagree on field names; pull the first present.
function pick(obj: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}
function asArray(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? (v.filter((x) => x && typeof x === "object") as Record<string, unknown>[]) : [];
}
function firstArray(obj: Record<string, unknown>, ...keys: string[]): Record<string, unknown>[] {
  for (const k of keys) {
    const a = asArray(obj[k]);
    if (a.length) return a;
  }
  return [];
}

/** Normalize a raw dataset item from any of the common LinkedIn actors. */
export function normalizeLinkedIn(raw: Record<string, unknown>, url: string): LinkedInProfile {
  const first = pick(raw, "firstName", "first_name");
  const last = pick(raw, "lastName", "last_name");
  const name =
    pick(raw, "fullName", "full_name", "name", "profileName") ??
    ([first, last].filter(Boolean).join(" ") || "");

  const experience = firstArray(raw, "experiences", "experience", "positions", "workExperience").map(
    (e) => ({
      title: pick(e, "title", "position", "role", "jobTitle"),
      company: pick(e, "company", "companyName", "subtitle", "organisation", "organization"),
      dates: pick(e, "dateRange", "dates", "duration", "caption", "period"),
      description: pick(e, "description", "summary"),
    }),
  );
  const education = firstArray(raw, "educations", "education", "schools").map((e) => ({
    school: pick(e, "school", "schoolName", "title", "institution"),
    degree: pick(e, "degree", "degreeName", "subtitle"),
    field: pick(e, "fieldOfStudy", "field", "fieldName"),
    dates: pick(e, "dateRange", "dates", "duration", "caption", "period"),
  }));

  const rawSkills = raw.skills;
  const skills = Array.isArray(rawSkills)
    ? rawSkills
        .map((s) => (typeof s === "string" ? s : pick(s as Record<string, unknown>, "name", "title") ?? ""))
        .filter(Boolean)
        .slice(0, 40)
    : [];

  return {
    url,
    name,
    headline: pick(raw, "headline", "occupation", "subtitle", "jobTitle", "position"),
    location: pick(raw, "location", "locationName", "geoLocationName", "addressWithCountry", "addressCountryOnly"),
    about: pick(raw, "summary", "about", "description", "bio"),
    experience: experience.filter((e) => e.title || e.company),
    education: education.filter((e) => e.school || e.degree),
    skills,
  };
}

/** Render the profile as a fact block for a generator prompt. */
export function profileToPromptContext(p: LinkedInProfile): string {
  const lines: string[] = [
    `LinkedIn profile data for ${p.url}.`,
    "Use ONLY these real facts. Do NOT invent metrics, dates, counts, or details that are not present here; if something is missing, omit it rather than fabricating a number.",
    "",
    `Name: ${p.name || "(not found)"}`,
  ];
  if (p.headline) lines.push(`Headline: ${p.headline}`);
  if (p.location) lines.push(`Location: ${p.location}`);
  if (p.about) lines.push("", "About:", p.about);
  if (p.experience.length) {
    lines.push("", "Experience:");
    for (const e of p.experience.slice(0, 12)) {
      lines.push(`- ${[e.title, e.company].filter(Boolean).join(" at ")}${e.dates ? ` (${e.dates})` : ""}`);
      if (e.description) lines.push(`  ${e.description.replace(/\s+/g, " ").slice(0, 400)}`);
    }
  }
  if (p.education.length) {
    lines.push("", "Education:");
    for (const e of p.education.slice(0, 8)) {
      lines.push(`- ${[e.degree, e.field].filter(Boolean).join(", ")}${e.school ? ` — ${e.school}` : ""}${e.dates ? ` (${e.dates})` : ""}`);
    }
  }
  if (p.skills.length) lines.push("", `Skills: ${p.skills.join(", ")}`);
  return lines.join("\n");
}

/** Run the configured Apify actor to fetch one public LinkedIn profile. */
export async function scrapeLinkedInProfile(
  profileUrl: string,
  signal?: AbortSignal,
): Promise<LinkedInProfile> {
  const token = env.APIFY_API_KEY;
  if (!token) {
    throw new Error(
      "LinkedIn scraping isn't configured. Add APIFY_API_KEY (and optionally APIFY_LINKEDIN_ACTOR) to ~/omni/.env and restart the API.",
    );
  }
  const actor = env.APIFY_LINKEDIN_ACTOR;
  const endpoint = `https://api.apify.com/v2/acts/${actor}/run-sync-get-dataset-items?token=${encodeURIComponent(token)}`;

  const timeout = AbortSignal.timeout(120_000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ profileUrls: [profileUrl] }),
    signal: combined,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Apify actor "${actor}" returned HTTP ${res.status}. ${body.slice(0, 200)}`.trim(),
    );
  }
  const items = (await res.json()) as unknown;
  const first = Array.isArray(items) ? (items[0] as Record<string, unknown> | undefined) : undefined;
  if (!first) {
    throw new Error(
      "The actor returned no data — the profile may be private, the URL may be wrong, or the actor may need a different input. Check APIFY_LINKEDIN_ACTOR.",
    );
  }
  const profile = normalizeLinkedIn(first, profileUrl);
  if (!profile.name && profile.experience.length === 0) {
    throw new Error(
      "The actor returned data in an unexpected shape (no name or experience parsed). It may use different field names than expected.",
    );
  }
  return profile;
}
