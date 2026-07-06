// Custom Agents store client: the AgentPreset type + thin authFetch wrappers
// over the /api/agent-presets routes. The list endpoint is also read via
// useApi() (SWR) on the page; these helpers cover the mutations and the launch
// handoff (which starts a real agent run and returns its id).

import { authFetch } from "@/lib/use-api";

export const PRESET_CATEGORIES = [
  "Research",
  "Business",
  "Content",
  "Personal",
  "Ops",
] as const;
export type PresetCategory = (typeof PRESET_CATEGORIES)[number];

export interface AgentPreset {
  id: string;
  user_id: string;
  name: string;
  description: string;
  category: PresetCategory;
  /** A lucide icon name string used to render the card badge. */
  icon: string;
  /** Gradient utility classes tinting the card badge. */
  accent: string;
  /** The agent goal; may contain a single {{input}} placeholder. */
  goal_template: string;
  budget_usd: number;
  publisher: string;
  is_builtin: number;
  created_at: string;
  updated_at: string;
}

export interface CreatePresetBody {
  name: string;
  description?: string;
  category?: PresetCategory;
  icon?: string;
  accent?: string;
  goal_template: string;
  budget_usd?: number;
}

export interface ListPresetsParams {
  tab?: "community" | "mine";
  category?: PresetCategory;
  q?: string;
}

/** Build the query string the list endpoint (and its SWR key) expects. */
export function presetsQuery(params: ListPresetsParams): string {
  const sp = new URLSearchParams();
  if (params.tab) sp.set("tab", params.tab);
  if (params.category) sp.set("category", params.category);
  if (params.q && params.q.trim()) sp.set("q", params.q.trim());
  const qs = sp.toString();
  return `/api/agent-presets${qs ? `?${qs}` : ""}`;
}

/** Does this preset's goal template take a {{input}} topic? */
export function presetNeedsInput(preset: AgentPreset): boolean {
  return /\{\{\s*input\s*\}\}/.test(preset.goal_template);
}

export function listPresets(params: ListPresetsParams = {}): Promise<{ presets: AgentPreset[] }> {
  return authFetch<{ presets: AgentPreset[] }>(presetsQuery(params));
}

export function createPreset(body: CreatePresetBody): Promise<AgentPreset> {
  return authFetch<AgentPreset>("/api/agent-presets", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function deletePreset(id: string): Promise<{ deleted: boolean }> {
  return authFetch<{ deleted: boolean }>(`/api/agent-presets/${id}`, { method: "DELETE" });
}

/** Launch a preset — starts a real agent run and returns its id. */
export function launchPreset(id: string, input?: string): Promise<{ run_id: string }> {
  return authFetch<{ run_id: string }>(`/api/agent-presets/${id}/launch`, {
    method: "POST",
    body: JSON.stringify({ input: input ?? "" }),
  });
}
