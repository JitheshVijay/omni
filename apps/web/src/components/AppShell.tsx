import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/AppSidebar";
import { GlobalSearch } from "@/components/search/GlobalSearch";

// Wraps every routed page in the app sidebar + main content area. Pages
// under the shell own their full height: SidebarInset is a flex-1 <main>,
// so a page that wants an internal scroll region uses h-screen inside it.
// GlobalSearch mounts once here and owns the Cmd/Ctrl+K palette shortcut.
export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset>{children}</SidebarInset>
      <GlobalSearch />
    </SidebarProvider>
  );
}
