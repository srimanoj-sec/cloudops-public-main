import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Bell, Eye, Plus, SquareKanban, Trash2 } from 'lucide-react';
import {
  AUTOMATION_TRIGGERS,
  AUTOMATION_TRIGGER_INFO,
  COST_ANOMALY_KINDS,
  NOTIFICATION_SEVERITIES,
  PERMISSIONS,
  PERMISSION_KEYS,
  STANDARD_SEVERITIES,
  WORK_ITEM_TYPES,
  type AutomationAction,
  type AutomationConditions,
  type AutomationRuleDto,
  type AutomationRuleRequest,
  type AutomationTrigger,
  type Permission,
} from '@cloudops/core';
import {
  useAutomationPreview,
  useDirectory,
  useSaveAutomationRule,
  useStandardsSummary,
} from '../../lib/queries';
import { apiErrorMessage } from '../../lib/api';
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Field,
  IconButton,
  InlineError,
  Input,
  LoadingBlock,
  Select,
  Switch,
  Textarea,
} from '../../components/ui/primitives';
import { MultiSelect } from '../../components/ui/MultiSelect';
import { Modal } from '../../components/ui/Modal';
import { useToast } from '../../components/ui/Toast';

const DRIFT_FIELDS = ['tags', 'owner', 'sku', 'location', 'state', 'name', 'type'] as const;
const KIND_LABEL: Record<string, string> = {
  spike: 'Spikes',
  'new-resource': 'New spend',
  'new-region': 'New region',
};

const DEFAULT_ACTIONS: Record<AutomationAction['type'], AutomationAction> = {
  'create-work-item': { type: 'create-work-item', workType: 'task', priority: 3 },
  notify: { type: 'notify', audience: null, severity: 'medium' },
};

