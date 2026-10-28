import { useState } from 'react';
import { Link } from 'react-router-dom';
import { CircleCheck, Plus, ShieldOff, SquareKanban, Undo2, Wrench } from 'lucide-react';
import type { ComplianceResultDto, RuleScoreDto } from '@cloudops/core';
import {
  useBulkExemption,
  useComplianceResults,
  useDeleteExemption,
  useRemediationActions,
  useRemediationRuns,
  useWorkItems,
} from '../../lib/queries';
import { usePermissions } from '../../lib/auth';
import { apiErrorMessage } from '../../lib/api';
import { shortType } from '../../lib/format';
import {
  Badge,
  Button,
  Checkbox,
  Field,
  InlineError,
  Input,
  LoadingBlock,
  SegmentedControl,
  TextButton,
  cn,
  severityTone,
} from '../../components/ui/primitives';
import { Modal } from '../../components/ui/Modal';
import { useToast } from '../../components/ui/Toast';
import { useCreateWork } from '../work/CreateWork';
import { RiskBadge } from '../remediation/shared';
import { CategoryBadge } from './standardsUi';

type View = 'failing' | 'exempt';

const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

/** One reason and end date for the selected resources. Defaults to 90 days — exemptions should end. */
function ExemptForm({
  rule,
  rows,
  onDone,
}: {
  rule: RuleScoreDto;
  rows: ComplianceResultDto[];
  onDone: () => void;
}) {
  const bulk = useBulkExemption();
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [until, setUntil] = useState(inDays(90));
  const [forever, setForever] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setError(null);
    try {
      await bulk.mutateAsync({
        ruleId: rule.id,
        resourceIds: rows.map((r) => r.scopeId),
        reason: reason.trim(),
        expiresAt: forever ? undefined : until,
      });
      toast({
        title: rows.length === 1 ? 'Exemption added' : `${rows.length} exemptions added`,
        description: `No longer counted against “${rule.name}”${forever ? '' : ` until ${new Date(until).toLocaleDateString()}`}.`,
      });
      onDone();
    } catch (e) {
      setError(apiErrorMessage(e));
    }
  }

  return (
    <div className="space-y-2 rounded-sm border border-line bg-canvas/60 p-3">
      <div className="text-body-sm text-fg-secondary">
        Exempt{' '}
        <span className="font-medium text-fg">
          {rows.length === 1 ? rows[0]!.scopeName : `${rows.length} resources`}
        </span>{' '}
        from this rule
      </div>
      <div className="grid gap-2 sm:grid-cols-[1fr_11rem]">
        <Field label="Why is this acceptable?" required>
          <Input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Dev sandbox, deleted next sprint"
            autoFocus
          />
        </Field>
        <Field label="Until">
          <Input
            type="date"
            min={inDays(1)}
            value={until}
            onChange={(e) => setUntil(e.target.value)}
            disabled={forever}
          />
        </Field>
      </div>
      <Checkbox checked={forever} onChange={() => setForever((f) => !f)} className="-ml-2 w-fit">
        No end date — it will be listed under “Needs a look” until someone reviews it
      </Checkbox>
      {error && <InlineError>{error}</InlineError>}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onDone}>
          Cancel
        </Button>
        <Button
          size="sm"
          onClick={() => void save()}
          disabled={reason.trim().length < 3 || (!forever && !until)}
          loading={bulk.isPending}
        >
          Exempt {rows.length === 1 ? 'resource' : `${rows.length} resources`}
        </Button>
      </div>
    </div>
  );
}

function Row({
  row,
  canManage,
  selected,
  onToggle,
  onClose,
}: {
  row: ComplianceResultDto;
  canManage: boolean;
  selected: boolean;
  onToggle: (() => void) | null;
  onClose: () => void;
}) {
  const remove = useDeleteExemption();
  const where = [row.subscription, row.resourceGroup].filter(Boolean).join(' › ');
  return (
    <li className={cn('flex items-start gap-3 px-5 py-3', selected && 'bg-accent/[0.04]')}>
      {onToggle && (
        <input
          type="checkbox"
          className="mt-1 size-3.5 shrink-0 cursor-pointer"
          checked={selected}
          onChange={onToggle}
          aria-label={`Select ${row.scopeName ?? row.scopeId}`}
        />
      )}
      <div className="min-w-0 flex-1">
        <Link to={`/inventory/${row.scopeId}`} className="link-quiet font-medium" onClick={onClose}>
          {row.scopeName ?? row.scopeId}
        </Link>
        <div className="mt-0.5 truncate text-caption text-fg-muted">
          {row.resourceType ? shortType(row.resourceType) : ''}
          {where ? ` · ${where}` : ''}
        </div>
        {row.detail && (
          <div className="mt-1 text-caption">
            <span className="text-fg-muted">Evidence: </span>
            <span className="text-danger/90">{row.detail}</span>
          </div>
        )}
        {row.exempt && row.exemption && (
          <div className="mt-1.5 text-caption text-fg-secondary">
            <span className="text-fg-muted">Exempt:</span> {row.exemption.reason}
            <span className="text-fg-muted">
              {' · '}
              {row.exemption.expiresAt
                ? `until ${new Date(row.exemption.expiresAt).toLocaleDateString()}`
                : 'no end date'}
              {row.exemption.createdBy ? ` · by ${row.exemption.createdBy}` : ''}
            </span>
          </div>
        )}
      </div>
      {canManage && row.exempt && row.exemption && (
        <TextButton
          tone="muted"
          onClick={() => remove.mutate(row.exemption!.id)}
          disabled={remove.isPending}
        >
          <Undo2 className="size-3.5" aria-hidden />
          Revoke
        </TextButton>
      )}
    </li>
  );
}

