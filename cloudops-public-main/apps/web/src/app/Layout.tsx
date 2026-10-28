import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import {
  Building2,
  ChevronRight,
  ChevronsUpDown,
  KeyRound,
  LogOut,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  X,
  MonitorSmartphone,
} from 'lucide-react';
import { useAuth, usePermissions } from '../lib/auth';
import { useOrg } from '../lib/orgContext';
import { useOrganizations } from '../lib/queries';
import { useMediaQuery } from '../lib/useMediaQuery';
import { IconButton, Select, Tooltip, cn } from '../components/ui/primitives';
import { LogoMark, Wordmark } from '../components/ui/Logo';
import { useFocusTrap } from '../components/ui/useFocusTrap';
import { NAV_GROUPS, findNav, type NavItem } from './navigation';
import { ChangePasswordDialog } from '../features/account/ChangePasswordDialog';
import { SessionsDialog } from '../features/account/SessionsDialog';
import { NotificationBell } from '../features/notifications/NotificationBell';
import { CreateWorkProvider } from '../features/work/CreateWork';
import { CommandPaletteProvider, useCommandPalette } from './CommandPalette';

/* ── Search trigger (opens the command palette) ────────────────────────────── */

function SearchTrigger() {
  const { open } = useCommandPalette();
  const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
  return (
    <button
      type="button"
      onClick={() => open()}
      aria-label="Search and commands"
      aria-keyshortcuts={mac ? 'Meta+K' : 'Control+K'}
      className="flex h-9 items-center gap-2 rounded-sm border border-line bg-surface px-2.5 text-body-sm text-fg-muted transition-colors duration-150 hover:border-line-strong hover:text-fg-secondary md:w-64 lg:w-80"
    >
      <Search className="size-4 shrink-0" aria-hidden />
      <span className="hidden flex-1 truncate text-left md:inline">
        Search resources, ids, work…
      </span>
      <kbd className="hidden rounded-xs border border-line-strong bg-raised px-1.5 font-mono text-[10px] leading-4 text-fg-muted md:inline">
        {mac ? '⌘' : 'Ctrl'} K
      </kbd>
    </button>
  );
}

const SIDEBAR_KEY = 'cloudops.sidebar';

/* ── Organization scope ────────────────────────────────────────────────────── */

function OrgSwitcher() {
  const { tenantId, setTenantId } = useOrg();
  const orgs = useOrganizations();
  // Hide until there's a real choice to make (0 or 1 org = nothing to switch).
  if (!orgs.data || orgs.data.length < 2) return null;
  return (
    <Select
      controlSize="sm"
      icon={Building2}
      value={tenantId}
      onChange={(e) => setTenantId(e.target.value)}
      aria-label="Organization scope"
      title="Scope the whole app to one organization"
      selectClassName={cn('max-w-[9.5rem] sm:max-w-[16rem]', tenantId && 'border-accent/40')}
    >
      <option value="">All organizations</option>
      {orgs.data.map((o) => (
        <option key={o.id} value={o.id}>
          {o.name}
        </option>
      ))}
    </Select>
  );
}

/* ── Navigation ────────────────────────────────────────────────────────────── */

function NavItemLink({
  item,
  rail,
  onNavigate,
}: {
  item: NavItem;
  rail: boolean;
  onNavigate?: () => void;
}) {
  const link = (
    <NavLink
      to={item.to}
      end={item.end}
      onClick={onNavigate}
      aria-label={rail ? item.label : undefined}
      className={({ isActive }) =>
        cn(
          'group relative flex h-9 w-full items-center gap-3 rounded-sm text-body font-medium transition-colors duration-150',
          rail ? 'justify-center' : 'px-2.5',
          isActive ? 'bg-raised text-fg' : 'text-fg-secondary hover:bg-hover/60 hover:text-fg',
        )
      }
    >
      {({ isActive }) => (
        <>
          <span
            aria-hidden
            className={cn(
              'absolute -left-2.5 bottom-2 top-2 w-[3px] rounded-r-full bg-accent transition-opacity duration-150',
              isActive ? 'opacity-100' : 'opacity-0',
            )}
          />
          <item.icon
            className={cn(
              'size-[18px] transition-colors duration-150',
              isActive ? 'text-accent' : 'text-fg-muted group-hover:text-fg-secondary',
            )}
            aria-hidden
          />
          {!rail && <span className="truncate">{item.label}</span>}
        </>
      )}
    </NavLink>
  );
  return rail ? (
    <Tooltip content={item.label} side="right" className="w-full">
      {link}
    </Tooltip>
  ) : (
    link
  );
}

