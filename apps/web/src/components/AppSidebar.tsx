import { Link, useLocation } from "react-router-dom";
import {
  MessageSquare,
  FolderKanban,
  HardDrive,
  LibraryBig,
  Bot,
  FileSearch,
  GitBranch,
  Mail,
  Wrench,
  Sparkles,
  LayoutDashboard,
  Blocks,
  Settings as SettingsIcon,
  Sun,
  Moon,
  Monitor,
} from "lucide-react";
import { useTheme } from "@/components/theme";
import { cn } from "@/lib/utils";

type IconCmp = React.ComponentType<{ className?: string }>;

interface NavEntry {
  href: string;
  label: string;
  icon: IconCmp;
}

// A thin Genspark-style icon rail: each item is an icon stacked over a tiny
// label, centered in a fixed narrow column. Active route gets a lifted chip.
const NAV: NavEntry[] = [
  { href: "/chat", label: "Chat", icon: MessageSquare },
  { href: "/hubs", label: "Hubs", icon: FolderKanban },
  { href: "/drive", label: "Drive", icon: HardDrive },
  { href: "/library", label: "Library", icon: LibraryBig },
  { href: "/agent", label: "Agent", icon: Bot },
  { href: "/research", label: "Research", icon: FileSearch },
  { href: "/workflows", label: "Flows", icon: GitBranch },
  { href: "/secretary", label: "Secretary", icon: Mail },
  { href: "/tools", label: "Tools", icon: Wrench },
  { href: "/skills", label: "Skills", icon: Sparkles },
  { href: "/agentbase", label: "Systems", icon: LayoutDashboard },
  { href: "/connectors", label: "Connect", icon: Blocks },
];

function RailItem({
  href,
  label,
  icon: Icon,
  active,
}: NavEntry & { active: boolean }) {
  return (
    <li className="list-none">
      <Link
        to={href}
        title={label}
        className={cn(
          "group flex w-full flex-col items-center gap-1 rounded-xl px-1 py-2 text-[10px] font-medium leading-none transition-colors outline-none focus-visible:ring-2 focus-visible:ring-accent/50",
          active
            ? "bg-surface3 text-ink"
            : "text-muted hover:bg-surface3/60 hover:text-ink",
        )}
      >
        <Icon
          className={cn(
            "size-[18px] transition-colors",
            active ? "text-accent" : "text-muted group-hover:text-ink",
          )}
        />
        <span className="max-w-full truncate">{label}</span>
      </Link>
    </li>
  );
}

export function AppSidebar() {
  const pathname = useLocation().pathname;

  return (
    <aside className="sticky top-0 flex h-screen w-[76px] shrink-0 flex-col items-center border-r border-line bg-surface2">
      {/* Brand mark */}
      <Link
        to="/chat"
        aria-label="Omni home"
        className="mt-3 grid size-10 shrink-0 place-items-center rounded-xl brand-ribbon font-display text-base font-bold text-white outline-none transition hover:scale-105 focus-visible:ring-2 focus-visible:ring-accent/50"
      >
        O
      </Link>

      {/* Nav rail */}
      <nav className="mt-4 w-full flex-1 overflow-y-auto no-scrollbar px-2">
        <ul className="flex flex-col gap-1">
          {NAV.map((item) => (
            <RailItem
              key={item.href}
              {...item}
              active={pathname.startsWith(item.href)}
            />
          ))}
        </ul>
      </nav>

      {/* Footer: settings + theme toggle */}
      <div className="w-full px-2 pb-3">
        <ul className="flex flex-col gap-1">
          <RailItem
            href="/settings"
            label="Settings"
            icon={SettingsIcon}
            active={pathname.startsWith("/settings")}
          />
          <ThemeToggleRailItem />
        </ul>
      </div>
    </aside>
  );
}

// Theme toggle styled as a rail item: cycles light → dark → system.
function ThemeToggleRailItem() {
  const { theme, toggle } = useTheme();
  const Icon = theme === "dark" ? Moon : theme === "light" ? Sun : Monitor;
  const label = theme === "dark" ? "Dark" : theme === "light" ? "Light" : "System";
  return (
    <li className="list-none">
      <button
        type="button"
        onClick={toggle}
        title={`Theme: ${label}`}
        className="group flex w-full flex-col items-center gap-1 rounded-xl px-1 py-2 text-[10px] font-medium leading-none text-muted transition-colors outline-none hover:bg-surface3/60 hover:text-ink focus-visible:ring-2 focus-visible:ring-accent/50"
      >
        <Icon className="size-[18px] text-muted transition-colors group-hover:text-ink" />
        <span className="max-w-full truncate">{label}</span>
      </button>
    </li>
  );
}