/** Create or edit an automation rule, with a live "what would this match today" preview. */
export function RuleEditor({ rule, onClose }: { rule?: AutomationRuleDto; onClose: () => void }) {
  const save = useSaveAutomationRule();
  const preview = useAutomationPreview();
  const toast = useToast();
  const standards = useStandardsSummary();
  const directory = useDirectory();

  const [name, setName] = useState(rule?.name ?? '');
  const [description, setDescription] = useState(rule?.description ?? '');
  const [enabled, setEnabled] = useState(rule?.enabled ?? true);
  const [trigger, setTrigger] = useState<AutomationTrigger>(
    rule?.trigger ?? 'compliance.new-failures',
  );
  const [conditions, setConditions] = useState<AutomationConditions>(rule?.conditions ?? {});
  const [actions, setActions] = useState<AutomationAction[]>(
    rule?.actions ?? [DEFAULT_ACTIONS['create-work-item']],
  );
  const [error, setError] = useState<string | null>(null);

  const info = AUTOMATION_TRIGGER_INFO[trigger];
  const ruleOptions = useMemo(
    () =>
      (standards.data?.standards ?? []).flatMap((s) =>
        s.rules.map((r) => ({ value: r.id, label: `${r.name} (${s.name})` })),
      ),
    [standards.data],
  );

  // Only the conditions that apply to the chosen trigger are sent.
  const draft: AutomationRuleRequest = {
    name: name.trim(),
    description: description.trim() || undefined,
    enabled,
    trigger,
    conditions: Object.fromEntries(
      Object.entries(conditions).filter(
        ([k, v]) =>
          info.conditions.includes(k as keyof AutomationConditions) &&
          v !== undefined &&
          !(Array.isArray(v) && !v.length),
      ),
    ),
    actions,
  };

  const setCond = <K extends keyof AutomationConditions>(
    k: K,
    v: AutomationConditions[K] | undefined,
  ) => setConditions((c) => ({ ...c, [k]: v }));
  const setAction = (i: number, a: AutomationAction) =>
    setActions((list) => list.map((x, j) => (j === i ? a : x)));

  async function submit() {
    setError(null);
    try {
      await save.mutateAsync({ id: rule?.id, rule: draft });
      toast({
        title: rule ? 'Rule saved' : 'Rule created',
        description: enabled
          ? 'It runs on the next matching event.'
          : 'It is disabled until you turn it on.',
      });
      onClose();
    } catch (e) {
      setError(apiErrorMessage(e));
    }
  }

  return (
    <Modal
      size="lg"
      title={rule ? `Edit “${rule.name}”` : 'New automation rule'}
      description="When something happens, if it matches, CloudOps tells people or raises work. Rules never change the cloud — fixes go through remediation, with preview and approval."
      onClose={onClose}
      footer={
        <div className="flex w-full flex-wrap items-center justify-end gap-2">
          <Button
            variant="ghost"
            icon={Eye}
            className="mr-auto"
            loading={preview.isPending}
            disabled={!actions.length}
            onClick={() =>
              preview.mutate({
                ...draft,
                name: draft.name || 'Preview',
                ...(rule ? { ruleId: rule.id } : {}),
              })
            }
          >
            Preview with today’s data
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => void submit()}
            loading={save.isPending}
            disabled={!draft.name || !actions.length}
          >
            {rule ? 'Save rule' : 'Create rule'}
          </Button>
        </div>
      }
    >
      <div className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_auto]">
          <Field label="Name" required>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. High-severity findings become security work"
              maxLength={120}
            />
          </Field>
          <div className="flex items-center gap-2 pt-6 text-body-sm text-fg-secondary">
            <Switch checked={enabled} onChange={setEnabled} label="Enabled" />
            <span aria-hidden>{enabled ? 'Enabled' : 'Disabled'}</span>
          </div>
        </div>
        <Field label="Description" hint="Optional — why this rule exists.">
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            maxLength={1000}
          />
        </Field>

        <section className="rounded-sm border border-line p-4">
          <h3 className="mb-3 font-mono text-overline uppercase text-accent/90">When</h3>
          <Field label="Trigger" hint={info.description}>
            <Select
              value={trigger}
              onChange={(e) => setTrigger(e.target.value as AutomationTrigger)}
            >
              {AUTOMATION_TRIGGERS.map((t) => (
                <option key={t} value={t}>
                  {AUTOMATION_TRIGGER_INFO[t].label}
                </option>
              ))}
            </Select>
          </Field>
        </section>

        <section className="rounded-sm border border-line p-4">
          <h3 className="mb-3 font-mono text-overline uppercase text-accent/90">If</h3>
          {info.conditions.length === 0 ? (
            <p className="text-caption text-fg-muted">Every occurrence matches.</p>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              {info.conditions.includes('minSeverity') && (
                <Field label="Severity at least">
                  <Select
                    value={conditions.minSeverity ?? ''}
                    onChange={(e) =>
                      setCond(
                        'minSeverity',
                        (e.target.value || undefined) as AutomationConditions['minSeverity'],
                      )
                    }
                  >
                    <option value="">Any severity</option>
                    {[...STANDARD_SEVERITIES].reverse().map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </Select>
                </Field>
              )}
              {info.conditions.includes('minResources') && (
                <Field label="At least this many resources">
                  <Input
                    type="number"
                    min={1}
                    value={conditions.minResources ?? ''}
                    onChange={(e) =>
                      setCond('minResources', e.target.value ? Number(e.target.value) : undefined)
                    }
                    placeholder="1"
                  />
                </Field>
              )}
              {info.conditions.includes('ruleIds') && (
                <div className="sm:col-span-2">
                  <div className="mb-1.5 text-label text-fg-secondary">Only these rules</div>
                  <MultiSelect
                    label={
                      conditions.ruleIds?.length
                        ? `${conditions.ruleIds.length} rule(s)`
                        : 'Every rule'
                    }
                    options={ruleOptions}
                    selected={conditions.ruleIds ?? []}
                    onChange={(v) => setCond('ruleIds', v)}
                  />
                </div>
              )}
              {info.conditions.includes('minMonthlyImpact') && (
                <Field
                  label="Monthly impact at least"
                  hint="Extra cost per month if the latest day’s level persists."
                >
                  <Input
                    type="number"
                    min={0}
                    value={conditions.minMonthlyImpact ?? ''}
                    onChange={(e) =>
                      setCond(
                        'minMonthlyImpact',
                        e.target.value ? Number(e.target.value) : undefined,
                      )
                    }
                    placeholder="0"
                  />
                </Field>
              )}
              {info.conditions.includes('anomalyKinds') && (
                <fieldset>
                  <legend className="mb-1.5 text-label text-fg-secondary">Kinds</legend>
                  {COST_ANOMALY_KINDS.map((k) => {
                    const on =
                      !conditions.anomalyKinds?.length || conditions.anomalyKinds.includes(k);
                    return (
                      <Checkbox
                        key={k}
                        checked={on}
                        onChange={() => {
                          const current = conditions.anomalyKinds?.length
                            ? conditions.anomalyKinds
                            : [...COST_ANOMALY_KINDS];
                          const next = on ? current.filter((x) => x !== k) : [...current, k];
                          setCond(
                            'anomalyKinds',
                            next.length === COST_ANOMALY_KINDS.length ? undefined : next,
                          );
                        }}
                      >
                        {KIND_LABEL[k]}
                      </Checkbox>
                    );
                  })}
                </fieldset>
              )}
              {info.conditions.includes('budgetStatus') && (
                <Field label="Budgets">
                  <Select
                    value={conditions.budgetStatus ?? 'at-risk'}
                    onChange={(e) => setCond('budgetStatus', e.target.value as 'at-risk' | 'over')}
                  >
                    <option value="at-risk">Forecast to cross the alert threshold, or over</option>
                    <option value="over">Only when already over</option>
                  </Select>
                </Field>
              )}
              {info.conditions.includes('fields') && (
                <fieldset className="sm:col-span-2">
                  <legend className="mb-1.5 text-label text-fg-secondary">Changed fields</legend>
                  <div className="flex flex-wrap gap-x-4">
                    {DRIFT_FIELDS.map((f) => {
                      const on = !conditions.fields?.length || conditions.fields.includes(f);
                      return (
                        <Checkbox
                          key={f}
                          checked={on}
                          onChange={() => {
                            const current = conditions.fields?.length
                              ? conditions.fields
                              : [...DRIFT_FIELDS];
                            const next = on ? current.filter((x) => x !== f) : [...current, f];
                            setCond(
                              'fields',
                              next.length === DRIFT_FIELDS.length ? undefined : next,
                            );
                          }}
                        >
                          {f}
                        </Checkbox>
                      );
                    })}
                  </div>
                </fieldset>
              )}
            </div>
          )}
        </section>

        <section className="rounded-sm border border-line p-4">
          <div className="mb-3 flex items-center justify-between gap-2">
            <h3 className="font-mono text-overline uppercase text-accent/90">Then</h3>
            {actions.length < 5 && (
              <div className="flex gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  icon={Plus}
                  onClick={() => setActions((a) => [...a, DEFAULT_ACTIONS['create-work-item']])}
                >
                  Work item
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  icon={Plus}
                  onClick={() => setActions((a) => [...a, DEFAULT_ACTIONS.notify])}
                >
                  Notify
                </Button>
              </div>
            )}
          </div>
          {!actions.length && <p className="text-caption text-warning">Add at least one action.</p>}
          <ul className="space-y-3">
            {actions.map((a, i) => (
              <li key={i} className="rounded-sm border border-line-subtle bg-canvas/50 p-3">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <span className="flex items-center gap-2 text-body-sm font-medium text-fg">
                    {a.type === 'notify' ? (
                      <Bell className="size-4 text-fg-muted" aria-hidden />
                    ) : (
                      <SquareKanban className="size-4 text-fg-muted" aria-hidden />
                    )}
                    {a.type === 'notify' ? 'Send a notification' : 'Raise a work item'}
                  </span>
                  <IconButton
                    icon={Trash2}
                    label="Remove action"
                    size="sm"
                    variant="danger-ghost"
                    onClick={() => setActions((list) => list.filter((_, j) => j !== i))}
                  />
                </div>
                {a.type === 'notify' ? (
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="To">
                      <Select
                        value={a.audience ?? ''}
                        onChange={(e) =>
                          setAction(i, {
                            ...a,
                            audience: (e.target.value || null) as Permission | null,
                          })
                        }
                      >
                        <option value="">Everyone</option>
                        {PERMISSION_KEYS.map((p) => (
                          <option key={p} value={p}>
                            People who can: {PERMISSIONS[p].toLowerCase()}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field label="Severity">
                      <Select
                        value={a.severity}
                        onChange={(e) =>
                          setAction(i, { ...a, severity: e.target.value as typeof a.severity })
                        }
                      >
                        {NOTIFICATION_SEVERITIES.map((s) => (
                          <option key={s} value={s}>
                            {s}
                          </option>
                        ))}
                      </Select>
                    </Field>
                  </div>
                ) : (
                  <div className="grid gap-3 sm:grid-cols-4">
                    <Field label="Type">
                      <Select
                        value={a.workType}
                        onChange={(e) =>
                          setAction(i, { ...a, workType: e.target.value as typeof a.workType })
                        }
                      >
                        {WORK_ITEM_TYPES.map((t) => (
                          <option key={t} value={t}>
                            {t}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field label="Priority">
                      <Select
                        value={String(a.priority)}
                        onChange={(e) => setAction(i, { ...a, priority: Number(e.target.value) })}
                      >
                        {[1, 2, 3, 4, 5].map((p) => (
                          <option key={p} value={p}>
                            P{p}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field label="Assignee">
                      <Input
                        list="automation-people"
                        value={a.assignee ?? ''}
                        onChange={(e) =>
                          setAction(i, { ...a, assignee: e.target.value || undefined })
                        }
                        placeholder="Unassigned"
                      />
                    </Field>
                    <Field label="Due in (days)">
                      <Input
                        type="number"
                        min={0}
                        max={365}
                        value={a.dueInDays ?? ''}
                        onChange={(e) =>
                          setAction(i, {
                            ...a,
                            dueInDays: e.target.value ? Number(e.target.value) : undefined,
                          })
                        }
                        placeholder="—"
                      />
                    </Field>
                  </div>
                )}
              </li>
            ))}
          </ul>
          <datalist id="automation-people">
            {directory.data?.map((u) => (
              <option key={u.id} value={u.name} />
            ))}
          </datalist>
          <p className="mt-3 text-caption text-fg-muted">
            A work item isn’t raised again while one for the same condition is still open. Each
            firing acts on at most 25 matches.
          </p>
        </section>

        {(preview.data || preview.isPending || preview.isError) && (
          <section className="rounded-sm border border-accent/30 bg-accent/5 p-4">
            <h3 className="mb-2 flex items-center gap-2 text-body-sm font-medium text-fg">
              <Eye className="size-4 text-accent" aria-hidden /> With today’s data
            </h3>
            {preview.isPending ? (
              <LoadingBlock label="Checking…" />
            ) : preview.isError ? (
              <InlineError>{apiErrorMessage(preview.error)}</InlineError>
            ) : (
              preview.data && (
                <div className="space-y-2 text-caption">
                  <p className="text-fg-muted">{preview.data.basis}</p>
                  {preview.data.total === 0 ? (
                    <p className="text-fg-secondary">Nothing matches right now.</p>
                  ) : (
                    <>
                      <p className="text-fg-secondary">
                        {preview.data.total} match{preview.data.total === 1 ? '' : 'es'}
                        {preview.data.total > preview.data.matches.length
                          ? ` (the first ${preview.data.matches.length} would be acted on)`
                          : ''}
                        :
                      </p>
                      <ul className="max-h-40 space-y-1 overflow-y-auto">
                        {preview.data.matches.map((m) => (
                          <li key={m.key} className="flex items-center gap-2">
                            <Badge
                              tone={
                                m.severity === 'high'
                                  ? 'danger'
                                  : m.severity === 'medium'
                                    ? 'warning'
                                    : 'neutral'
                              }
                            >
                              {m.severity}
                            </Badge>
                            {m.link ? (
                              <Link to={m.link} className="link-quiet truncate" target="_blank">
                                {m.title}
                              </Link>
                            ) : (
                              <span className="truncate">{m.title}</span>
                            )}
                          </li>
                        ))}
                      </ul>
                      <ul className="list-disc space-y-0.5 pl-5 text-fg">
                        {preview.data.wouldDo.map((w) => (
                          <li key={w}>{w}</li>
                        ))}
                      </ul>
                    </>
                  )}
                </div>
              )
            )}
          </section>
        )}
        {error && <Alert tone="danger">{error}</Alert>}
      </div>
    </Modal>
  );
}
