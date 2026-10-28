import { useMemo, useState } from 'react';
import { ArrowRight, CircleCheck, Plus, Search, SlidersHorizontal, Wrench } from 'lucide-react';
import {
  RULE_CATEGORIES,
  RULE_CATEGORY_LABELS,
  SEVERITY_WEIGHT,
  type RuleCategory,
  type RuleScoreDto,
  type RuleTemplateDto,
  type StandardScoreDto,
  type StandardSeverity,
} from '@cloudops/core';
import { Badge, Button, EmptyState, Input, Select, severityTone } from '../../components/ui/primitives';
import { CategoryBadge } from './standardsUi';

const weight = (s: string) => SEVERITY_WEIGHT[s as StandardSeverity] ?? 1;

/** Everything failing right now, most important first — the "what do I fix" list. */
export function FindingsTab({
  standards,
  category,
  onDrill,
}: {
  standards: StandardScoreDto[];
  category: RuleCategory | null;
  onDrill: (r: RuleScoreDto) => void;
}) {
  const rows = standards
    .flatMap((s) => s.rules.filter((r) => r.enabled && r.failed > 0).map((r) => ({ std: s, rule: r })))
    .filter((x) => !category || x.rule.category === category)
    .sort((a, b) => weight(b.rule.severity) - weight(a.rule.severity) || b.rule.failed - a.rule.failed);

  if (rows.length === 0) {
    return <EmptyState icon={CircleCheck} title="No failing checks" description={category ? 'Nothing fails in this category.' : 'Every applicable resource meets every enabled rule.'} />;
  }
  return (
    <div className="overflow-hidden rounded-md border border-line bg-surface">
      <ul className="divide-y divide-line-subtle">
        {rows.map(({ std, rule }) => (
          <li key={rule.id}>
            <button type="button" onClick={() => onDrill(rule)} className="focus-inset flex w-full items-start gap-4 px-4 py-3 text-left transition-colors duration-150 hover:bg-hover md:px-5">
              <Badge tone={severityTone(rule.severity)} className="mt-0.5 w-16 justify-center">
                {rule.severity}
              </Badge>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-body-sm font-medium text-fg">{rule.name}</span>
                  <CategoryBadge category={rule.category} />
                  <span className="text-caption text-fg-muted">{std.name}</span>
                </div>
                {rule.remediation && (
                  <div className="mt-1 flex gap-1.5 text-caption text-fg-muted">
                    <Wrench className="mt-0.5 size-3 shrink-0" aria-hidden />
                    <span className="line-clamp-1">{rule.remediation}</span>
                  </div>
                )}
              </div>
              <span className="inline-flex shrink-0 items-center gap-1 font-mono text-body-sm tabular-nums text-danger">
                {rule.failed} <span className="hidden text-caption sm:inline">failing</span> <ArrowRight className="size-3.5" aria-hidden />
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

type Availability = 'all' | 'active' | 'available';

/** Every rule that can be used: what it checks, where it applies, and whether it's on. */
export function LibraryTab({
  library,
  standards,
  category,
  canManage,
  onConfigure,
  onUse,
}: {
  library: RuleTemplateDto[];
  standards: StandardScoreDto[];
  category: RuleCategory | null;
  canManage: boolean;
  onConfigure: (rule: RuleScoreDto) => void;
  onUse: (templateKey: string) => void;
}) {
  const [q, setQ] = useState('');
  const [availability, setAvailability] = useState<Availability>('all');

  // Where each library rule is in use (built-in pack and/or custom standards).
  const usage = useMemo(() => {
    const m = new Map<string, { std: StandardScoreDto; rule: RuleScoreDto }[]>();
    for (const std of standards) for (const r of std.rules) if (r.template) m.set(r.template, [...(m.get(r.template) ?? []), { std, rule: r }]);
    return m;
  }, [standards]);

  const needle = q.trim().toLowerCase();
  const list = library.filter((t) => {
    if (category && t.category !== category) return false;
    const used = (usage.get(t.key) ?? []).some((u) => u.rule.enabled);
    if (availability === 'active' && !used) return false;
    if (availability === 'available' && used) return false;
    return !needle || `${t.name} ${t.description} ${t.appliesTo}`.toLowerCase().includes(needle);
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Input icon={Search} className="min-w-[min(100%,260px)] flex-1" placeholder="Search rules — e.g. TLS, public, tag, disk…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search the rule library" />
        <Select value={availability} onChange={(e) => setAvailability(e.target.value as Availability)} aria-label="Filter by status">
          <option value="all">All rules</option>
          <option value="active">In use</option>
          <option value="available">Not in use</option>
        </Select>
      </div>
      <p className="text-caption text-fg-muted">
        {list.length} of {library.length} rules. Built-in rules run in their pack and can be configured there; every rule can also be added to your own standards with its own settings and scope.
      </p>

      {RULE_CATEGORIES.map((cat) => {
        const items = list.filter((t) => t.category === cat);
        if (items.length === 0) return null;
        return (
          <section key={cat} aria-label={RULE_CATEGORY_LABELS[cat]}>
            <h3 className="mb-2 font-mono text-overline uppercase text-fg-muted">{RULE_CATEGORY_LABELS[cat]}</h3>
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              {items.map((t) => {
                const uses = usage.get(t.key) ?? [];
                const builtin = uses.find((u) => u.std.source === 'builtin');
                const custom = uses.filter((u) => u.std.source === 'custom');
                return (
                  <article key={t.key} className="flex flex-col rounded-md border border-line bg-surface p-4">
                    <div className="flex items-start justify-between gap-3">
                      <h4 className="text-body-sm font-medium text-fg">{t.name}</h4>
                      <Badge tone={severityTone(t.severity)}>{t.severity}</Badge>
                    </div>
                    <p className="mt-1.5 text-caption text-fg-secondary">{t.description}</p>
                    <dl className="mt-2 space-y-1 text-caption">
                      <div className="flex gap-1.5">
                        <dt className="shrink-0 text-fg-muted">Applies to</dt>
                        <dd className="text-fg-secondary">{t.appliesTo}</dd>
                      </div>
                      {t.params.length > 0 && (
                        <div className="flex gap-1.5">
                          <dt className="shrink-0 text-fg-muted">Settings</dt>
                          <dd className="text-fg-secondary">{t.params.map((p) => p.label).join(' · ')}</dd>
                        </div>
                      )}
                    </dl>
                    <div className="mt-auto flex flex-wrap items-center gap-2 pt-3">
                      {builtin && (
                        <Badge tone={builtin.rule.enabled ? 'success' : 'neutral'} dot>
                          {builtin.std.name} · {builtin.rule.enabled ? 'on' : 'off'}
                        </Badge>
                      )}
                      {custom.map((u) => (
                        <Badge key={u.rule.id} tone="accent">
                          {u.std.name}
                        </Badge>
                      ))}
                      {canManage && (
                        <span className="ml-auto flex gap-1.5">
                          {builtin && (
                            <Button variant="ghost" size="sm" icon={SlidersHorizontal} onClick={() => onConfigure(builtin.rule)}>
                              Configure
                            </Button>
                          )}
                          <Button variant="secondary" size="sm" icon={Plus} onClick={() => onUse(t.key)}>
                            Use in a standard
                          </Button>
                        </span>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}
