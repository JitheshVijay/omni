import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/AppSidebar";

// Wraps every routed page in the app sidebar + main content area. Pages
// under the shell own their full height: SidebarInset is a flex-1 <main>,
// so a page that wants an internal scroll region uses h-screen inside it.
export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset>{children}</SidebarInset>
    </SidebarProvider>
  );
}
