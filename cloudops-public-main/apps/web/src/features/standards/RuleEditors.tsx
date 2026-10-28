import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { CircleCheck, CircleX, Plus, Trash2 } from 'lucide-react';
import {
  CONDITION_FIELDS,
  CONDITION_FIELD_LABELS,
  CONDITION_OPERATOR_LABELS,
  NUMERIC_FIELDS,
  VALUELESS_OPERATORS,
  type ConditionField,
  type ConditionOperator,
  type PreviewRuleRequest,
  type RuleCondition,
  type RuleDefinition,
  type RuleParamSpec,
  type RuleScope,
} from '@cloudops/core';
import { useFacets, usePreviewRule } from '../../lib/queries';
import { apiErrorMessage } from '../../lib/api';
import { shortType } from '../../lib/format';
import { Button, Field, IconButton, Input, SegmentedControl, Select, Spinner, Switch, cn } from '../../components/ui/primitives';
import { MultiSelect } from '../../components/ui/MultiSelect';

type Params = Record<string, unknown>;

const asList = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(String) : typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : [];

/** Inputs for a library rule's parameters, typed by kind. */
export function ParamFields({ specs, values, onChange }: { specs: RuleParamSpec[]; values: Params; onChange: (next: Params) => void }) {
  const facets = useFacets();
  const listId = useId();
  if (specs.length === 0) return null;
  const set = (key: string, v: unknown) => onChange({ ...values, [key]: v });
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <datalist id={listId}>
        {facets.data?.tagKeys.map((k) => <option key={k} value={k} />)}
      </datalist>
      {specs.map((s) => {
        const v = values[s.key] ?? s.default;
        const common = { label: s.label, hint: s.help, required: s.required };
        switch (s.kind) {
          case 'boolean':
            return (
              <div key={s.key} className="flex items-center justify-between gap-3 rounded-sm border border-line px-3 py-2 sm:col-span-2">
                <div>
                  <div className="text-body-sm text-fg">{s.label}</div>
                  {s.help && <div className="text-caption text-fg-muted">{s.help}</div>}
                </div>
                <Switch checked={v !== false} onChange={(next) => set(s.key, next)} label={s.label} />
              </div>
            );
          case 'number':
            return (
              <Field key={s.key} {...common}>
                <Input type="number" value={v == null ? '' : String(v)} onChange={(e) => set(s.key, e.target.value === '' ? undefined : Number(e.target.value))} />
              </Field>
            );
          case 'locations':
            return (
              <Field key={s.key} {...common} className="sm:col-span-2">
                <MultiSelect label={asList(v).length ? `${asList(v).length} region(s)` : 'Choose regions'} options={(facets.data?.locations ?? []).map((l) => ({ value: l }))} selected={asList(v)} onChange={(next) => set(s.key, next)} />
                {asList(v).length > 0 && <div className="mt-1 font-mono text-caption text-fg-secondary">{asList(v).join(', ')}</div>}
              </Field>
            );
          case 'types':
            return (
              <Field key={s.key} {...common} className="sm:col-span-2">
                <MultiSelect
                  label={asList(v).length ? `${asList(v).length} type(s)` : 'Choose resource types'}
                  options={(facets.data?.types ?? []).map((t) => ({ value: t, label: shortType(t) }))}
                  selected={asList(v)}
                  onChange={(next) => set(s.key, next)}
                />
              </Field>
            );
          case 'stringList':
            return (
              <Field key={s.key} {...common} className="sm:col-span-2" hint={s.help ?? 'Comma-separated'}>
                <Input className="font-mono" value={asList(v).join(', ')} placeholder={s.placeholder} onChange={(e) => set(s.key, asList(e.target.value))} />
              </Field>
            );
          default:
            return (
              <Field key={s.key} {...common}>
                <Input
                  className={s.kind === 'regex' ? 'font-mono' : undefined}
                  list={s.kind === 'tagKey' ? listId : undefined}
                  value={v == null ? '' : String(v)}
                  placeholder={s.placeholder}
                  onChange={(e) => set(s.key, e.target.value)}
                />
              </Field>
            );
        }
      })}
    </div>
  );
}

// ── Conditions ──────────────────────────────────────────────────────

const TEXT_OPS: ConditionOperator[] = ['exists', 'not_exists', 'equals', 'not_equals', 'contains', 'not_contains', 'starts_with', 'ends_with', 'matches', 'in', 'not_in'];
const NUMBER_OPS: ConditionOperator[] = ['exists', 'not_exists', 'equals', 'not_equals', 'gt', 'gte', 'lt', 'lte'];

