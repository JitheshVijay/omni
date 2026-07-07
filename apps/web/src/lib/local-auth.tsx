// Local-mode auth stub. Omni v1 has no real auth, so the API's onRequest hook
// injects a fixed LOCAL_USER_ID whenever the Bearer token is "local". This
// provider keeps the exact interface shape of Flo101's useAuth() so use-api
// (and anything else copied from Flo101) drops in unchanged: `user` object +
// async `getAccessToken()`.
//
// When AUTH_MODE="supabase" lands in a later phase this file is the only
// swap point on the web side.

import { createContext, useContext, useMemo, type ReactNode } from "react";

export interface LocalUser {
  id: string;
  email: string;
}

export interface AuthContextValue {
  user: LocalUser;
  getAccessToken: () => Promise<string>;
}

const LOCAL_USER: LocalUser = { id: "local", email: "local@omni.dev" };

// Module-level accessor so non-React code (authFetch, SSE client, downloads)
// can attach the Bearer token without threading a hook through.
export async function getLocalAccessToken(): Promise<string> {
  return "local";
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function LocalAuthProvider({ children }: { children: ReactNode }) {
  const value = useMemo<AuthContextValue>(
    () => ({ user: LOCAL_USER, getAccessToken: getLocalAccessToken }),
    [],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <LocalAuthProvider>");
  return ctx;
}
