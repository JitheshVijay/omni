import { AppSidebar } from "@/components/AppSidebar";
import { GlobalSearch } from "@/components/search/GlobalSearch";

// App frame: a fixed Genspark-style icon rail on the left + the routed page
// filling the rest. GlobalSearch mounts once here and owns the Cmd/Ctrl+K
// palette. Pages under the shell own their full height (the <main> is a
// flex-1 min-h-screen column).
export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen w-full bg-surface text-ink">
      <AppSidebar />
      <main className="min-w-0 flex-1">{children}</main>
      <GlobalSearch />
    </div>
  );
}
