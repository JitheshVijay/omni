// Client-side provider tree: Theme > LocalAuth > SWRConfig > Tooltip >
// Confirm. SWR config rationale (mirrors Flo101):
//   - dedupingInterval 30s: the same endpoint hit twice within the window
//     (e.g. the thread list on rapid navigation) serves from cache.
//   - revalidateOnFocus / revalidateOnReconnect: coming back to the tab
//     refreshes data; cheap and users expect it.
//   - shouldRetryOnError false: API errors are usually intentional (400,
//     404); retrying spams the user and obscures the original failure.

import { SWRConfig } from "swr";
import { ThemeProvider } from "@/components/theme";
import { LocalAuthProvider } from "@/lib/local-auth";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";

export function AppProviders({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider>
      <LocalAuthProvider>
        <SWRConfig
          value={{
            dedupingInterval: 30_000,
            revalidateOnFocus: true,
            revalidateOnReconnect: true,
            shouldRetryOnError: false,
          }}
        >
          <TooltipProvider delayDuration={300}>
            <ConfirmProvider>{children}</ConfirmProvider>
          </TooltipProvider>
        </SWRConfig>
      </LocalAuthProvider>
    </ThemeProvider>
  );
}