/**
 * A finding: what the rule checks and why, the evidence per resource, how to
 * fix it — and whether CloudOps can fix it for you. Select resources to exempt,
 * remediate or track them together.
 */
export function RuleDrilldown({
  rule,
  canManage,
  onClose,
}: {
  rule: RuleScoreDto;
  canManage: boolean;
  onClose: () => void;
}) {
  const failing = useComplianceResults(rule.id, false);
  const actions = useRemediationActions();
  const work = useWorkItems({ sourceType: 'rule', sourceId: rule.id });
  const runs = useRemediationRuns({ sourceType: 'rule', sourceId: rule.id, pageSize: 5 });
  const { can } = usePermissions();
  const createWork = useCreateWork();
  const [view, setView] = useState<View>('failing');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [exempting, setExempting] = useState(false);

  const all = failing.data ?? [];
  const rows = all.filter((r) => (view === 'exempt' ? r.exempt : !r.exempt));
  const exemptCount = all.filter((r) => r.exempt).length;
  const fixes = (actions.data ?? []).filter(
    (a) => rule.template && a.fixesRules.includes(rule.template),
  );
  const chosen = rows.filter((r) => selected.has(r.scopeId));
  const targets = chosen.length ? chosen : rows;
  const selectable = view === 'failing';

  const toggle = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const trackAsWork = () =>
    createWork({
      defaults: {
        title: `${rule.name} — ${targets.length} resource${targets.length === 1 ? '' : 's'}`,
        description: `${rule.description}\n\n**How to fix:** ${rule.remediation ?? 'see the rule'}`,
        type: rule.category === 'cost' ? 'cost' : 'security',
        priority: rule.severity === 'high' ? 2 : 3,
      },
      source: { type: 'rule', id: rule.id, label: rule.name },
      scopes: targets
        .slice(0, 50)
        .map((r) => ({
          scopeType: 'resource' as const,
          scopeId: r.scopeId,
          scopeName: r.scopeName ?? undefined,
        })),
    });

  const remediateLink = `/remediation/new?rule=${rule.id}${chosen.length ? `&resources=${chosen.map((r) => r.scopeId).join(',')}` : ''}`;

  return (
    <Modal title={rule.name} description={rule.appliesTo ?? undefined} onClose={onClose} size="lg">
      <div className="-mx-5 -my-5">
        <div className="space-y-3 border-b border-line-subtle px-5 py-4">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone={severityTone(rule.severity)}>{rule.severity}</Badge>
            <CategoryBadge category={rule.category} />
            <span className="text-caption text-fg-muted">
              {rule.failed} failing · {rule.passed} passing · {rule.exempt} exempt
            </span>
          </div>
          {rule.description && rule.description !== rule.name && (
            <div>
              <div className="font-mono text-overline uppercase text-fg-muted">
                What’s checked, and why it matters
              </div>
              <p className="mt-0.5 text-body-sm text-fg-secondary">{rule.description}</p>
            </div>
          )}
          {rule.remediation && (
            <div className="flex gap-2 rounded-sm border border-accent/20 bg-accent/[0.05] px-3 py-2.5 text-body-sm text-fg">
              <Wrench className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden />
              <div className="min-w-0 flex-1">
                <div className="font-mono text-overline uppercase text-accent/80">How to fix</div>
                <div className="mt-0.5">{rule.remediation}</div>
                <div className="mt-2 border-t border-accent/15 pt-2">
                  <div className="font-mono text-overline uppercase text-accent/80">
                    Can CloudOps fix it?
                  </div>
                  {fixes.length === 0 ? (
                    <p className="mt-0.5 text-caption text-fg-secondary">
                      Not automatically — make the change in the cloud console; the next sync and
                      evaluation pick it up.
                    </p>
                  ) : (
                    <ul className="mt-1 space-y-1">
                      {fixes.map((a) => (
                        <li key={a.key} className="flex flex-wrap items-center gap-2 text-caption">
                          <span className="text-fg">{a.title}</span>
                          <RiskBadge risk={a.risk} />
                          {!a.reversible && <Badge tone="danger">irreversible</Badge>}
                          {!a.available && (
                            <span className="text-fg-muted">— {a.unavailableReason}</span>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            </div>
          )}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <SegmentedControl
              label="Show"
              size="sm"
              value={view}
              onChange={(v) => {
                setView(v);
                setSelected(new Set());
              }}
              options={[
                { value: 'failing', label: `Failing · ${rule.failed}` },
                { value: 'exempt', label: `Exempted · ${exemptCount}` },
              ]}
            />
            <div className="flex flex-wrap items-center gap-1.5">
              {view === 'failing' && rows.length > 0 && (
                <>
                  {fixes.length > 0 && can('remediation.request') && (
                    <Link
                      to={remediateLink}
                      onClick={onClose}
                      className="inline-flex h-8 items-center gap-1.5 rounded-sm bg-accent px-3 text-body-sm font-medium text-accent-fg hover:bg-accent-hover"
                    >
                      <Wrench className="size-3.5" aria-hidden /> Remediate{' '}
                      {chosen.length ? chosen.length : 'all'}
                    </Link>
                  )}
                  {can('work.manage') && (
                    <Button variant="secondary" size="sm" icon={Plus} onClick={trackAsWork}>
                      Work item{chosen.length ? ` (${chosen.length})` : ''}
                    </Button>
                  )}
                  {canManage && (
                    <Button
                      variant="ghost"
                      size="sm"
                      icon={ShieldOff}
                      onClick={() => setExempting(true)}
                      disabled={exempting}
                    >
                      Exempt{chosen.length ? ` ${chosen.length}` : '…'}
                    </Button>
                  )}
                </>
              )}
            </div>
          </div>
          {exempting && (
            <ExemptForm
              rule={rule}
              rows={chosen.length ? chosen : rows}
              onDone={() => {
                setExempting(false);
                setSelected(new Set());
              }}
            />
          )}
          {work.data?.length || runs.data?.items.length ? (
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-caption text-fg-muted">
              {work.data && work.data.length > 0 && (
                <span className="flex items-center gap-1">
                  <SquareKanban className="size-3.5" aria-hidden /> Tracked in
                  <span>
                    {work.data.slice(0, 3).map((w, i) => (
                      <span key={w.id}>
                        {i > 0 && ', '}
                        <Link to={`/work/${w.id}`} onClick={onClose} className="link">
                          {w.title.slice(0, 40)}
                        </Link>
                      </span>
                    ))}
                    {work.data.length > 3 && ` +${work.data.length - 3}`}
                  </span>
                </span>
              )}
              {runs.data && runs.data.items.length > 0 && (
                <span className="flex items-center gap-1">
                  <Wrench className="size-3.5" aria-hidden /> Remediations:
                  <span>
                    {runs.data.items.map((r, i) => (
                      <span key={r.id}>
                        {i > 0 && ', '}
                        <Link to={`/remediation/${r.id}`} onClick={onClose} className="link">
                          {r.status.replace('_', ' ')}
                        </Link>
                      </span>
                    ))}
                  </span>
                </span>
              )}
            </div>
          ) : null}
        </div>
        {failing.isLoading ? (
          <LoadingBlock label="Loading…" />
        ) : rows.length === 0 ? (
          <p className="flex items-center justify-center gap-2 py-10 text-body-sm text-success">
            <CircleCheck className="size-4" aria-hidden />
            {view === 'failing'
              ? 'Nothing failing — every applicable resource complies.'
              : 'No exemptions for this rule.'}
          </p>
        ) : (
          <>
            {selectable && (
              <div className="flex items-center gap-3 border-b border-line-subtle px-5 py-2 text-caption text-fg-muted">
                <input
                  type="checkbox"
                  className="size-3.5 cursor-pointer"
                  aria-label="Select all"
                  checked={chosen.length === rows.length && rows.length > 0}
                  onChange={() =>
                    setSelected(
                      chosen.length === rows.length
                        ? new Set()
                        : new Set(rows.map((r) => r.scopeId)),
                    )
                  }
                />
                {chosen.length
                  ? `${chosen.length} selected — actions apply to them`
                  : 'Select resources to act on some of them; otherwise actions apply to all'}
              </div>
            )}
            <ul className="divide-y divide-line-subtle">
              {rows.map((r) => (
                <Row
                  key={r.id}
                  row={r}
                  canManage={canManage}
                  selected={selected.has(r.scopeId)}
                  onToggle={selectable ? () => toggle(r.scopeId) : null}
                  onClose={onClose}
                />
              ))}
            </ul>
          </>
        )}
      </div>
    </Modal>
  );
}
