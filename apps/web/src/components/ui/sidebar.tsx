import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { PanelLeft, Menu, X } from "lucide-react";
import { cva, type VariantProps } from "class-variance-authority";
import { useLocation } from "react-router-dom";
import { cn } from "@/lib/utils";

// Focused subset of shadcn's sidebar, adapted from Flo101: fixed rail on
// desktop, overlay drawer on mobile. Collapse toggle is desktop-only; the
// mobile drawer always renders full-label. Collapsed state persists to
// localStorage. The mobile drawer is a lightweight inline overlay (backdrop
// + translating panel) instead of a separate Sheet primitive.

const SIDEBAR_WIDTH = "15rem";
const SIDEBAR_WIDTH_ICON = "3.5rem";
const STORAGE_KEY = "omni.sidebar.collapsed";

interface SidebarContextValue {
  collapsed: boolean;
  setCollapsed: (v: boolean) => void;
  toggle: () => void;
  mobileOpen: boolean;
  setMobileOpen: (v: boolean) => void;
}

const SidebarContext = React.createContext<SidebarContextValue | null>(null);

export function useSidebar() {
  const ctx = React.useContext(SidebarContext);
  if (!ctx) throw new Error("useSidebar must be used inside <SidebarProvider>");
  return ctx;
}

export function SidebarProvider({
  defaultCollapsed = false,
  children,
}: {
  defaultCollapsed?: boolean;
  children: React.ReactNode;
}) {
  const [collapsed, setCollapsedState] = React.useState(defaultCollapsed);
  const [mobileOpen, setMobileOpen] = React.useState(false);
  const pathname = useLocation().pathname;

  // Hydrate from localStorage post-mount.
  React.useEffect(() => {
    try {
      const v = window.localStorage.getItem(STORAGE_KEY);
      if (v === "1") setCollapsedState(true);
      if (v === "0") setCollapsedState(false);
    } catch {
      // ignore
    }
  }, []);
  const setCollapsed = React.useCallback((v: boolean) => {
    setCollapsedState(v);
    try {
      window.localStorage.setItem(STORAGE_KEY, v ? "1" : "0");
    } catch {
      // ignore
    }
  }, []);
  const toggle = React.useCallback(
    () => setCollapsed(!collapsed),
    [collapsed, setCollapsed],
  );

  // Auto-close the mobile drawer on route change so navigating from it
  // dismisses it without an extra tap.
  React.useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  return (
    <SidebarContext.Provider
      value={{ collapsed, setCollapsed, toggle, mobileOpen, setMobileOpen }}
    >
      <div
        style={
          {
            "--sidebar-width": SIDEBAR_WIDTH,
            "--sidebar-width-icon": SIDEBAR_WIDTH_ICON,
          } as React.CSSProperties
        }
        className="flex min-h-screen w-full bg-surface text-ink"
      >
        {children}
        <MobileSidebarTrigger />
      </div>
    </SidebarContext.Provider>
  );
}

