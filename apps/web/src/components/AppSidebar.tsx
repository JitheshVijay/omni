import { Link, useLocation } from "react-router-dom";
import {
  MessageSquare,
  FolderKanban,
  HardDrive,
  LibraryBig,
  Bot,
  GitBranch,
  Wrench,
  Settings as SettingsIcon,
  Sun,
  Moon,
  Monitor,
} from "lucide-react";
import { useTheme } from "@/components/theme";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarLabel,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";

type IconCmp = React.ComponentType<{ className?: string }>;

interface NavEntry {
  href: string;
  label: string;
  icon: IconCmp;
  /** "soon" chip — surface exists but the real feature lands in a later phase. */
  soon?: boolean;
  /** Fully disabled — no route yet; renders as a non-interactive row. */
  disabled?: boolean;
}

const NAV: NavEntry[] = [
  { href: "/chat", label: "Chat", icon: MessageSquare },
  { href: "/hubs", label: "Hubs", icon: FolderKanban },
  { href: "/drive", label: "Drive", icon: HardDrive },
  { href: "/library", label: "Library", icon: LibraryBig },
  { href: "/agent", label: "Agent", icon: Bot },
  { href: "/workflows", label: "Workflows", icon: GitBranch },
  { href: "/tools", label: "Tools", icon: Wrench },
];

function SoonBadge() {
  return (
    <span className="ml-auto rounded-full bg-accent/10 px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-accent">
      soon
    </span>
  );
}

export function AppSidebar() {
  const pathname = useLocation().pathname;
  const { collapsed } = useSidebar();

  return (
    <Sidebar>
      <SidebarHeader className={cn(collapsed && "justify-center px-0")}>
        <Link
          to="/chat"
          className="flex min-w-0 items-center gap-2 outline-none focus-visible:ring-2 focus-visible:ring-accent/50 rounded-md"
          aria-label="Omni home"
        >
          {/* Brand mark: gradient tile + wordmark. The tile alone carries the
              brand when the rail is collapsed. */}
          <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-accent to-accent2 font-display text-sm font-bold text-white shadow-sm">
            O
          </span>
          <SidebarLabel className="font-display text-lg font-semibold tracking-tight text-ink">
            Omni
          </SidebarLabel>
        </Link>
        {!collapsed && <SidebarTrigger className="ml-auto" />}
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup label="Workspace">
          {NAV.map((item) => {
            const Icon = item.icon;
            const active = pathname.startsWith(item.href);
            if (item.disabled) {
              return (
                <SidebarMenuItem key={item.href}>
                  <SidebarMenuButton
                    tooltip={`${item.label} — coming soon`}
                    disabled
                    aria-disabled
                    className="cursor-default opacity-60 hover:bg-transparent hover:text-muted"
                  >
                    <Icon className="size-4 shrink-0" />
                    <SidebarLabel className="flex-1 text-left">{item.label}</SidebarLabel>
                    {item.soon && !collapsed && <SoonBadge />}
                  </SidebarMenuButton>
                </SidebarMenuItem>
              );
            }
            return (
              <SidebarMenuItem key={item.href}>
                <SidebarMenuButton asChild isActive={active} tooltip={item.label}>
                  <Link to={item.href} className="flex w-full items-center gap-2">
                    <Icon className="size-4 shrink-0" />
                    <SidebarLabel className="flex-1 text-left">{item.label}</SidebarLabel>
                    {item.soon && !collapsed && <SoonBadge />}
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            );
          })}
        </SidebarGroup>
        {collapsed && (
          <div className="mt-2 flex justify-center">
            <SidebarTrigger />
          </div>
        )}
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenuItem>
          <SidebarMenuButton
            asChild
            isActive={pathname.startsWith("/settings")}
            tooltip="Settings"
          >
            <Link to="/settings" className="flex w-full items-center gap-2">
              <SettingsIcon className="size-4 shrink-0" />
              <SidebarLabel>Settings</SidebarLabel>
            </Link>
          </SidebarMenuButton>
        </SidebarMenuItem>
        <ThemeToggleItem />
      </SidebarFooter>
    </Sidebar>
  );
}

// Theme toggle: cycles light → dark → system. Three states keep the user's
// explicit preference distinct from "respect my OS".
function ThemeToggleItem() {
  const { theme, toggle } = useTheme();
  const Icon = theme === "dark" ? Moon : theme === "light" ? Sun : Monitor;
  const label =
    theme === "dark" ? "Dark mode" : theme === "light" ? "Light mode" : "System theme";
  return (
    <SidebarMenuItem>
      <SidebarMenuButton onClick={toggle} tooltip={label} variant="ghost">
        <Icon className="size-4 shrink-0" />
        <SidebarLabel>{label}</SidebarLabel>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}
