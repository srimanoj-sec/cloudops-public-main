import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import {
  ArrowRight,
  Bell,
  BookText,
  Boxes,
  Building2,
  Clock,
  CornerDownLeft,
  FolderTree,
  History,
  Keyboard,
  KeyRound,
  ListChecks,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  SquareKanban,
  TrendingUp,
  User,
  UserPlus,
  Wrench,
  X,
  type LucideIcon,
} from 'lucide-react';
import { SEARCH_KIND_LABELS, type SearchKind, type SearchResultDto } from '@cloudops/core';
import { useAuth, usePermissions } from '../lib/auth';
import { useOrg } from '../lib/orgContext';
import { recordSearch, clearRecentSearches, useRecent } from '../lib/recent';
import { useEnqueueSync, useEvaluateStandards, useGlobalSearch } from '../lib/queries';
import { apiErrorMessage } from '../lib/api';
import { Badge, Spinner, cn, type Tone } from '../components/ui/primitives';
import { Modal } from '../components/ui/Modal';
import { useFocusTrap } from '../components/ui/useFocusTrap';
import { useToast } from '../components/ui/Toast';
import { useCreateWork } from '../features/work/CreateWork';
import { NAV_GROUPS } from './navigation';
import { useDebounced } from '../lib/useDebounced';

/* ── Context ─────────────────────────────────────────────────────────────── */

const PaletteContext = createContext<{ open: (query?: string) => void } | null>(null);

export function useCommandPalette() {
  const ctx = useContext(PaletteContext);
  if (!ctx) throw new Error('useCommandPalette must be used within CommandPaletteProvider');
  return ctx;
}

const KIND_ICON: Record<SearchKind, LucideIcon> = {
  resource: Boxes,
  resourceGroup: FolderTree,
  subscription: KeyRound,
  organization: Building2,
  workItem: SquareKanban,
  rule: ShieldCheck,
  document: BookText,
  remediation: Wrench,
  syncRun: RefreshCw,
  user: User,
  audit: History,
};

/** `g` then a key — jump anywhere without the mouse. */
const GO_TO: Record<string, { to: string; label: string }> = {
  d: { to: '/', label: 'Dashboard' },
  i: { to: '/inventory', label: 'Inventory' },
  t: { to: '/topology', label: 'Topology' },
  f: { to: '/finops', label: 'FinOps' },
  s: { to: '/standards', label: 'Standards' },
  r: { to: '/remediation', label: 'Remediation' },
  w: { to: '/work', label: 'Work boards' },
  o: { to: '/operations/syncs', label: 'Sync center' },
  n: { to: '/notifications', label: 'Notifications' },
};

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
}

export function CommandPaletteProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ query: string } | null>(null);
  const [help, setHelp] = useState(false);
  const navigate = useNavigate();
  const open = useCallback((query = '') => setState({ query }), []);
  const value = useMemo(() => ({ open }), [open]);

  useEffect(() => {
    let pendingG: number | null = null;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setState((s) => (s ? null : { query: '' }));
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target) || document.querySelector('[role="dialog"]')) return;
      if (e.key === '/') {
        e.preventDefault();
        setState({ query: '' });
      } else if (e.key === '?') {
        e.preventDefault();
        setHelp(true);
      } else if (pendingG !== null) {
        window.clearTimeout(pendingG);
        pendingG = null;
        const dest = GO_TO[e.key.toLowerCase()];
        if (dest) {
          e.preventDefault();
          navigate(dest.to);
        }
      } else if (e.key === 'g') {
        pendingG = window.setTimeout(() => (pendingG = null), 1200);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [navigate]);

  return (
    <PaletteContext.Provider value={value}>
      {children}
      {state && <Palette initialQuery={state.query} onClose={() => setState(null)} onHelp={() => setHelp(true)} />}
      {help && <ShortcutsHelp onClose={() => setHelp(false)} />}
    </PaletteContext.Provider>
  );
}

/* ── Palette ─────────────────────────────────────────────────────────────── */

interface Entry {
  key: string;
  group: string;
  icon: LucideIcon;
  title: string;
  subtitle?: string | null;
  badge?: { label: string; tone: Tone } | null;
  matched?: string | null;
  /** Shown in the preview pane for actions and pages. */
  description?: string;
  result?: SearchResultDto;
  run: () => void;
}