export function Sidebar({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  const { collapsed, mobileOpen, setMobileOpen } = useSidebar();

  // ESC closes the mobile drawer.
  React.useEffect(() => {
    if (!mobileOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMobileOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mobileOpen, setMobileOpen]);

  return (
    <>
      {/* Desktop rail, hidden under lg, where the mobile drawer takes over. */}
      <aside
        data-collapsed={collapsed}
        className={cn(
          "hidden lg:flex sticky top-0 h-screen shrink-0 flex-col border-r border-line bg-surface transition-[width] duration-200 ease-out",
          collapsed ? "w-[var(--sidebar-width-icon)]" : "w-[var(--sidebar-width)]",
          className,
        )}
      >
        {children}
      </aside>

      {/* Mobile drawer: same children inside an override provider that
          forces collapsed=false so labels always render. */}
      {mobileOpen && (
        <div className="lg:hidden fixed inset-0 z-50" role="dialog" aria-modal="true">
          <div
            className="absolute inset-0 bg-black/40 anim-fade-in"
            onClick={() => setMobileOpen(false)}
          />
          <div className="absolute left-0 top-0 h-full w-[var(--sidebar-width)] max-w-[85vw] border-r border-line bg-surface flex flex-col">
            <button
              onClick={() => setMobileOpen(false)}
              aria-label="Close menu"
              className="absolute right-2 top-2.5 z-10 rounded-md p-1.5 text-muted hover:bg-ink/5 hover:text-ink transition"
            >
              <X className="size-4" />
            </button>
            <MobileSidebarOverride>{children}</MobileSidebarOverride>
          </div>
        </div>
      )}
    </>
  );
}

// Inside the mobile drawer, force-disable the collapsed state so labels and
// groups render at full width regardless of the desktop preference.
function MobileSidebarOverride({ children }: { children: React.ReactNode }) {
  const ctx = useSidebar();
  const value = React.useMemo(() => ({ ...ctx, collapsed: false }), [ctx]);
  return (
    <SidebarContext.Provider value={value}>
      <div className="h-full flex flex-col">{children}</div>
    </SidebarContext.Provider>
  );
}

// Floating hamburger that opens the mobile drawer. lg+ users never see it.
function MobileSidebarTrigger() {
  const { mobileOpen, setMobileOpen } = useSidebar();
  return (
    <button
      onClick={() => setMobileOpen(!mobileOpen)}
      aria-label="Open menu"
      className="lg:hidden fixed top-3 left-3 z-40 inline-flex size-9 items-center justify-center rounded-lg border border-line bg-surface2/95 backdrop-blur text-ink hover:bg-surface2 transition"
    >
      <Menu className="size-4" />
    </button>
  );
}

export function SidebarHeader({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex items-center gap-2 px-3 py-3 border-b border-line", className)}>
      {children}
    </div>
  );
}

export function SidebarContent({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex-1 overflow-y-auto scrollbar-thin py-3", className)}>
      {children}
    </div>
  );
}

export function SidebarFooter({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  // Children are <li> (SidebarMenuItem); wrap in <ul> so browsers don't
  // apply default list-item margins (Safari) and markers are suppressed.
  return (
    <div className={cn("border-t border-line p-2", className)}>
      <ul className="flex flex-col gap-0.5">{children}</ul>
    </div>
  );
}

export function SidebarGroup({
  children,
  label,
}: {
  children: React.ReactNode;
  label?: string;
}) {
  const { collapsed } = useSidebar();
  return (
    <div className="px-2 py-1">
      {label && !collapsed && (
        <div className="px-2 pb-1.5 pt-2 text-[10px] font-medium uppercase tracking-wider text-muted/70">
          {label}
        </div>
      )}
      <ul className="flex flex-col gap-0.5">{children}</ul>
    </div>
  );
}

const menuButtonVariants = cva(
  "group relative flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-sm transition outline-none focus-visible:ring-2 focus-visible:ring-accent/50",
  {
    variants: {
      variant: {
        default:
          "text-muted hover:bg-ink/5 hover:text-ink data-[active=true]:bg-accent/10 data-[active=true]:text-accent data-[active=true]:font-medium",
        ghost: "text-muted hover:bg-ink/5 hover:text-ink",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export const SidebarMenuButton = React.forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement> &
    VariantProps<typeof menuButtonVariants> & {
      asChild?: boolean;
      isActive?: boolean;
      tooltip?: string;
    }
>(function SidebarMenuButton(
  { asChild, variant, isActive, tooltip, className, children, ...props },
  ref,
) {
  const { collapsed } = useSidebar();
  const Comp = asChild ? Slot : "button";
  return (
    <Comp
      ref={ref as React.Ref<HTMLButtonElement>}
      data-active={isActive ? "true" : undefined}
      title={collapsed && tooltip ? tooltip : undefined}
      className={cn(menuButtonVariants({ variant }), collapsed && "justify-center px-0", className)}
      {...props}
    >
      {children}
    </Comp>
  );
});

export function SidebarMenuItem({ children }: { children: React.ReactNode }) {
  return <li className="list-none">{children}</li>;
}

// Collapse/expand button (desktop rail).
export function SidebarTrigger({ className }: { className?: string }) {
  const { toggle, collapsed } = useSidebar();
  return (
    <button
      onClick={toggle}
      aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
      className={cn(
        "inline-flex size-8 items-center justify-center rounded-md text-muted hover:bg-ink/5 hover:text-ink transition",
        className,
      )}
    >
      <PanelLeft className="size-4" />
    </button>
  );
}

// The main content beside the sidebar.
export function SidebarInset({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <main className={cn("flex-1 min-w-0", className)}>{children}</main>;
}

// Hide labels when collapsed.
export function SidebarLabel({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  const { collapsed } = useSidebar();
  if (collapsed) return null;
  return <span className={cn("truncate", className)}>{children}</span>;
}
