// Skills library client: the Skill type + thin authFetch wrappers over the
// /api/skills routes. The list endpoint is also read via useApi() (SWR) on the
// page; these helpers cover the mutations and the run handoff.

import { authFetch } from "@/lib/use-api";

export const SKILL_ROLES = [
  "Sales",
  "Marketer",
  "Product",
  "Researcher",
  "Designer",
  "Engineer",
  "Founder",
  "General",
] as const;
export type SkillRole = (typeof SKILL_ROLES)[number];

export const SKILL_OUTPUTS = ["doc", "slides", "sheet", "image", "chat", "data"] as const;
export type SkillOutput = (typeof SKILL_OUTPUTS)[number];

export interface Skill {
  id: string;
  user_id: string;
  name: string;
  description: string;
  publisher: string;
  role: SkillRole;
  output: SkillOutput;
  /** A generator name or 'chat'. */
  target: string;
  prompt_template: string;
  /** Gradient utility classes tinting the card preview. */
  accent: string;
  is_builtin: number;
  created_at: string;
  updated_at: string;
}

export interface CreateSkillBody {
  name: string;
  description?: string;
  role?: SkillRole;
  output?: SkillOutput;
  target?: string;
  prompt_template: string;
}

export interface ListSkillsParams {
  tab?: "community" | "mine";
  q?: string;
  role?: SkillRole;
  output?: SkillOutput;
}

/** The resolved seed returned by POST /api/skills/:id/run. */
export interface SkillRunResult {
  target: string;
  /** A registered generator name, or undefined when the target is chat. */
  generator?: string;
  /** prompt_template with {{input}} substituted. */
  prompt: string;
}

/** Build the query string the list endpoint (and its SWR key) expects. */
export function skillsQuery(params: ListSkillsParams): string {
  const sp = new URLSearchParams();
  if (params.tab) sp.set("tab", params.tab);
  if (params.q && params.q.trim()) sp.set("q", params.q.trim());
  if (params.role) sp.set("role", params.role);
  if (params.output) sp.set("output", params.output);
  const qs = sp.toString();
  return `/api/skills${qs ? `?${qs}` : ""}`;
}

export function listSkills(params: ListSkillsParams = {}): Promise<{ skills: Skill[] }> {
  return authFetch<{ skills: Skill[] }>(skillsQuery(params));
}

export function createSkill(body: CreateSkillBody): Promise<Skill> {
  return authFetch<Skill>("/api/skills", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function deleteSkill(id: string): Promise<{ deleted: boolean }> {
  return authFetch<{ deleted: boolean }>(`/api/skills/${id}`, { method: "DELETE" });
}

export function runSkill(id: string, input?: string): Promise<SkillRunResult> {
  return authFetch<SkillRunResult>(`/api/skills/${id}/run`, {
    method: "POST",
    body: JSON.stringify({ input: input ?? "" }),
  });
}