const fuzzy = (text: string, q: string) => text.toLowerCase().includes(q.toLowerCase());

function Palette({ initialQuery, onClose, onHelp }: { initialQuery: string; onClose: () => void; onHelp: () => void }) {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { can } = usePermissions();
  const { tenantId } = useOrg();
  const toast = useToast();
  const createWork = useCreateWork();
  const enqueue = useEnqueueSync();
  const evaluate = useEvaluateStandards();
  const { visits, searches } = useRecent();
  const panel = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  useFocusTrap(panel, onClose);

  const [query, setQuery] = useState(initialQuery);
  const [kind, setKind] = useState<SearchKind | 'all'>('all');
  const [active, setActive] = useState(0);
  const debounced = useDebounced(query, 150);
  const kinds = kind === 'all' ? undefined : [kind];
  const search = useGlobalSearch(debounced, { kinds, tenantId: tenantId || undefined, limit: kind === 'all' ? 5 : 20 });

  const scopeKinds = useMemo(
    () =>
      (['resource', 'resourceGroup', 'subscription', 'organization', 'workItem', 'rule', 'document', 'remediation', 'user', 'audit'] as SearchKind[]).filter(
        (k) => (k !== 'user' || can('users.manage')) && (k !== 'audit' || can('audit.read')),
      ),
    [can],
  );

  const go = useCallback(
    (to: string) => {
      if (query.trim() && user) recordSearch(user.id, query);
      onClose();
      navigate(to);
    },
    [navigate, onClose, query, user],
  );

  const actions: Entry[] = useMemo(() => {
    const list: (Entry & { allowed: boolean })[] = [
      {
        key: 'act:search-inventory',
        group: 'Actions',
        icon: Search,
        title: query.trim() ? `Search inventory for “${query.trim()}”` : 'Search inventory',
        description: 'Open the inventory filtered by this text (name, type, id or owner).',
        run: () => go(query.trim() ? `/inventory?q=${encodeURIComponent(query.trim())}` : '/inventory'),
        allowed: true,
      },
      {
        key: 'act:new-work',
        group: 'Actions',
        icon: Plus,
        title: 'Create a work item',
        description: 'Track a task, incident or review against any scope.',
        run: () => {
          onClose();
          createWork({ defaults: query.trim() ? { title: query.trim() } : undefined });
        },
        allowed: can('work.manage'),
      },
      {
        key: 'act:sync',
        group: 'Actions',
        icon: RefreshCw,
        title: 'Sync the estate now',
        description: 'Queue an inventory sync of every organization. Progress shows in the Sync center.',
        run: () => {
          onClose();
          enqueue.mutate(
            { providerKey: 'azure' },
            {
              onSuccess: (run) =>
                toast(
                  run.deduplicated
                    ? { tone: 'info', title: 'A sync is already running', description: 'No second sync was started.' }
                    : { title: 'Sync queued', description: 'Follow it in the Sync center.' },
                ),
              onError: (err) => toast({ tone: 'danger', title: 'Couldn’t queue the sync', description: apiErrorMessage(err) }),
            },
          );
        },
        allowed: can('inventory.sync'),
      },
      {
        key: 'act:evaluate',
        group: 'Actions',
        icon: ListChecks,
        title: 'Run a compliance evaluation',
        description: 'Re-check every enabled rule against every resource it applies to.',
        run: () => {
          onClose();
          evaluate.mutate(undefined, {
            onSuccess: () => toast({ title: 'Evaluation started', description: 'Standards update when it finishes.' }),
            onError: (err) => toast({ tone: 'danger', title: 'Evaluation failed', description: apiErrorMessage(err) }),
          });
        },
        allowed: can('standards.evaluate'),
      },
      {
        key: 'act:anomalies',
        group: 'Actions',
        icon: TrendingUp,
        title: 'Review cost anomalies',
        description: 'Spikes and new spend, with the expected range and monthly impact.',
        run: () => go('/finops?tab=anomalies'),
        allowed: true,
      },
      {
        key: 'act:approvals',
        group: 'Actions',
        icon: Wrench,
        title: 'Remediations waiting for approval',
        description: 'Changes someone asked to run, waiting for a second person.',
        run: () => go('/remediation?status=pending_approval'),
        allowed: can('remediation.approve'),
      },
      {
        key: 'act:failed-jobs',
        group: 'Actions',
        icon: History,
        title: 'View failed background jobs',
        description: 'Job queues, failures with their error, retry.',
        run: () => go('/settings/system#jobs'),
        allowed: can('system.read'),
      },
      {
        key: 'act:add-org',
        group: 'Actions',
        icon: Building2,
        title: 'Add a cloud organization',
        description: 'Connect another tenant with a service principal.',
        run: () => go('/providers?add=1'),
        allowed: can('provider.manage'),
      },
      {
        key: 'act:add-user',
        group: 'Actions',
        icon: UserPlus,
        title: 'Add a user',
        description: 'Create an account and choose its roles.',
        run: () => go('/settings/users?add=1'),
        allowed: can('users.manage'),
      },
      {
        key: 'act:notifications',
        group: 'Actions',
        icon: Bell,
        title: 'Open notifications',
        run: () => go('/notifications'),
        allowed: true,
      },
      {
        key: 'act:shortcuts',
        group: 'Actions',
        icon: Keyboard,
        title: 'Keyboard shortcuts',
        run: () => {
          onClose();
          onHelp();
        },
        allowed: true,
      },
    ];
    return list.filter((a) => a.allowed);
  }, [can, createWork, enqueue, evaluate, go, onClose, onHelp, query, toast]);

  const pages: Entry[] = useMemo(
    () =>
      NAV_GROUPS.flatMap((g) =>
        g.items
          .filter((i) => !i.permission || can(i.permission))
          .map((i) => ({
            key: `page:${i.to}`,
            group: 'Go to',
            icon: i.icon,
            title: i.label,
            subtitle: g.label ?? null,
            run: () => go(i.to),
          })),
      ),
    [can, go],
  );

  const q = query.trim();
  const entries: Entry[] = useMemo(() => {
    if (!q) {
      const recent: Entry[] = visits.slice(0, 6).map((v) => ({
        key: `recent:${v.link}`,
        group: 'Recently viewed',
        icon: KIND_ICON[v.kind as SearchKind] ?? Clock,
        title: v.title,
        subtitle: v.subtitle ?? null,
        run: () => go(v.link),
      }));
      return [...actions.slice(0, 5), ...recent, ...pages];
    }
    const matchedActions = kind === 'all' ? [...actions.filter((a) => a.key === 'act:search-inventory' || fuzzy(a.title, q)), ...pages.filter((p) => fuzzy(p.title, q))] : [];
    const results: Entry[] = (search.data?.groups ?? []).flatMap((g) =>
      g.items.map((r) => ({
        key: `${r.kind}:${r.id}`,
        group: g.label + (g.more ? ' · more — narrow with Tab' : ''),
        icon: KIND_ICON[r.kind],
        title: r.title,
        subtitle: r.subtitle,
        badge: r.badge,
        matched: r.matched,
        result: r,
        run: () => go(r.link),
      })),
    );
    return [...results, ...matchedActions];
  }, [q, visits, actions, pages, kind, search.data, go]);

  useEffect(() => setActive(0), [q, kind, search.data]);
  const current = entries[Math.min(active, entries.length - 1)];

  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(entries.length - 1, a + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      current?.run();
    } else if (e.key === 'Tab') {
      // Tab switches the search scope here — keep it from the dialog's focus trap.
      e.preventDefault();
      e.stopPropagation();
      const all: (SearchKind | 'all')[] = ['all', ...scopeKinds];
      const i = all.indexOf(kind);
      setKind(all[(i + (e.shiftKey ? -1 : 1) + all.length) % all.length]!);
    }
  }

  let lastGroup = '';
  const loading = q.length >= 2 && search.isFetching;

  return createPortal(
    <div
      className="fixed inset-0 z-[70] flex animate-fade-in items-start justify-center bg-canvas/70 p-2 pt-[8vh] backdrop-blur-[2px] sm:p-6 sm:pt-[10vh]"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label="Search and commands"
        className="flex max-h-[80dvh] w-full max-w-4xl animate-dialog-in flex-col overflow-hidden rounded-lg border border-line-strong bg-overlay shadow-3"
      >
        <div className="flex items-center gap-3 border-b border-line px-4">
          {loading ? <Spinner /> : <Search className="size-4 text-fg-muted" aria-hidden />}
          <input
            data-autofocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search resources, ids, IPs, tags (env=prod), work, rules, docs… or type a command"
            aria-label="Search"
            aria-controls="palette-results"
            aria-activedescendant={current ? `pal-${current.key}` : undefined}
            className="h-14 min-w-0 flex-1 bg-transparent text-body-lg text-fg placeholder:text-fg-muted focus:outline-none"
          />
          <button
            type="button"
            onClick={onClose}
            aria-label="Close search"
            className="grid size-7 place-items-center rounded-xs text-fg-muted hover:bg-hover hover:text-fg"
          >
            <X className="size-4" aria-hidden />
          </button>
        </div>

        <div role="radiogroup" aria-label="Search in" className="flex gap-1 overflow-x-auto border-b border-line-subtle px-3 py-2">
          {(['all', ...scopeKinds] as (SearchKind | 'all')[]).map((k) => (
            <button
              key={k}
              type="button"
              role="radio"
              aria-checked={kind === k}
              onClick={() => setKind(k)}
              className={cn(
                'h-6 shrink-0 rounded-xs px-2 text-caption font-medium transition-colors duration-150',
                kind === k ? 'bg-accent/15 text-accent' : 'text-fg-muted hover:bg-hover hover:text-fg',
              )}
            >
              {k === 'all' ? 'All' : SEARCH_KIND_LABELS[k]}
            </button>
          ))}
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_19rem]">
          <div ref={listRef} id="palette-results" role="listbox" aria-label="Results" className="min-h-0 overflow-y-auto p-2">
            {!q && searches.length > 0 && (
              <div className="mb-2 flex flex-wrap items-center gap-1.5 px-2 pt-1">
                <span className="mr-1 font-mono text-overline uppercase text-fg-muted">Recent searches</span>
                {searches.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setQuery(s)}
                    className="h-6 rounded-xs border border-line bg-raised px-2 text-caption text-fg-secondary hover:border-line-strong hover:text-fg"
                  >
                    {s}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => user && clearRecentSearches(user.id)}
                  className="text-caption text-fg-muted underline-offset-2 hover:text-fg hover:underline"
                >
                  clear
                </button>
              </div>
            )}
            {q.length === 1 && <p className="px-3 py-6 text-center text-body-sm text-fg-muted">Keep typing…</p>}
            {q.length >= 2 && search.isError && (
              <p className="px-3 py-6 text-center text-body-sm text-danger">{apiErrorMessage(search.error)}</p>
            )}
            {q.length >= 2 && !search.isFetching && search.data && entries.length === 0 && (
              <div className="px-3 py-10 text-center">
                <p className="text-body-sm text-fg">Nothing matches “{q}”.</p>
                <p className="mt-1 text-caption text-fg-muted">
                  Try part of a name, a resource or subscription id, an IP address, or a tag as key=value.
                </p>
              </div>
            )}
            {entries.map((e, i) => {
              const header = e.group !== lastGroup ? e.group : null;
              lastGroup = e.group;
              const isActive = i === active;
              return (
                <div key={e.key}>
                  {header && <div className="px-2.5 pb-1 pt-3 font-mono text-overline uppercase text-fg-muted first:pt-1">{header}</div>}
                  <div
                    id={`pal-${e.key}`}
                    role="option"
                    aria-selected={isActive}
                    data-active={isActive}
                    onMouseMove={() => setActive(i)}
                    onClick={() => e.run()}
                    className={cn(
                      'flex cursor-pointer items-center gap-3 rounded-sm px-2.5 py-2',
                      isActive ? 'bg-hover text-fg' : 'text-fg-secondary',
                    )}
                  >
                    <e.icon className={cn('size-4 shrink-0', isActive ? 'text-accent' : 'text-fg-muted')} aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-body-sm font-medium text-fg">{e.title}</span>
                      {(e.subtitle || e.matched) && (
                        <span className="block truncate text-caption text-fg-muted">
                          {e.subtitle}
                          {e.matched && <span className="text-accent/90">{e.subtitle ? ' · ' : ''}matched {e.matched}</span>}
                        </span>
                      )}
                    </span>
                    {e.badge && <Badge tone={e.badge.tone}>{e.badge.label}</Badge>}
                    {isActive && <CornerDownLeft className="size-3.5 shrink-0 text-fg-muted" aria-hidden />}
                  </div>
                </div>
              );
            })}
          </div>

          <aside aria-label="Preview" className="hidden min-h-0 overflow-y-auto border-l border-line-subtle bg-surface/40 p-4 lg:block">
            {current ? <Preview entry={current} /> : <p className="text-caption text-fg-muted">Nothing selected.</p>}
          </aside>
        </div>

        <footer className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line px-4 py-2 text-caption text-fg-muted">
          <span>
            <Kbd>↑</Kbd> <Kbd>↓</Kbd> move
          </span>
          <span>
            <Kbd>↵</Kbd> open
          </span>
          <span>
            <Kbd>Tab</Kbd> search in
          </span>
          <span>
            <Kbd>Esc</Kbd> close
          </span>
          {search.data && q.length >= 2 && <span className="ml-auto font-mono">{search.data.tookMs} ms</span>}
        </footer>
      </div>
    </div>,
    document.body,
  );
}