function operatorsFor(field: ConditionField): ConditionOperator[] {
  if (NUMERIC_FIELDS.includes(field)) return NUMBER_OPS;
  if (field === 'property') return [...TEXT_OPS, 'is_true', 'is_false', 'gt', 'gte', 'lt', 'lte'];
  return TEXT_OPS;
}

function ConditionRow({
  c,
  onChange,
  onRemove,
  tagListId,
  removable,
}: {
  c: RuleCondition;
  onChange: (next: RuleCondition) => void;
  onRemove: () => void;
  tagListId: string;
  removable: boolean;
}) {
  const ops = operatorsFor(c.field);
  const needsKey = c.field === 'tag' || c.field === 'property';
  const valueless = VALUELESS_OPERATORS.includes(c.operator);
  return (
    <div className="grid grid-cols-1 gap-2 rounded-sm border border-line bg-canvas/40 p-2 sm:grid-cols-[10rem_minmax(0,1fr)_9rem_minmax(0,1fr)_auto] sm:items-center">
      <Select
        aria-label="Field"
        value={c.field}
        onChange={(e) => {
          const field = e.target.value as ConditionField;
          const allowed = operatorsFor(field);
          onChange({ field, operator: allowed.includes(c.operator) ? c.operator : 'exists', key: undefined, value: c.value });
        }}
      >
        {CONDITION_FIELDS.map((f) => (
          <option key={f} value={f}>
            {CONDITION_FIELD_LABELS[f]}
          </option>
        ))}
      </Select>
      {needsKey ? (
        <Input
          aria-label={c.field === 'tag' ? 'Tag name' : 'Property path'}
          className="font-mono"
          list={c.field === 'tag' ? tagListId : undefined}
          value={c.key ?? ''}
          placeholder={c.field === 'tag' ? 'tag name' : 'e.g. httpsOnly · networkAcls.defaultAction'}
          onChange={(e) => onChange({ ...c, key: e.target.value })}
        />
      ) : (
        <span className="hidden sm:block" />
      )}
      <Select aria-label="Operator" value={c.operator} onChange={(e) => onChange({ ...c, operator: e.target.value as ConditionOperator })}>
        {ops.map((o) => (
          <option key={o} value={o}>
            {CONDITION_OPERATOR_LABELS[o]}
          </option>
        ))}
      </Select>
      {valueless ? (
        <span className="hidden sm:block" />
      ) : (
        <Input
          aria-label="Value"
          className="font-mono"
          value={c.value ?? ''}
          placeholder={c.operator === 'in' || c.operator === 'not_in' ? 'a, b, c' : c.operator === 'matches' ? '^prod-' : 'value'}
          onChange={(e) => onChange({ ...c, value: e.target.value })}
        />
      )}
      <IconButton icon={Trash2} label="Remove condition" size="sm" variant="danger-ghost" onClick={onRemove} disabled={!removable} />
    </div>
  );
}

export function ConditionsEditor({ value, onChange }: { value: RuleDefinition; onChange: (next: RuleDefinition) => void }) {
  const facets = useFacets();
  const tagListId = useId();
  const update = (i: number, c: RuleCondition) => onChange({ ...value, conditions: value.conditions.map((x, j) => (j === i ? c : x)) });
  return (
    <div className="space-y-2">
      <datalist id={tagListId}>
        {facets.data?.tagKeys.map((k) => <option key={k} value={k} />)}
      </datalist>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-body-sm text-fg-secondary">A resource passes when</span>
        <SegmentedControl
          label="Match"
          size="sm"
          value={value.match}
          onChange={(match) => onChange({ ...value, match })}
          options={[
            { value: 'all', label: 'all conditions hold' },
            { value: 'any', label: 'any condition holds' },
          ]}
        />
      </div>
      {value.conditions.map((c, i) => (
        <ConditionRow
          key={i}
          c={c}
          tagListId={tagListId}
          removable={value.conditions.length > 1}
          onChange={(next) => update(i, next)}
          onRemove={() => onChange({ ...value, conditions: value.conditions.filter((_, j) => j !== i) })}
        />
      ))}
      <Button
        variant="secondary"
        size="sm"
        icon={Plus}
        disabled={value.conditions.length >= 10}
        onClick={() => onChange({ ...value, conditions: [...value.conditions, { field: 'tag', operator: 'exists' }] })}
      >
        Add condition
      </Button>
    </div>
  );
}

// ── Scope ───────────────────────────────────────────────────────────

