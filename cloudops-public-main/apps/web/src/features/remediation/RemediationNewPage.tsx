import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Play, Send, TriangleAlert, Wrench } from 'lucide-react';
import type { RemediationActionDto } from '@cloudops/core';
import { useRemediationActions, useRemediationPlan, useRequestRemediation, useStandardsSummary } from '../../lib/queries';
import { usePermissions } from '../../lib/auth';
import { apiErrorMessage } from '../../lib/api';
import { shortType } from '../../lib/format';
import {
  Alert,
  Badge,
  Button,
  EmptyState,
  Field,
  InlineError,
  Input,
  LoadingBlock,
  PageHeader,
  Panel,
  Spinner,
  Textarea,
  cn,
} from '../../components/ui/primitives';
import { ActionFacts, AvailabilityNote, RiskBadge } from './shared';
import { useDebounced } from '../../lib/useDebounced';

/**
 * Plan a remediation: choose the action, fill its parameters, review the dry
 * run (what changes where, the exact provider calls, what's skipped and why),
 * then request it. Medium/high risk goes to a second person for approval.
 */
export function RemediationNewPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const ruleId = params.get('rule') ?? undefined;
  const resourceIds = useMemo(() => (params.get('resources') ?? '').split(',').filter(Boolean), [params]);
  /** Inventory filter (the inventory page's query string) — bulk "everything matching". */
  const filterText = params.get('filter') ?? '';
  const filter = useMemo(() => (filterText ? Object.fromEntries(new URLSearchParams(filterText)) : undefined), [filterText]);
  const { can } = usePermissions();
  const actions = useRemediationActions();
  const summary = useStandardsSummary();
  const request = useRequestRemediation();

  const rule = useMemo(() => summary.data?.standards.flatMap((s) => s.rules).find((r) => r.id === ruleId) ?? null, [summary.data, ruleId]);
  const candidates: RemediationActionDto[] = useMemo(() => {
    const all = actions.data ?? [];
    if (ruleId) return rule?.template ? all.filter((a) => a.fixesRules.includes(rule.template!)) : [];
    return all;
  }, [actions.data, ruleId, rule]);

  const [actionKey, setActionKey] = useState<string>(params.get('action') ?? '');
  // Parameters can arrive pre-filled from where the change was started (`p.<key>=value`), e.g. drift → restore tags.
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries([...params.entries()].filter(([k]) => k.startsWith('p.')).map(([k, v]) => [k.slice(2), v])),
  );
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Default to the only / the requested action once the catalog loads.
  useEffect(() => {
    if (!actionKey && candidates.length === 1) setActionKey(candidates[0]!.key);
  }, [actionKey, candidates]);

  const action = candidates.find((a) => a.key === actionKey) ?? (actions.data ?? []).find((a) => a.key === actionKey) ?? null;
  const debouncedValues = useDebounced(values, 350);
  const targeting = action
    ? { actionKey: action.key, ruleId, resourceIds: resourceIds.length ? resourceIds : undefined, filter, params: debouncedValues }
    : null;
  const plan = useRemediationPlan(targeting);
  const missing = action?.params.filter((p) => p.required && !String(values[p.key] ?? '').trim()) ?? [];
  const canRequest = can('remediation.request');
  const runNow = Boolean(action && !action.requiresApproval && can('remediation.execute') && action.available);

  async function submit(executeNow: boolean) {
    if (!action) return;
    setError(null);
    try {
      const run = await request.mutateAsync({
        actionKey: action.key,
        ruleId,
        resourceIds: resourceIds.length ? resourceIds : undefined,
        filter,
        params: values,
        note: note.trim() || undefined,
        executeNow,
      });
      navigate(`/remediation/${run.id}`);
    } catch (e) {
      setError(apiErrorMessage(e));
    }
  }

  if (actions.isLoading || (ruleId && summary.isLoading)) return <LoadingBlock label="Loading actions…" className="min-h-[40vh]" />;

  return (
    <div>
      <PageHeader
        overline="Remediation"
        title="Plan a change"
        subtitle={
          rule
            ? `Fix “${rule.name}” — ${rule.failed} resource${rule.failed === 1 ? '' : 's'} failing.`
            : resourceIds.length
              ? `${resourceIds.length} selected resource${resourceIds.length === 1 ? '' : 's'}.`
              : filter
                ? 'Every resource matching your inventory filter (up to 500).'
                : 'Choose what to change.'
        }
      >
        <Link to={ruleId ? `/standards?rule=${ruleId}` : '/remediation'} className="mb-4 inline-flex items-center gap-1.5 text-body-sm text-fg-muted transition-colors duration-150 hover:text-fg">
          <ArrowLeft className="size-4" aria-hidden /> Back
        </Link>
      </PageHeader>

      {candidates.length === 0 ? (
        <EmptyState
          icon={Wrench}
          title="No automatic fix for this rule"
          description={rule?.remediation ? `How to fix it by hand: ${rule.remediation}` : 'CloudOps has no action that fixes this rule. Track it as a work item instead.'}
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-[22rem_minmax(0,1fr)]">
          <div className="space-y-4">
            <Panel title="1 · Action" flush>
              <ul role="radiogroup" aria-label="Action" className="divide-y divide-line-subtle">
                {candidates.map((a) => (
                  <li key={a.key}>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={a.key === actionKey}
                      onClick={() => setActionKey(a.key)}
                      className={cn(
                        'focus-inset flex w-full flex-col gap-1 px-4 py-3 text-left transition-colors duration-150',
                        a.key === actionKey ? 'bg-accent/[0.06]' : 'hover:bg-hover/50',
                      )}
                    >
                      <span className="flex items-center gap-2">
                        <span className={cn('size-3 shrink-0 rounded-full border', a.key === actionKey ? 'border-accent bg-accent' : 'border-line-strong')} aria-hidden />
                        <span className="text-body-sm font-medium text-fg">{a.title}</span>
                        <RiskBadge risk={a.risk} />
                      </span>
                      <span className="pl-5 text-caption text-fg-muted">{a.appliesTo}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </Panel>

            {action && (
              <Panel title="What it does">
                <p className="mb-3 text-body-sm text-fg-secondary">{action.description}</p>
                <ActionFacts action={action} />
                <div className="mt-3">
                  <AvailabilityNote action={action} />
                </div>
              </Panel>
            )}
          </div>

          <div className="space-y-4">
            {action && action.params.length > 0 && (
              <Panel title="2 · Parameters">
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  {action.params.map((p) => (
                    <Field key={p.key} label={p.label} required={p.required} hint={p.help}>
                      <Input
                        value={values[p.key] ?? ''}
                        onChange={(e) => setValues((v) => ({ ...v, [p.key]: e.target.value }))}
                        placeholder={p.placeholder}
                      />
                    </Field>
                  ))}
                </div>
              </Panel>
            )}

            {action && (
              <Panel
                flush
                title={
                  <span className="flex items-center gap-2">
                    {action.params.length ? '3' : '2'} · Preview (dry run)
                    {plan.isFetching && <Spinner />}
                  </span>
                }
                description={
                  plan.data
                    ? `${plan.data.willChange} will change · ${plan.data.skipped} skipped. Nothing has been changed yet.`
                    : 'What would change, on which resources, with the exact commands.'
                }
              >
                {plan.isError ? (
                  <div className="p-4">
                    <InlineError>{apiErrorMessage(plan.error)}</InlineError>
                  </div>
                ) : !plan.data ? (
                  <LoadingBlock label="Planning…" />
                ) : (
                  <>
                    {plan.data.warnings.length > 0 && (
                      <div className="space-y-2 p-3">
                        {plan.data.warnings.map((w) => (
                          <Alert key={w} tone={w.startsWith('High risk') || w.startsWith('Can’t be undone') ? 'danger' : 'warning'} icon={TriangleAlert}>
                            {w}
                          </Alert>
                        ))}
                      </div>
                    )}
                    <div className="max-h-[28rem] overflow-auto">
                      <table className="data-table data-table--compact">
                        <thead>
                          <tr>
                            <th scope="col">Resource</th>
                            <th scope="col">Now</th>
                            <th scope="col">After</th>
                          </tr>
                        </thead>
                        <tbody>
                          {plan.data.targets.map((t) => (
                            <tr key={t.resourceId} className={t.skip ? 'opacity-60' : undefined}>
                              <td>
                                <Link to={`/inventory/${t.resourceId}`} className="link-quiet font-medium">
                                  {t.name}
                                </Link>
                                <div className="text-caption text-fg-muted">
                                  {shortType(t.type)}
                                  {t.resourceGroup ? ` · ${t.resourceGroup}` : ''}
                                </div>
                                {t.command && (
                                  <code className="mt-1 block max-w-[44rem] break-all rounded-xs bg-canvas px-1.5 py-1 font-mono text-[11px] text-fg-secondary">{t.command}</code>
                                )}
                              </td>
                              <td className="font-mono text-caption">{t.current}</td>
                              <td className="font-mono text-caption">
                                {t.skip ? <Badge>skip: {t.skip}</Badge> : <span className="text-success">{t.desired}</span>}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </>
                )}
              </Panel>
            )}

            {action && canRequest && (
              <Panel title={`${action.params.length ? '4' : '3'} · Request`}>
                <Field label="Why" hint={action.requiresApproval ? 'Shown to the approver and kept in the record.' : 'Kept in the record.'}>
                  <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Security review finding SR-12; agreed with the app owner" />
                </Field>
                {error && <InlineError className="mt-3">{error}</InlineError>}
                <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
                  {action.requiresApproval ? (
                    <Button icon={Send} onClick={() => void submit(false)} loading={request.isPending} disabled={!plan.data?.willChange || missing.length > 0}>
                      Request approval
                    </Button>
                  ) : (
                    <>
                      <Button variant={runNow ? 'secondary' : 'primary'} icon={Send} onClick={() => void submit(false)} loading={request.isPending} disabled={!plan.data?.willChange || missing.length > 0}>
                        Save for later
                      </Button>
                      {runNow && (
                        <Button icon={Play} onClick={() => void submit(true)} loading={request.isPending} disabled={!plan.data?.willChange || missing.length > 0}>
                          Run now on {plan.data?.willChange ?? 0}
                        </Button>
                      )}
                    </>
                  )}
                </div>
                {!action.available && (
                  <p className="mt-3 text-right text-caption text-fg-muted">
                    You can still request it; it runs once write-back is enabled. <ArrowRight className="inline size-3" aria-hidden />
                  </p>
                )}
              </Panel>
            )}
            {action && !canRequest && (
              <Alert tone="info">You can preview this change, but requesting it needs the “remediation.request” permission.</Alert>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
