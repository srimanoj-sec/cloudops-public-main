import {
  Activity,
  BookText,
  History,
  Users,
  Bot,
  Boxes,
  Building2,
  FolderTree,
  GitCompareArrows,
  LayoutDashboard,
  Network,
  Plug,
  RefreshCw,
  ShieldCheck,
  ShieldAlert,
  SquareKanban,
  Wallet,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import type { Permission } from '@cloudops/core';

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  end?: boolean;
  /** Only shown to users holding this permission (the page and API enforce it too). */
  permission?: Permission;
}
export interface NavGroup {
  label?: string;
  items: NavItem[];
}

/** Primary navigation, grouped by job-to-be-done. Routes are unchanged. */
export const NAV_GROUPS: NavGroup[] = [
  { items: [{ to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true }] },
  {
    label: 'Estate',
    items: [
      { to: '/organizations', label: 'Organizations', icon: Building2 },
      { to: '/resource-groups', label: 'Resource groups', icon: FolderTree },
      { to: '/inventory', label: 'Inventory', icon: Boxes },
      { to: '/topology', label: 'Topology', icon: Network },
    ],
  },
  {
    label: 'Cost & governance',
    items: [
      { to: '/finops', label: 'FinOps', icon: Wallet },
      { to: '/standards', label: 'Standards', icon: ShieldCheck },
      { to: '/remediation', label: 'Remediation', icon: Wrench },
    ],
  },
  {
    label: 'Operations',
    items: [
      { to: '/operations/syncs', label: 'Sync center', icon: RefreshCw },
      { to: '/operations/drift', label: 'Drift', icon: GitCompareArrows },
      { to: '/insights', label: 'Cloud insights', icon: ShieldAlert },
      { to: '/automation', label: 'Automation', icon: Bot },
    ],
  },
  {
    label: 'Work',
    items: [
      { to: '/work', label: 'Work boards', icon: SquareKanban },
      { to: '/workspaces', label: 'Workspaces', icon: BookText },
    ],
  },
  {
    label: 'Platform',
    items: [
      { to: '/providers', label: 'Providers', icon: Plug },
      { to: '/settings/users', label: 'Users', icon: Users, permission: 'users.manage' },
      { to: '/settings/audit', label: 'Audit log', icon: History, permission: 'audit.read' },
      { to: '/settings/system', label: 'System status', icon: Activity, permission: 'system.read' },
    ],
  },
];

/** The nav entry (and its group) that owns a pathname — drives breadcrumbs. */
export function findNav(pathname: string): { group?: string; item: NavItem } | null {
  for (const g of NAV_GROUPS) {
    for (const item of g.items) {
      const hit = item.end
        ? pathname === item.to
        : pathname === item.to || pathname.startsWith(`${item.to}/`);
      if (hit) return { group: g.label, item };
    }
  }
  return null;
}
