// Resolve a system/template's stored lucide icon NAME (a string persisted by
// the generator or template) to a rendered lucide component, falling back to a
// generic dashboard glyph for anything unrecognised. Keeps the icon set the LLM
// may emit bounded to a curated, always-renderable map.

import {
  LayoutDashboard,
  Users,
  HeartHandshake,
  Boxes,
  Bug,
  ListChecks,
  CalendarDays,
  Megaphone,
  UserCheck,
  Wallet,
  BookOpen,
  Table2,
  Briefcase,
  Target,
  TrendingUp,
  Package,
  ClipboardList,
  DollarSign,
  Contact,
  type LucideIcon,
} from "lucide-react";

const ICONS: Record<string, LucideIcon> = {
  LayoutDashboard,
  Users,
  HeartHandshake,
  Boxes,
  Bug,
  ListChecks,
  CalendarDays,
  Megaphone,
  UserCheck,
  Wallet,
  BookOpen,
  Table2,
  Briefcase,
  Target,
  TrendingUp,
  Package,
  ClipboardList,
  DollarSign,
  Contact,
};

export function resolveIcon(name: string | undefined): LucideIcon {
  return (name && ICONS[name]) || LayoutDashboard;
}

export function SystemIcon({
  name,
  className,
}: {
  name: string | undefined;
  className?: string;
}) {
  const Icon = resolveIcon(name);
  return <Icon className={className} />;
}
