import { useState } from 'react';
import { Link } from 'react-router-dom';
import { CircleCheck, Ghost, Pencil, PiggyBank, Plus, Target, Trash2 } from 'lucide-react';
import type { BudgetInput, BudgetScope, BudgetStatusDto, FinopsOverviewDto, UnattributedReason } from '@cloudops/core';
import { useDeleteBudget, useOrganizations, useResourceGroups, useSaveBudget, useSubscriptions } from '../../lib/queries';
import { apiErrorMessage } from '../../lib/api';
import { money, moneyFull, shortType } from '../../lib/format';
import {
  Badge,
  Button,
  EmptyState,
  Field,
  IconButton,
  InlineError,
  Input,
  Meter,
  Panel,
  Readout,
  ReadoutGrid,
  Select,
  type Tone,
} from '../../components/ui/primitives';
import { Modal } from '../../components/ui/Modal';
import { useConfirm } from '../../components/ui/Dialogs';

function pctChange(now: number, before: number): { text: string; tone: Tone } | null {
  if (!before) return null;
  const pct = ((now - before) / before) * 100;
  return { text: `${pct >= 0 ? '+' : '−'}${Math.abs(pct).toFixed(1)}%`, tone: pct > 0 ? 'danger' : 'success' };
}

/** This month at a glance: to date vs the same point last month, forecast, run-rate. */
export function MonthStrip({ o }: { o: FinopsOverviewDto }) {
  const m = o.month;
  const vsSame = pctChange(m.toDate, m.lastMonthToDate);
  const vsLast = pctChange(m.forecast, m.lastMonthTotal);
  const c = o.currency;
  return (
    <div className="space-y-1.5">
      <ReadoutGrid className="grid-cols-2 xl:grid-cols-4">
        <Readout
          label={`${m.label} · to date`}
          value={moneyFull(m.toDate, c)}
          hint={`${m.daysElapsed} of ${m.daysInMonth} days · same point last month ${money(m.lastMonthToDate, c)}`}
          badge={vsSame ? <Badge tone={vsSame.tone}>{vsSame.text}</Badge> : undefined}
        />
        <Readout
          label="Forecast · month end"
          value={moneyFull(m.forecast, c)}
          hint="to date + 7-day run-rate × days left"
          badge={vsLast ? <Badge tone={vsLast.tone}>{vsLast.text} vs last month</Badge> : undefined}
        />
        <Readout label="Last month" value={moneyFull(m.lastMonthTotal, c)} hint="full calendar month" />
        <Readout label="Run rate" value={`${money(m.runRate, c)}/day`} hint={`≈ ${money(m.runRate * 30, c)} per 30 days`} />
      </ReadoutGrid>
      {o.latestDate && <p className="text-caption text-fg-faint">Cost data through {new Date(o.latestDate).toLocaleDateString()} (Azure reports cost with a 1–2 day lag).</p>}
    </div>
  );
}

// ── Budgets ─────────────────────────────────────────────────────────

const STATUS_TONE: Record<BudgetStatusDto['status'], Tone> = { ok: 'success', 'at-risk': 'warning', over: 'danger' };
const STATUS_LABEL: Record<BudgetStatusDto['status'], string> = { ok: 'on track', 'at-risk': 'at risk', over: 'over budget' };

