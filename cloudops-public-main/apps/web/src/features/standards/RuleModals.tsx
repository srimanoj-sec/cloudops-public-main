import { useMemo, useState } from 'react';
import { BookOpen, SlidersHorizontal, Wrench } from 'lucide-react';
import {
  RULE_CATEGORIES,
  RULE_CATEGORY_LABELS,
  STANDARD_SEVERITIES,
  type CreateRuleRequest,
  type PreviewRuleRequest,
  type RuleCategory,
  type RuleDefinition,
  type RuleScope,
  type RuleScoreDto,
  type RuleTemplateDto,
  type StandardSeverity,
} from '@cloudops/core';
import { useCreateCustomStandard, useCreateStandardRule, useStandardsLibrary, useUpdateStandardRule } from '../../lib/queries';
import { apiErrorMessage } from '../../lib/api';
import { Badge, Button, Checkbox, Field, InlineError, Input, SegmentedControl, Select, Switch, Textarea, TextButton, severityTone } from '../../components/ui/primitives';
import { Modal } from '../../components/ui/Modal';
import { useToast } from '../../components/ui/Toast';
import { ConditionsEditor, ParamFields, RulePreview, ScopeEditor } from './RuleEditors';
import { CategoryBadge } from './standardsUi';

type Mode = 'library' | 'conditions';
const EMPTY_DEF: RuleDefinition = { match: 'all', conditions: [{ field: 'tag', operator: 'exists', key: '' }] };

const hasScope = (s: RuleScope) =>
  Boolean(s.types?.length || s.locations?.length || s.subscriptionIds?.length || s.resourceGroupIds?.length || s.tagKey);

function TemplateSummary({ t }: { t: RuleTemplateDto }) {
  return (
    <div className="space-y-2 rounded-sm border border-line bg-canvas/40 p-3 text-body-sm">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone={severityTone(t.severity)}>{t.severity}</Badge>
        <CategoryBadge category={t.category} />
        <span className="text-caption text-fg-muted">Applies to: {t.appliesTo}</span>
      </div>
      <p className="text-fg-secondary">{t.description}</p>
      <p className="flex gap-1.5 text-caption text-fg-muted">
        <Wrench className="mt-0.5 size-3.5 shrink-0" aria-hidden /> {t.remediation}
      </p>
    </div>
  );
}