function Preview({ entry }: { entry: Entry }) {
  const r = entry.result;
  return (
    <div className="animate-fade-in">
      <div className="flex items-start gap-2">
        <entry.icon className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden />
        <div className="min-w-0">
          <div className="break-words text-body font-semibold text-fg">{entry.title}</div>
          {entry.subtitle && <div className="mt-0.5 break-words text-caption text-fg-muted">{entry.subtitle}</div>}
        </div>
      </div>
      {entry.badge && (
        <div className="mt-3">
          <Badge tone={entry.badge.tone}>{entry.badge.label}</Badge>
        </div>
      )}
      {r?.matched && (
        <p className="mt-3 text-caption text-accent/90">Matched on {r.matched}</p>
      )}
      {r && r.facts.length > 0 && (
        <dl className="mt-4 space-y-2.5">
          {r.facts.map((f) => (
            <div key={f.label}>
              <dt className="font-mono text-overline uppercase text-fg-muted">{f.label}</dt>
              <dd className="mt-0.5 break-words text-body-sm text-fg-secondary">{f.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {entry.description && <p className="mt-3 text-body-sm text-fg-secondary">{entry.description}</p>}
      <p className="mt-5 flex items-center gap-1 text-caption text-fg-muted">
        <Kbd>↵</Kbd> to open <ArrowRight className="size-3" aria-hidden />
      </p>
    </div>
  );
}

function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-grid min-w-[1.25rem] place-items-center rounded-xs border border-line-strong bg-raised px-1 font-mono text-[10px] leading-4 text-fg-secondary">
      {children}
    </kbd>
  );
}

function ShortcutsHelp({ onClose }: { onClose: () => void }) {
  const rows: [ReactNode, string][] = [
    [
      <>
        <Kbd>Ctrl</Kbd> <Kbd>K</Kbd> or <Kbd>/</Kbd>
      </>,
      'Search and commands',
    ],
    [<Kbd key="q">?</Kbd>, 'This help'],
    ...Object.entries(GO_TO).map(
      ([k, v]): [ReactNode, string] => [
        <>
          <Kbd>g</Kbd> <Kbd>{k}</Kbd>
        </>,
        `Go to ${v.label}`,
      ],
    ),
  ];
  return (
    <Modal size="sm" title="Keyboard shortcuts" onClose={onClose}>
      <dl className="divide-y divide-line-subtle">
        {rows.map(([keys, label], i) => (
          <div key={i} className="flex items-center justify-between gap-4 py-2">
            <dt className="text-body-sm text-fg-secondary">{label}</dt>
            <dd className="shrink-0">{keys}</dd>
          </div>
        ))}
      </dl>
    </Modal>
  );
}
