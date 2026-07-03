// Agent tool contract. Hand-written tools (web_search, run_code, …) and
// generator-adapter tools (create_doc, …) both implement AgentTool; the
// orchestrator treats them uniformly.
//
// kind drives the confirmation gate:
//   read            — executes immediately, no side effects
//   write_internal  — executes immediately (drive writes / image gen ARE
//                     the run's purpose), but a DESTRUCTIVE_LABEL match
//                     still stages a card
//   write_external  — always suspends for a confirm card before running
//
// A tool may reclassify per-call via classify() (run_code with
// allow_network becomes write_external).

export interface ToolResult {
  /** What the model sees as the tool message content. */
  content: string;
  /** Artifacts produced this call — the loop emits artifact_created + links run_id. */
  artifacts?: { artifactId: string }[];
}

export interface AgentToolCtx {
  runId: string;
  userId: string;
  signal: AbortSignal;
  /** Absolute path to ${DATA_DIR}/runs/<runId>/workspace (run_code cwd). */
  workspaceDir: string;
  /** Publish a sub-progress SSE event (rarely used; kept generic). */
  emit: (evt: Record<string, unknown>) => void;
  hubId?: string | null;
}

export interface AgentTool {
  name: string;
  description: string;
  /** Raw JSON Schema object for the OpenAI `tools[].function.parameters`. */
  parameters: Record<string, unknown>;
  kind: "read" | "write_internal" | "write_external";
  /** Human label for the tool_call event, e.g. "Searching the web for 'X'". */
  label(args: Record<string, unknown>): string;
  /** Cap on the content returned to the model (default 8000). */
  maxResultChars?: number;
  /** Wall-clock timeout for execute (default 60000ms). */
  timeoutMs?: number;
  /** Run the tool. Absent for loop-intercepted tools (update_plan, ask_user). */
  execute?(args: Record<string, unknown>, ctx: AgentToolCtx): Promise<ToolResult>;
  /** Long-form description used on a confirmation card. */
  describe?(args: Record<string, unknown>): Promise<string>;
  /** Post-confirmation execution when it differs from execute (unused v1). */
  confirmedExecute?(args: Record<string, unknown>, ctx: AgentToolCtx): Promise<ToolResult>;
  /** Per-call reclassification override (e.g. run_code + allow_network). */
  classify?(args: Record<string, unknown>): AgentTool["kind"];
}

export const DEFAULT_MAX_RESULT_CHARS = 8000;
export const DEFAULT_TOOL_TIMEOUT_MS = 60_000;

// Backstop: even a write_internal tool whose label reads as destructive
// gets staged for confirmation. Matches delete/remove/overwrite/etc.
export const DESTRUCTIVE_LABEL =
  /\b(delete|deleting|remove|removing|overwrite|overwriting|erase|erasing|drop|dropping|destroy|destroying|wipe|wiping|truncate|purge)\b/i;

/** Effective kind for one call (honours a tool's classify override). */
export function effectiveKind(tool: AgentTool, args: Record<string, unknown>): AgentTool["kind"] {
  return tool.classify ? tool.classify(args) : tool.kind;
}
