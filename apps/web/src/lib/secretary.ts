// Typed client helpers for the AI Secretary (Composio Gmail + Google Calendar)
// over authFetch. All endpoints return the Omni envelope; authFetch unwraps
// `data`. A not-configured backend surfaces as configured:false on /status and
// a ParsedApiError with code "secretary_unconfigured" on /connect.
import { authFetch } from "@/lib/use-api";

export type SecretaryToolkit = "gmail" | "googlecalendar";
export type ConnectionStatus = "pending" | "active" | "error" | "disconnected";

export interface SecretaryConnection {
  toolkit: SecretaryToolkit;
  status: ConnectionStatus;
}

export interface SecretaryStatus {
  configured: boolean;
  connections: SecretaryConnection[];
}

export function getSecretaryStatus(): Promise<SecretaryStatus> {
  return authFetch<SecretaryStatus>("/api/secretary/status");
}

export function connectToolkit(toolkit: SecretaryToolkit): Promise<{ redirectUrl: string }> {
  return authFetch<{ redirectUrl: string }>("/api/secretary/connect", {
    method: "POST",
    body: JSON.stringify({ toolkit }),
  });
}

export function refreshToolkit(
  toolkit: SecretaryToolkit,
): Promise<{ toolkit: SecretaryToolkit; status: ConnectionStatus }> {
  return authFetch<{ toolkit: SecretaryToolkit; status: ConnectionStatus }>(
    "/api/secretary/refresh",
    { method: "POST", body: JSON.stringify({ toolkit }) },
  );
}

export function disconnectToolkit(toolkit: SecretaryToolkit): Promise<{ ok: boolean }> {
  return authFetch<{ ok: boolean }>(`/api/secretary/connections/${toolkit}`, {
    method: "DELETE",
  });
}

export function generateBrief(): Promise<{ run_id: string }> {
  return authFetch<{ run_id: string }>("/api/secretary/brief", { method: "POST" });
}