function NavList({ rail, onNavigate }: { rail: boolean; onNavigate?: () => void }) {
  const { can } = usePermissions();
  const groups = NAV_GROUPS.map((g) => ({
    ...g,
    items: g.items.filter((i) => !i.permission || can(i.permission)),
  })).filter((g) => g.items.length > 0);
  return (
    <nav aria-label="Primary" className="flex-1 overflow-y-auto overflow-x-hidden px-2.5 py-4">
      {groups.map((g, gi) => (
        <div key={gi} className={gi > 0 ? 'mt-5' : ''}>
          {g.label &&
            (rail ? (
              <div aria-hidden className="mx-2 mb-3 h-px bg-line" />
            ) : (
              <div className="mb-1.5 px-2.5 font-mono text-overline uppercase text-fg-muted">
                {g.label}
              </div>
            ))}
          <ul className="space-y-0.5">
            {g.items.map((item) => (
              <li key={item.to}>
                <NavItemLink item={item} rail={rail} onNavigate={onNavigate} />
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}

/* ── Account menu ──────────────────────────────────────────────────────────── */

function initials(name: string): string {
  const parts = name.split(/[\s@._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || '?';
}

function UserMenu({ rail }: { rail: boolean }) {
  const { user, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const [changingPassword, setChangingPassword] = useState(false);
  const [viewingSessions, setViewingSessions] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const name = user?.name || user?.email || 'Account';
  const roles = user?.roles.join(', ') ?? '';

  useEffect(() => {
    if (!open) return;
    ref.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const avatar = (
    <span
      aria-hidden
      className="grid size-8 shrink-0 place-items-center rounded-sm border border-line-strong bg-raised font-mono text-caption font-medium text-fg-secondary"
    >
      {initials(name)}
    </span>
  );

  return (
    <div ref={ref} className="relative">
      <button
        ref={trigger}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={rail ? `Account: ${name}` : undefined}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'flex w-full items-center gap-2.5 rounded-sm p-1 text-left transition-colors duration-150 hover:bg-hover/60',
          rail && 'justify-center',
        )}
      >
        {avatar}
        {!rail && (
          <>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-body-sm font-medium text-fg">{name}</span>
              <span className="block truncate text-caption text-fg-muted">{roles}</span>
            </span>
            <ChevronsUpDown className="size-4 text-fg-muted" aria-hidden />
          </>
        )}
      </button>
      {open && (
        <div
          role="menu"
          aria-label="Account"
          className={cn(
            'absolute bottom-full z-40 mb-2 origin-bottom-left animate-pop-in rounded-md border border-line-strong bg-overlay p-1.5 shadow-2',
            rail ? 'left-0 w-64' : 'inset-x-0',
          )}
        >
          <div className="mb-1 border-b border-line px-2.5 pb-2.5 pt-1.5">
            <div className="truncate text-body-sm font-medium text-fg">
              {user?.name || 'Signed in'}
            </div>
            {user?.email && <div className="truncate text-caption text-fg-muted">{user.email}</div>}
            {roles && (
              <div className="mt-1.5 font-mono text-overline uppercase text-accent/90">{roles}</div>
            )}
          </div>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              setChangingPassword(true);
            }}
            className="flex h-8 w-full items-center gap-2.5 rounded-sm px-2.5 text-body-sm text-fg-secondary transition-colors duration-150 hover:bg-hover hover:text-fg focus-visible:bg-hover focus-visible:outline-none"
          >
            <KeyRound className="size-4" aria-hidden />
            Change password
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              setViewingSessions(true);
            }}
            className="flex h-8 w-full items-center gap-2.5 rounded-sm px-2.5 text-body-sm text-fg-secondary transition-colors duration-150 hover:bg-hover hover:text-fg focus-visible:bg-hover focus-visible:outline-none"
          >
            <MonitorSmartphone className="size-4" aria-hidden />
            Signed-in devices
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={logout}
            className="flex h-8 w-full items-center gap-2.5 rounded-sm px-2.5 text-body-sm text-fg-secondary transition-colors duration-150 hover:bg-hover hover:text-fg focus-visible:bg-hover focus-visible:outline-none"
          >
            <LogOut className="size-4" aria-hidden />
            Sign out
          </button>
        </div>
      )}
      {changingPassword && <ChangePasswordDialog onClose={() => setChangingPassword(false)} />}
      {viewingSessions && <SessionsDialog onClose={() => setViewingSessions(false)} />}
    </div>
  );
}

/* ── Chrome: sidebar, mobile drawer, top bar ───────────────────────────────── */

function MobileDrawer({ onClose }: { onClose: () => void }) {
  const panel = useRef<HTMLDivElement>(null);
  useFocusTrap(panel, onClose);
  return createPortal(
    <div className="fixed inset-0 z-50 md:hidden">
      <div
        className="absolute inset-0 animate-fade-in bg-canvas/70 backdrop-blur-[2px]"
        onClick={onClose}
        aria-hidden
      />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label="Navigation"
        tabIndex={-1}
        className="absolute inset-y-0 left-0 flex w-[280px] max-w-[85vw] animate-drawer-in flex-col border-r border-line bg-surface shadow-3 focus:outline-none"
      >
        <div className="flex h-topbar items-center justify-between border-b border-line-subtle pl-4 pr-2">
          <Wordmark />
          <IconButton icon={X} label="Close navigation" tooltip={false} onClick={onClose} />
        </div>
        <NavList rail={false} onNavigate={onClose} />
        <div className="border-t border-line-subtle p-2.5">
          <UserMenu rail={false} />
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** Pages outside the navigation that still deserve a title in the top bar. */
const EXTRA_CRUMBS: Record<string, string> = { '/notifications': 'Notifications' };

function Breadcrumbs() {
  const { pathname } = useLocation();
  const hit = findNav(pathname);
  if (!hit) {
    const extra = EXTRA_CRUMBS[pathname];
    return extra ? <span className="text-body-sm font-medium text-fg">{extra}</span> : null;
  }
  const isDetail = pathname !== hit.item.to;
  return (
    <nav aria-label="Breadcrumb" className="min-w-0">
      <ol className="flex min-w-0 items-center gap-1.5 text-body-sm">
        {hit.group && (
          <li className="hidden items-center gap-1.5 text-fg-muted sm:flex">
            {hit.group}
            <ChevronRight className="size-3.5 text-fg-faint" aria-hidden />
          </li>
        )}
        <li className="min-w-0 truncate">
          {isDetail ? (
            <Link
              to={hit.item.to}
              className="text-fg-secondary transition-colors duration-150 hover:text-fg"
            >
              {hit.item.label}
            </Link>
          ) : (
            <span aria-current="page" className="font-medium text-fg">
              {hit.item.label}
            </span>
          )}
        </li>
        {isDetail && (
          <li className="hidden items-center gap-1.5 sm:flex">
            <ChevronRight className="size-3.5 text-fg-faint" aria-hidden />
            <span aria-current="page" className="font-medium text-fg">
              Details
            </span>
          </li>
        )}
      </ol>
    </nav>
  );
}

export function Layout() {
  const { pathname } = useLocation();
  const { user } = useAuth();
  const isDesktop = useMediaQuery('(min-width: 1024px)');
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem(SIDEBAR_KEY) === 'collapsed',
  );
  const [drawer, setDrawer] = useState(false);
  const main = useRef<HTMLElement>(null);
  // Tablets always get the icon rail; desktops honour the user's choice.
  const rail = !isDesktop || collapsed;

  function toggleCollapsed() {
    setCollapsed((c) => {
      localStorage.setItem(SIDEBAR_KEY, c ? 'expanded' : 'collapsed');
      return !c;
    });
  }

  // New page → start at the top and close the mobile drawer.
  useEffect(() => {
    main.current?.scrollTo({ top: 0 });
    setDrawer(false);
  }, [pathname]);

  return (
    <CreateWorkProvider>
      <CommandPaletteProvider>
        <div className="flex h-full">
          <a
            href="#main"
            className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-3 focus:z-[80] focus:rounded-sm focus:bg-accent focus:px-3 focus:py-2 focus:text-body-sm focus:font-medium focus:text-accent-fg"
          >
            Skip to content
          </a>

          <aside
            className={cn(
              'hidden shrink-0 flex-col border-r border-line bg-surface transition-[width] duration-200 ease-out md:flex',
              rail ? 'w-rail' : 'w-sidebar',
            )}
          >
            <div
              className={cn(
                'flex h-topbar shrink-0 items-center border-b border-line-subtle',
                rail ? 'justify-center' : 'px-4',
              )}
            >
              <Link to="/" aria-label="CloudOps — dashboard" className="rounded-sm">
                <Wordmark collapsed={rail} />
              </Link>
            </div>
            <NavList rail={rail} />
            <div className="space-y-1 border-t border-line-subtle p-2.5">
              {isDesktop && (
                <Tooltip
                  content={collapsed ? 'Expand sidebar' : ''}
                  side="right"
                  disabled={!collapsed}
                  className="w-full"
                >
                  <button
                    type="button"
                    onClick={toggleCollapsed}
                    aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
                    className={cn(
                      'flex h-8 w-full items-center gap-3 rounded-sm text-body-sm text-fg-muted transition-colors duration-150 hover:bg-hover/60 hover:text-fg',
                      collapsed ? 'justify-center' : 'px-2.5',
                    )}
                  >
                    {collapsed ? (
                      <PanelLeftOpen className="size-[18px]" aria-hidden />
                    ) : (
                      <>
                        <PanelLeftClose className="size-[18px]" aria-hidden />
                        Collapse
                      </>
                    )}
                  </button>
                </Tooltip>
              )}
              <UserMenu rail={rail} />
            </div>
          </aside>

          <div className="flex min-w-0 flex-1 flex-col">
            <header className="flex h-topbar shrink-0 items-center gap-2 border-b border-line bg-canvas px-4 md:gap-3 md:px-6 lg:px-8">
              <IconButton
                icon={Menu}
                label="Open navigation"
                tooltip={false}
                className="-ml-2 md:hidden"
                aria-expanded={drawer}
                onClick={() => setDrawer(true)}
              />
              <Link to="/" aria-label="CloudOps — dashboard" className="rounded-sm md:hidden">
                <LogoMark className="size-6" />
              </Link>
              <Breadcrumbs />
              <div className="ml-auto flex items-center gap-1.5 md:gap-2">
                <SearchTrigger />
                <OrgSwitcher />
                <NotificationBell />
              </div>
            </header>
            <main
              ref={main}
              id="main"
              tabIndex={-1}
              className="flex-1 overflow-y-auto focus:outline-none"
            >
              <div className="mx-auto w-full max-w-page px-4 pb-16 pt-6 md:px-6 md:pt-8 lg:px-8">
                <Outlet />
              </div>
            </main>
          </div>

          {drawer && <MobileDrawer onClose={() => setDrawer(false)} />}
          {/* Admin-set or default password: choose your own before anything else. */}
          {user?.mustChangePassword && <ChangePasswordDialog required onClose={() => undefined} />}
        </div>
      </CommandPaletteProvider>
    </CreateWorkProvider>
  );
}