export function ScopeEditor({ value, onChange }: { value: RuleScope; onChange: (next: RuleScope) => void }) {
  const facets = useFacets();
  const listId = useId();
  const set = <K extends keyof RuleScope>(k: K, v: RuleScope[K]) => onChange({ ...value, [k]: v });
  return (
    <div className="space-y-2">
      <datalist id={listId}>
        {facets.data?.tagKeys.map((k) => <option key={k} value={k} />)}
      </datalist>
      <div className="flex flex-wrap gap-2">
        <MultiSelect label="Types" options={(facets.data?.types ?? []).map((t) => ({ value: t.toLowerCase(), label: shortType(t) }))} selected={value.types ?? []} onChange={(v) => set('types', v)} />
        <MultiSelect label="Regions" options={(facets.data?.locations ?? []).map((l) => ({ value: l }))} selected={value.locations ?? []} onChange={(v) => set('locations', v)} />
        <MultiSelect
          label="Subscriptions"
          options={(facets.data?.subscriptions ?? []).map((s) => ({ value: s.id, label: s.name }))}
          selected={value.subscriptionIds ?? []}
          onChange={(v) => set('subscriptionIds', v)}
        />
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <Input list={listId} className="font-mono" placeholder="Only resources tagged… (tag name)" aria-label="Scope tag name" value={value.tagKey ?? ''} onChange={(e) => set('tagKey', e.target.value || undefined)} />
        <Input
          className="font-mono"
          placeholder="…with value (any, or a, b, c)"
          aria-label="Scope tag values"
          disabled={!value.tagKey}
          value={(value.tagValues ?? []).join(', ')}
          onChange={(e) => set('tagValues', asList(e.target.value))}
        />
      </div>
    </div>
  );
}

// ── Live preview ────────────────────────────────────────────────────

/** Debounced dry-run of the rule being edited against the live inventory. */
export function RulePreview({ input }: { input: PreviewRuleRequest | null }) {
  const preview = usePreviewRule();
  const [error, setError] = useState<string | null>(null);
  const key = useMemo(() => JSON.stringify(input), [input]);
  const latest = useRef(0);

  useEffect(() => {
    if (!input) return;
    const ticket = ++latest.current;
    const t = setTimeout(() => {
      setError(null);
      preview.mutate(input, {
        onError: (e) => ticket === latest.current && setError(apiErrorMessage(e)),
      });
    }, 450);
    return () => clearTimeout(t);
    // Re-run only when the rule's content changes (`key` is its serialized form).
  }, [key]);

  const d = preview.data;
  return (
    <div className="rounded-sm border border-line bg-canvas/40">
      <div className="flex items-center justify-between gap-3 border-b border-line-subtle px-3 py-2">
        <span className="font-mono text-overline uppercase text-fg-muted">Live preview · current inventory</span>
        {preview.isPending && <Spinner label="Checking…" />}
      </div>
      {error ? (
        <p className="px-3 py-3 text-caption text-warning">{error}</p>
      ) : !d ? (
        <p className="px-3 py-3 text-caption text-fg-muted">Configure the rule to see which resources it would pass and fail.</p>
      ) : (
        <div className={cn('transition-opacity', preview.isPending && 'opacity-60')}>
          <div className="flex flex-wrap gap-x-5 gap-y-1 px-3 py-2.5 text-body-sm">
            <span>
              Applies to <b className="font-mono tabular-nums">{d.applicable}</b> <span className="text-fg-muted">of {d.resources}</span>
            </span>
            <span className="text-success">
              <b className="font-mono tabular-nums">{d.passed}</b> pass
            </span>
            <span className={d.failed ? 'text-danger' : 'text-fg-muted'}>
              <b className="font-mono tabular-nums">{d.failed}</b> fail
            </span>
          </div>
          {d.samples.length > 0 && (
            <ul className="max-h-48 divide-y divide-line-subtle overflow-y-auto border-t border-line-subtle">
              {d.samples.slice(0, 12).map((s) => (
                <li key={s.id} className="flex items-start gap-2 px-3 py-1.5 text-caption">
                  {s.passed ? <CircleCheck className="mt-0.5 size-3.5 shrink-0 text-success" aria-label="passes" /> : <CircleX className="mt-0.5 size-3.5 shrink-0 text-danger" aria-label="fails" />}
                  <Link to={`/inventory/${s.id}`} target="_blank" className="link-quiet min-w-0 truncate text-fg">
                    {s.name}
                  </Link>
                  <span className="ml-auto shrink-0 truncate text-fg-muted">{s.detail ?? shortType(s.type)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