function BudgetModal({ budget, currency, onClose }: { budget?: BudgetStatusDto; currency: string; onClose: () => void }) {
  const save = useSaveBudget();
  const orgs = useOrganizations();
  const subs = useSubscriptions();
  const [scopeType, setScopeType] = useState<BudgetScope>(budget?.scopeType ?? 'all');
  const [scopeId, setScopeId] = useState(budget?.scopeId ?? '');
  const [rgSub, setRgSub] = useState('');
  const rgs = useResourceGroups(scopeType === 'resourceGroup' ? rgSub || undefined : undefined);
  const [name, setName] = useState(budget?.name ?? '');
  const [amount, setAmount] = useState(budget ? String(budget.amount) : '');
  const [alertPercent, setAlertPercent] = useState(String(budget?.alertPercent ?? 80));
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setError(null);
    const input: BudgetInput = {
      name: name.trim(),
      scopeType,
      scopeId: scopeType === 'all' ? undefined : scopeId || undefined,
      amount: Number(amount),
      alertPercent: Number(alertPercent) || 80,
    };
    try {
      await save.mutateAsync({ id: budget?.id, input });
      onClose();
    } catch (e) {
      setError(apiErrorMessage(e));
    }
  }

  return (
    <Modal
      size="sm"
      title={budget ? 'Edit budget' : 'New budget'}
      description={`A monthly limit in ${currency}. Tracked against month-to-date spend and the month-end forecast.`}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} loading={save.isPending} disabled={!name.trim() || !(Number(amount) > 0) || (scopeType !== 'all' && !scopeId)}>
            {budget ? 'Save' : 'Create budget'}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Name" required>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Production — monthly" autoFocus />
        </Field>
        <Field label="Covers">
          <Select
            className="w-full"
            value={scopeType}
            onChange={(e) => {
              setScopeType(e.target.value as BudgetScope);
              setScopeId('');
            }}
          >
            <option value="all">All spend</option>
            <option value="organization">One organization</option>
            <option value="subscription">One subscription</option>
            <option value="resourceGroup">One resource group</option>
          </Select>
        </Field>
        {scopeType === 'organization' && (
          <Select className="w-full" value={scopeId} onChange={(e) => setScopeId(e.target.value)} aria-label="Organization">
            <option value="">Choose…</option>
            {orgs.data?.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </Select>
        )}
        {scopeType === 'subscription' && (
          <Select className="w-full" value={scopeId} onChange={(e) => setScopeId(e.target.value)} aria-label="Subscription">
            <option value="">Choose…</option>
            {subs.data?.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        )}
        {scopeType === 'resourceGroup' && (
          <div className="grid gap-2 sm:grid-cols-2">
            <Select value={rgSub} onChange={(e) => setRgSub(e.target.value)} aria-label="Subscription of the resource group">
              <option value="">Subscription…</option>
              {subs.data?.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
            <Select value={scopeId} onChange={(e) => setScopeId(e.target.value)} disabled={!rgSub} aria-label="Resource group">
              <option value="">{budget?.scopeType === 'resourceGroup' && budget.scopeId && !rgSub ? budget.scopeName : 'Resource group…'}</option>
              {rgs.data?.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </Select>
          </div>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={`Monthly amount (${currency})`} required>
            <Input type="number" min={1} value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="200000" />
          </Field>
          <Field label="Warn at (% of budget)" hint="When the forecast reaches it">
            <Input type="number" min={1} max={100} value={alertPercent} onChange={(e) => setAlertPercent(e.target.value)} />
          </Field>
        </div>
        {error && <InlineError>{error}</InlineError>}
      </div>
    </Modal>
  );
}

export function BudgetsPanel({ o, canManage }: { o: FinopsOverviewDto; canManage: boolean }) {
  const [editing, setEditing] = useState<BudgetStatusDto | 'new' | null>(null);
  const del = useDeleteBudget();
  const confirm = useConfirm();
  const c = o.currency;
  return (
    <Panel
      title={
        <span className="flex items-center gap-2">
          <Target className="size-4 text-fg-muted" aria-hidden /> Budgets
        </span>
      }
      description="Monthly limits per scope — spent to date and where the month is heading"
      actions={
        canManage ? (
          <Button variant="secondary" size="sm" icon={Plus} onClick={() => setEditing('new')}>
            Budget
          </Button>
        ) : undefined
      }
      flush
    >
      {o.budgets.length === 0 ? (
        <EmptyState compact icon={Target} title="No budgets yet" description="Set a monthly limit for all spend, an organization, a subscription or a resource group." />
      ) : (
        <ul className="divide-y divide-line-subtle">
          {o.budgets.map((b) => (
            <li key={b.id} className="px-4 py-3 md:px-5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-body-sm font-medium text-fg">{b.name}</span>
                    <Badge tone={STATUS_TONE[b.status]} dot>
                      {STATUS_LABEL[b.status]}
                    </Badge>
                  </div>
                  <div className="mt-0.5 text-caption text-fg-muted">{b.scopeName}</div>
                </div>
                {canManage && (
                  <div className="flex shrink-0 gap-1">
                    <IconButton icon={Pencil} label="Edit budget" size="sm" onClick={() => setEditing(b)} />
                    <IconButton
                      icon={Trash2}
                      label="Delete budget"
                      size="sm"
                      variant="danger-ghost"
                      onClick={async () => {
                        if (await confirm({ title: 'Delete budget?', description: `“${b.name}” will be removed.`, confirmLabel: 'Delete', tone: 'danger' })) del.mutate(b.id);
                      }}
                    />
                  </div>
                )}
              </div>
              <Meter className="mt-2" value={Math.min(100, b.percentUsed)} tone={STATUS_TONE[b.status]} size="sm" label={`${b.name} used`} />
              <div className="mt-1.5 flex flex-wrap justify-between gap-2 font-mono text-caption tabular-nums text-fg-muted">
                <span>
                  <span className="text-fg">{money(b.spent, c)}</span> of {money(b.amount, c)} · {b.percentUsed}%
                </span>
                <span>
                  forecast {money(b.forecast, c)} · {b.forecastPercent}%
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
      {editing && <BudgetModal budget={editing === 'new' ? undefined : editing} currency={c} onClose={() => setEditing(null)} />}
    </Panel>
  );
}

// ── Savings opportunities ───────────────────────────────────────────

export function SavingsPanel({ o }: { o: FinopsOverviewDto }) {
  const c = o.currency;
  return (
    <Panel
      title={
        <span className="flex items-center gap-2">
          <PiggyBank className="size-4 text-fg-muted" aria-hidden /> Savings opportunities
        </span>
      }
      description="Resources failing a Cost Optimization rule — orphaned disks & IPs, idle plans, VMs stopped without deallocating"
      actions={o.savings.total > 0 ? <span className="font-mono text-body-sm tabular-nums text-success">≈ {money(o.savings.total, c)}/mo</span> : undefined}
      flush
    >
      {o.savings.items.length === 0 ? (
        <p className="flex items-center justify-center gap-2 px-5 py-8 text-body-sm text-success">
          <CircleCheck className="size-4" aria-hidden /> Nothing to reclaim right now. (Findings refresh with each Standards evaluation.)
        </p>
      ) : (
        <>
          <ul className="max-h-96 divide-y divide-line-subtle overflow-y-auto">
            {o.savings.items.map((s, i) => (
              <li key={`${s.resourceId}-${i}`} className="flex items-start justify-between gap-3 px-4 py-2.5 md:px-5">
                <div className="min-w-0">
                  <Link to={`/inventory/${s.resourceId}?tab=Compliance`} className="link-quiet font-medium">
                    {s.name}
                  </Link>
                  <div className="truncate text-caption text-fg-muted">
                    {s.finding}
                    {s.detail ? ` — ${s.detail}` : ''} · {shortType(s.type)}
                  </div>
                </div>
                <span className="shrink-0 font-mono text-caption tabular-nums text-fg-secondary">{s.costMonthly > 0 ? `${money(s.costMonthly, c)}/mo` : '—'}</span>
              </li>
            ))}
          </ul>
          <div className="border-t border-line-subtle px-5 py-2 text-caption text-fg-muted">
            {o.savings.count} resource(s). Manage the rules in{' '}
            <Link to="/standards" className="link">
              Standards → Cost Optimization
            </Link>
            .
          </div>
        </>
      )}
    </Panel>
  );
}

// ── Unattributed spend ──────────────────────────────────────────────

const REASON: Record<UnattributedReason, { label: string; tone: Tone; help: string }> = {
  deleted: { label: 'Deleted resource', tone: 'danger', help: 'The resource is gone from Azure’s inventory, but cost is still being charged to it — usually a leftover in a deleted resource group.' },
  'not-in-inventory': { label: 'Not in inventory', tone: 'warning', help: 'Billed to a resource CloudOps has never discovered — a subscription or resource group outside the sync, or deleted before the first sync.' },
  'subscription-level': { label: 'Subscription-level', tone: 'neutral', help: 'Billed to the subscription itself rather than a resource (e.g. Azure DevOps organizations, support plans, marketplace).' },
};

/** Charged within 2 days of the newest cost data = still accruing (cost data lags 1–2 days). */
function stillBilling(lastCostDate: string, latestDate: string | null): boolean {
  if (!latestDate) return false;
  return new Date(latestDate).getTime() - new Date(lastCostDate).getTime() <= 2 * 86_400_000;
}

export function UnattributedPanel({ o }: { o: FinopsOverviewDto }) {
  const c = o.currency;
  const [reason, setReason] = useState<UnattributedReason | ''>('');
  const items = reason ? o.unattributed.items.filter((i) => i.reason === reason) : o.unattributed.items;
  return (
    <Panel
      title={
        <span className="flex items-center gap-2">
          <Ghost className="size-4 text-fg-muted" aria-hidden /> Spend outside the inventory
        </span>
      }
      description="Last 30 days of cost that isn’t on any active resource — where leaks hide"
      actions={o.unattributed.total > 0 ? <span className="font-mono text-body-sm tabular-nums text-fg">{money(o.unattributed.total, c)}</span> : undefined}
      flush
    >
      {o.unattributed.items.length === 0 ? (
        <p className="flex items-center justify-center gap-2 px-5 py-8 text-body-sm text-success">
          <CircleCheck className="size-4" aria-hidden /> Every cost line in the last 30 days belongs to an active resource.
        </p>
      ) : (
        <>
          <div className="flex flex-wrap gap-2 border-b border-line-subtle px-4 py-3 md:px-5">
            <button type="button" onClick={() => setReason('')} className={`rounded-full border px-3 py-1 text-caption ${reason === '' ? 'border-accent bg-accent/10 text-fg' : 'border-line text-fg-secondary hover:bg-hover'}`}>
              All · {money(o.unattributed.total, c)}
            </button>
            {o.unattributed.byReason.map((r) => (
              <button
                key={r.reason}
                type="button"
                title={REASON[r.reason].help}
                onClick={() => setReason(r.reason)}
                className={`rounded-full border px-3 py-1 text-caption ${reason === r.reason ? 'border-accent bg-accent/10 text-fg' : 'border-line text-fg-secondary hover:bg-hover'}`}
              >
                {REASON[r.reason].label} · {money(r.cost, c)} · {r.count}
              </button>
            ))}
          </div>
          {reason && <p className="border-b border-line-subtle px-5 py-2 text-caption text-fg-muted">{REASON[reason].help}</p>}
          <div className="overflow-x-auto">
            <table className="data-table data-table--compact">
              <thead>
                <tr>
                  <th scope="col">Billed to</th>
                  <th scope="col" className="hidden lg:table-cell">Where</th>
                  <th scope="col">Why</th>
                  <th scope="col" className="num">30 days</th>
                  <th scope="col" className="hidden sm:table-cell">Last charged</th>
                </tr>
              </thead>
              <tbody>
                {items.map((i) => (
                  <tr key={i.resourceExternalId}>
                    <td className="max-w-[18rem]">
                      {i.resourceId ? (
                        <Link to={`/inventory/${i.resourceId}`} className="link-quiet font-medium">
                          {i.name}
                        </Link>
                      ) : (
                        <span className="font-medium text-fg" title={i.resourceExternalId}>
                          {i.name}
                        </span>
                      )}
                      <div className="truncate text-caption text-fg-muted">{i.type ? shortType(i.type) : '—'}</div>
                    </td>
                    <td className="hidden text-caption text-fg-muted lg:table-cell">{[i.subscription, i.resourceGroup].filter(Boolean).join(' › ') || '—'}</td>
                    <td>
                      <Badge tone={REASON[i.reason].tone}>{REASON[i.reason].label}</Badge>
                      {i.reason !== 'subscription-level' &&
                        (stillBilling(i.lastCostDate, o.latestDate) ? (
                          <div className="mt-0.5 text-caption font-medium text-danger">still billing</div>
                        ) : (
                          <div className="mt-0.5 text-caption text-fg-muted">stopped billing</div>
                        ))}
                    </td>
                    <td className="num">{money(i.cost30d, c)}</td>
                    <td className="hidden font-mono text-caption sm:table-cell">{new Date(i.lastCostDate).toLocaleDateString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Panel>
  );
}