/** Create or edit a rule in a custom standard — from the library, or from conditions. */
export function RuleBuilderModal({
  standardId,
  rule,
  initialTemplate,
  onClose,
}: {
  standardId: string;
  rule?: RuleScoreDto;
  initialTemplate?: string;
  onClose: () => void;
}) {
  const library = useStandardsLibrary();
  const create = useCreateStandardRule();
  const update = useUpdateStandardRule();
  const toast = useToast();
  const editing = Boolean(rule);

  const [mode, setMode] = useState<Mode>(rule && !rule.template ? 'conditions' : 'library');
  const [templateKey, setTemplateKey] = useState(rule?.template ?? initialTemplate ?? '');
  const [params, setParams] = useState<Record<string, unknown>>(rule?.params ?? {});
  const [definition, setDefinition] = useState<RuleDefinition>(rule?.definition ?? EMPTY_DEF);
  const [scope, setScope] = useState<RuleScope>(rule?.scope ?? {});
  const [showScope, setShowScope] = useState(Boolean(rule?.scope && hasScope(rule.scope)));
  const [name, setName] = useState(rule?.name ?? '');
  const [severity, setSeverity] = useState<StandardSeverity>((rule?.severity as StandardSeverity) ?? 'medium');
  const [category, setCategory] = useState<RuleCategory>(rule?.category ?? 'governance');
  const [remediation, setRemediation] = useState(rule?.template ? '' : (rule?.remediation ?? ''));
  const [error, setError] = useState<string | null>(null);

  const template = library.data?.find((t) => t.key === templateKey);
  const grouped = useMemo(() => {
    const m = new Map<RuleCategory, RuleTemplateDto[]>();
    for (const t of library.data ?? []) m.set(t.category, [...(m.get(t.category) ?? []), t]);
    return [...m.entries()];
  }, [library.data]);

  function pickTemplate(key: string) {
    setTemplateKey(key);
    const t = library.data?.find((x) => x.key === key);
    if (t) {
      setParams({});
      setSeverity(t.severity);
      if (!name.trim() || library.data?.some((x) => x.name === name)) setName(t.name);
    }
  }

  const payload: PreviewRuleRequest | null = useMemo(() => {
    const scoped = showScope && hasScope(scope) ? scope : undefined;
    if (mode === 'library') {
      return templateKey ? { severity, template: templateKey, params, scope: scoped } : null;
    }
    return { severity, category, definition, scope: scoped };
  }, [mode, templateKey, params, definition, scope, showScope, severity, category]);

  async function save() {
    if (!payload) return;
    setError(null);
    const input: CreateRuleRequest = {
      ...payload,
      name: name.trim() || template?.name || 'Custom rule',
      severity,
      remediation: mode === 'conditions' ? remediation.trim() || undefined : undefined,
    };
    try {
      if (editing) {
        await update.mutateAsync({
          id: rule!.id,
          input: {
            name: input.name,
            severity,
            ...(mode === 'library' ? { params } : { definition, category, remediation: remediation.trim() || null }),
            scope: payload.scope ?? null,
          },
        });
      } else {
        await create.mutateAsync({ standardId, input });
      }
      toast({ title: editing ? 'Rule saved' : 'Rule added', description: 'Run an evaluation to score it across the estate.' });
      onClose();
    } catch (e) {
      setError(apiErrorMessage(e));
    }
  }

  return (
    <Modal
      size="lg"
      title={editing ? 'Edit rule' : 'Add rule'}
      description="Pick a ready-made rule from the library, or describe your own with conditions. The preview runs against your current inventory."
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={!payload} loading={create.isPending || update.isPending}>
            {editing ? 'Save rule' : 'Add rule'}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        {!editing && (
          <SegmentedControl
            label="Rule source"
            value={mode}
            onChange={setMode}
            options={[
              { value: 'library', label: <span className="inline-flex items-center gap-1.5"><BookOpen className="size-3.5" aria-hidden /> From the library</span> },
              { value: 'conditions', label: <span className="inline-flex items-center gap-1.5"><SlidersHorizontal className="size-3.5" aria-hidden /> Custom conditions</span> },
            ]}
          />
        )}

        {mode === 'library' ? (
          <div className="space-y-3">
            <Field label="Library rule" required>
              <Select className="w-full" value={templateKey} onChange={(e) => pickTemplate(e.target.value)} disabled={editing}>
                <option value="">Choose a rule…</option>
                {grouped.map(([cat, list]) => (
                  <optgroup key={cat} label={RULE_CATEGORY_LABELS[cat]}>
                    {list.map((t) => (
                      <option key={t.key} value={t.key}>
                        {t.name}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </Select>
            </Field>
            {template && <TemplateSummary t={template} />}
            {template && template.params.length > 0 && <ParamFields specs={template.params} values={params} onChange={setParams} />}
          </div>
        ) : (
          <div className="space-y-3">
            <ConditionsEditor value={definition} onChange={setDefinition} />
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Category">
                <Select className="w-full" value={category} onChange={(e) => setCategory(e.target.value as RuleCategory)}>
                  {RULE_CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {RULE_CATEGORY_LABELS[c]}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="How to fix" hint="Shown next to every failing resource">
                <Textarea rows={2} value={remediation} onChange={(e) => setRemediation(e.target.value)} placeholder="e.g. Add the data-classification tag in Azure" />
              </Field>
            </div>
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_10rem]">
          <Field label="Rule name" required>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={template?.name ?? 'e.g. Production VMs must use SSH keys'} />
          </Field>
          <Field label="Severity">
            <Select className="w-full" value={severity} onChange={(e) => setSeverity(e.target.value as StandardSeverity)}>
              {STANDARD_SEVERITIES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-body-sm text-fg">Limit which resources it checks</div>
              <div className="text-caption text-fg-muted">By type, region, subscription or tag. Off = every resource the rule applies to.</div>
            </div>
            <Switch checked={showScope} onChange={setShowScope} label="Limit scope" />
          </div>
          {showScope && <ScopeEditor value={scope} onChange={setScope} />}
        </div>

        <RulePreview input={payload} />
        {error && <InlineError>{error}</InlineError>}
      </div>
    </Modal>
  );
}

/** Built-in rule: switch it on/off, override severity, set parameters — with a live preview. */
export function RuleSettingsModal({ rule, onClose }: { rule: RuleScoreDto; onClose: () => void }) {
  const library = useStandardsLibrary();
  const update = useUpdateStandardRule();
  const toast = useToast();
  const template = library.data?.find((t) => t.key === rule.template);
  const [enabled, setEnabled] = useState(rule.enabled);
  const [severity, setSeverity] = useState<StandardSeverity>(rule.severity as StandardSeverity);
  const [params, setParams] = useState<Record<string, unknown>>(rule.params ?? {});
  const [error, setError] = useState<string | null>(null);

  const payload: PreviewRuleRequest | null = rule.template ? { severity, template: rule.template, params } : null;

  async function save() {
    setError(null);
    try {
      await update.mutateAsync({ id: rule.id, input: { enabled, severity, ...(template?.params.length ? { params } : {}) } });
      toast({ title: 'Rule updated', description: 'Run an evaluation to apply it.' });
      onClose();
    } catch (e) {
      setError(apiErrorMessage(e));
    }
  }

  return (
    <Modal
      size="lg"
      title={rule.name}
      description="Built-in rule — the check itself is maintained with CloudOps; the switch, severity and parameters are yours."
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void save()} loading={update.isPending}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        {template && <TemplateSummary t={template} />}
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex items-center justify-between gap-3 rounded-sm border border-line px-3 py-2">
            <span className="text-body-sm text-fg">Rule enabled</span>
            <Switch checked={enabled} onChange={setEnabled} label="Rule enabled" />
          </div>
          <Field label="Severity">
            <Select className="w-full" value={severity} onChange={(e) => setSeverity(e.target.value as StandardSeverity)}>
              {STANDARD_SEVERITIES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        {template && template.params.length > 0 && <ParamFields specs={template.params} values={params} onChange={setParams} />}
        <RulePreview input={payload} />
        {error && <InlineError>{error}</InlineError>}
      </div>
    </Modal>
  );
}

/** Create a custom standard, optionally seeded with library rules. */
export function NewStandardModal({ onClose }: { onClose: () => void }) {
  const create = useCreateCustomStandard();
  const library = useStandardsLibrary();
  const toast = useToast();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Rules that need parameters can't be added blind — they're added (and configured) afterwards.
  const ready = (library.data ?? []).filter((t) => !t.params.some((p) => p.required && p.default === undefined));

  async function save() {
    setError(null);
    try {
      await create.mutateAsync({ name: name.trim(), description: description.trim() || undefined, templates: picked });
      toast({ title: 'Standard created', description: picked.length ? `With ${picked.length} rule(s). Run an evaluation to score it.` : 'Add rules to it, then run an evaluation.' });
      onClose();
    } catch (e) {
      setError(apiErrorMessage(e));
    }
  }

  return (
    <Modal
      size="md"
      title="New standard"
      description="A standard groups the rules one policy cares about — e.g. “Production readiness” or “PCI workloads”."
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={!name.trim()} loading={create.isPending}>
            Create standard{picked.length ? ` with ${picked.length} rule(s)` : ''}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Name" required>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Production readiness" autoFocus />
        </Field>
        <Field label="Description">
          <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What this standard enforces" />
        </Field>
        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-body-sm text-fg">Start with rules from the library (optional)</span>
            {picked.length > 0 && (
              <TextButton tone="muted" onClick={() => setPicked([])}>
                Clear
              </TextButton>
            )}
          </div>
          <div className="max-h-72 space-y-3 overflow-y-auto rounded-sm border border-line p-3">
            {RULE_CATEGORIES.map((cat) => {
              const list = ready.filter((t) => t.category === cat);
              if (list.length === 0) return null;
              return (
                <div key={cat}>
                  <div className="mb-1 font-mono text-overline uppercase text-fg-muted">{RULE_CATEGORY_LABELS[cat]}</div>
                  <div className="space-y-1">
                    {list.map((t) => (
                      <Checkbox key={t.key} checked={picked.includes(t.key)} onChange={() => setPicked((p) => (p.includes(t.key) ? p.filter((k) => k !== t.key) : [...p, t.key]))}>
                        <span className="text-body-sm text-fg">{t.name}</span>
                        <span className="ml-1.5 text-caption text-fg-muted">· {t.appliesTo}</span>
                      </Checkbox>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
          <p className="mt-1.5 text-caption text-fg-muted">Rules that need settings (allowed regions, required tags…) are added afterwards with “Add rule”.</p>
        </div>
        {error && <InlineError>{error}</InlineError>}
      </div>
    </Modal>
  );
}
