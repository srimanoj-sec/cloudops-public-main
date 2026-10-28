import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ArrowRight, BookOpen, CircleCheck, ListChecks, ListTodo, Pencil, Plus, ShieldCheck, ShieldOff, SlidersHorizontal, Trash2 } from 'lucide-react';
import { RULE_CATEGORY_LABELS, type RuleCategory, type RuleScoreDto, type StandardScoreDto } from '@cloudops/core';
import {
  useDeleteCustomStandard,
  useDeleteStandardRule,
  useEvaluateStandards,
  useEvaluationStatus,
  useStandardsLibrary,
  useStandardsSummary,
  useUpdateStandardRule,
} from '../../lib/queries';
import { usePermissions } from '../../lib/auth';
import { apiErrorMessage } from '../../lib/api';
import {
  Alert,
  Badge,
  Button,
  EmptyState,
  ErrorState,
  IconButton,
  Meter,
  PageHeader,
  Readout,
  ReadoutGrid,
  SegmentMeter,
  Select,
  Skeleton,
  Switch,
  TONE_TEXT,
  TabPanel,
  Tabs,
  TextButton,
  cn,
  scoreTone,
  severityTone,
} from '../../components/ui/primitives';
import { Modal } from '../../components/ui/Modal';
import { useConfirm } from '../../components/ui/Dialogs';
import { useToast } from '../../components/ui/Toast';
import { RuleDrilldown } from './RuleDrilldown';
import { NewStandardModal, RuleBuilderModal, RuleSettingsModal } from './RuleModals';
import { FindingsTab, LibraryTab } from './StandardsTabs';
import { ExemptionsTab } from './ExemptionsTab';
import { CATEGORY_ICON, CategoryBadge, passRate, ruleChecks } from './standardsUi';

const TABS = ['standards', 'findings', 'exemptions', 'library'] as const;
type Tab = (typeof TABS)[number];

function RuleRow({
  rule,
  canManage,
  onDrill,
  onEdit,
  onSettings,
}: {
  rule: RuleScoreDto;
  canManage: boolean;
  onDrill: (r: RuleScoreDto) => void;
  onEdit: (r: RuleScoreDto) => void;
  onSettings: (r: RuleScoreDto) => void;
}) {
  const update = useUpdateStandardRule();
  const del = useDeleteStandardRule();
  const confirm = useConfirm();
  const toast = useToast();
  const pct = passRate(rule);
  const checks = ruleChecks(rule);
  const custom = rule.source === 'custom';

  return (
    <li className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center md:px-5">
      <div className={cn('min-w-0 flex-1 transition-opacity duration-150', !rule.enabled && 'opacity-50')}>
        <div className="text-body-sm text-fg">{rule.name}</div>
        {rule.appliesTo && <div className="mt-0.5 truncate text-caption text-fg-muted">{rule.appliesTo}</div>}
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <Badge tone={severityTone(rule.severity)}>{rule.severity}</Badge>
          {custom && <Badge tone="accent">custom</Badge>}
          {!rule.enabled && <Badge>off</Badge>}
          {rule.exempt > 0 && <Badge>{rule.exempt} exempt</Badge>}
        </div>
      </div>

      <div className={cn('flex shrink-0 items-center gap-4', !rule.enabled && 'opacity-50')}>
        <div className="w-28">
          {!rule.enabled ? (
            <span className="font-mono text-caption text-fg-faint">disabled</span>
          ) : pct === null ? (
            <span className="text-caption text-fg-faint" title="No resource in the inventory is in this rule’s scope">
              {checks > 0 ? 'all exempt' : 'nothing applies'}
            </span>
          ) : (
            <>
              <div className="mb-1 font-mono text-caption tabular-nums text-fg-muted">
                {pct}% · {rule.passed + rule.failed}
              </div>
              <Meter value={pct} tone={scoreTone(pct)} size="sm" label={`${rule.name} pass rate`} />
            </>
          )}
        </div>
        <div className="w-24 text-right">
          {rule.enabled && rule.failed > 0 ? (
            <button
              type="button"
              onClick={() => onDrill(rule)}
              className="inline-flex items-center gap-1 rounded-xs font-mono text-caption tabular-nums text-danger transition-colors duration-150 hover:text-danger/80"
            >
              {rule.failed} failing <ArrowRight className="size-3" aria-hidden />
            </button>
          ) : rule.enabled && pct !== null ? (
            <button type="button" onClick={() => onDrill(rule)} className="inline-flex items-center gap-1 text-caption text-success">
              <CircleCheck className="size-3.5" aria-hidden /> all pass
            </button>
          ) : (
            <span className="text-caption text-fg-faint">—</span>
          )}
        </div>
      </div>

      {canManage && (
        <div className="flex shrink-0 items-center justify-end gap-1 sm:w-[6.5rem]">
          <Switch
            size="sm"
            checked={rule.enabled}
            label={rule.enabled ? `Disable ${rule.name}` : `Enable ${rule.name}`}
            disabled={update.isPending}
            onChange={() =>
              update.mutate(
                { id: rule.id, input: { enabled: !rule.enabled } },
                {
                  onError: (e) => {
                    toast({ tone: 'danger', title: 'Can’t enable yet', description: apiErrorMessage(e) });
                    if (!custom) onSettings(rule);
                  },
                },
              )
            }
          />
          {custom ? (
            <>
              <IconButton icon={Pencil} label="Edit rule" size="sm" onClick={() => onEdit(rule)} />
              <IconButton
                icon={Trash2}
                label="Delete rule"
                size="sm"
                variant="danger-ghost"
                loading={del.isPending}
                onClick={async () => {
                  const ok = await confirm({
                    title: 'Delete rule?',
                    description: `“${rule.name}”, its results and exemptions will be removed.`,
                    confirmLabel: 'Delete rule',
                    tone: 'danger',
                  });
                  if (ok) del.mutate(rule.id);
                }}
              />
            </>
          ) : (
            <IconButton icon={SlidersHorizontal} label="Rule settings" size="sm" onClick={() => onSettings(rule)} />
          )}
        </div>
      )}
    </li>
  );
}

function StandardCard({
  std,
  rules,
  canManage,
  onDrill,
  onAddRule,
  onEditRule,
  onSettings,
}: {
  std: StandardScoreDto;
  rules: RuleScoreDto[];
  canManage: boolean;
  onDrill: (r: RuleScoreDto) => void;
  onAddRule: (standardId: string) => void;
  onEditRule: (standardId: string, rule: RuleScoreDto) => void;
  onSettings: (rule: RuleScoreDto) => void;
}) {
  const del = useDeleteCustomStandard();
  const confirm = useConfirm();
  const isCustom = std.source === 'custom';
  const scored = std.passed + std.failed > 0;
  const tone = scoreTone(std.score);

  return (
    <section aria-label={std.name} className="flex min-w-0 flex-col overflow-hidden rounded-md border border-line bg-surface">
      <header className="border-b border-line-subtle px-4 pb-4 pt-4 md:px-5">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-h4 text-fg">{std.name}</h2>
              {isCustom && <Badge tone="accent">custom</Badge>}
            </div>
            {std.description && <p className="mt-0.5 text-body-sm text-fg-muted">{std.description}</p>}
          </div>
          <div className="shrink-0 text-right">
            <div className={cn('font-mono text-readout-sm tabular-nums', scored ? TONE_TEXT[tone] : 'text-fg-faint')}>{scored ? std.score : '—'}</div>
            <div className="font-mono text-caption tabular-nums text-fg-muted">{scored ? `${std.passed}/${std.passed + std.failed} passing` : 'nothing scored'}</div>
          </div>
        </div>
        {scored && <SegmentMeter value={std.score} segments={32} size="sm" className="mt-3" label={`${std.name} score`} />}
      </header>

      {rules.length > 0 ? (
        <ul className="flex-1 divide-y divide-line-subtle">
          {rules.map((rule) => (
            <RuleRow key={rule.id} rule={rule} canManage={canManage} onDrill={onDrill} onEdit={(r) => onEditRule(std.id, r)} onSettings={onSettings} />
          ))}
        </ul>
      ) : (
        <p className="flex-1 px-5 py-6 text-center text-body-sm text-fg-muted">No rules yet — add one from the library or build your own.</p>
      )}

      {canManage && isCustom && (
        <footer className="flex items-center justify-between gap-3 border-t border-line-subtle px-4 py-3 md:px-5">
          <Button variant="secondary" size="sm" icon={Plus} onClick={() => onAddRule(std.id)}>
            Add rule
          </Button>
          <Button
            variant="danger-ghost"
            size="sm"
            icon={Trash2}
            loading={del.isPending}
            onClick={async () => {
              const ok = await confirm({
                title: 'Delete standard?',
                description: `“${std.name}”, its rules, results and exemptions will be deleted.`,
                confirmLabel: 'Delete standard',
                tone: 'danger',
              });
              if (ok) del.mutate(std.id);
            }}
          >
            Delete standard
          </Button>
        </footer>
      )}
    </section>
  );
}

/** Choose which custom standard a library rule goes into. */
function StandardPicker({ standards, onPick, onCreate, onClose }: { standards: StandardScoreDto[]; onPick: (id: string) => void; onCreate: () => void; onClose: () => void }) {
  const [id, setId] = useState(standards[0]?.id ?? '');
  return (
    <Modal
      size="sm"
      title="Add to which standard?"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onCreate}>
            New standard…
          </Button>
          <Button onClick={() => onPick(id)} disabled={!id}>
            Continue
          </Button>
        </>
      }
    >
      <Select className="w-full" value={id} onChange={(e) => setId(e.target.value)} aria-label="Standard">
        {standards.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </Select>
    </Modal>
  );
}

export function StandardsPage() {
  const { can } = usePermissions();
  const canManage = can('standards.manage');
  const canEvaluate = can('standards.evaluate');
  const toast = useToast();
  const summary = useStandardsSummary();
  const library = useStandardsLibrary();
  const evaluate = useEvaluateStandards();
  const evaluation = useEvaluationStatus();
  const [params, setParams] = useSearchParams();
  const urlTab = params.get('tab');
  const [tab, setTabState] = useState<Tab>((TABS as readonly string[]).includes(urlTab ?? '') ? (urlTab as Tab) : 'standards');
  const [category, setCategory] = useState<RuleCategory | null>(null);
  const [drill, setDrillState] = useState<RuleScoreDto | null>(null);
  const busy = evaluation.data ? evaluation.data.state !== 'idle' : false;

  // Deep links: ?tab=… selects a tab, ?rule=<id> opens that rule's finding view.
  const setTab = (t: Tab) => {
    setTabState(t);
    setParams(
      (p) => {
        const next = new URLSearchParams(p);
        if (t === 'standards') next.delete('tab');
        else next.set('tab', t);
        return next;
      },
      { replace: true },
    );
  };
  const setDrill = (r: RuleScoreDto | null) => {
    setDrillState(r);
    setParams(
      (p) => {
        const next = new URLSearchParams(p);
        if (r) next.set('rule', r.id);
        else next.delete('rule');
        return next;
      },
      { replace: true },
    );
  };
  const ruleParam = params.get('rule');
  const allRules = summary.data?.standards.flatMap((s) => s.rules);
  useEffect(() => {
    if (!ruleParam || !allRules) return;
    const hit = allRules.find((r) => r.id === ruleParam) ?? null;
    setDrillState((cur) => (cur?.id === ruleParam ? cur : hit));
  }, [ruleParam, allRules]);
  const [newStandard, setNewStandard] = useState(false);
  const [builder, setBuilder] = useState<{ standardId: string; rule?: RuleScoreDto; template?: string } | null>(null);
  const [settings, setSettings] = useState<RuleScoreDto | null>(null);
  const [picking, setPicking] = useState<string | null>(null);

  const data = summary.data;
  const customStandards = data?.standards.filter((s) => s.source === 'custom') ?? [];
  const failingRules = data?.standards.flatMap((s) => s.rules).filter((r) => r.enabled && r.failed > 0) ?? [];

  const runEvaluation = () =>
    evaluate.mutate(undefined, {
      onSuccess: (s) =>
        toast(
          s.deduplicated
            ? { tone: 'info', title: 'An evaluation is already queued', description: 'Results update here when it finishes.' }
            : { title: 'Evaluation started', description: 'It runs in the background; results update here when it finishes.' },
        ),
    });

  function addTemplate(key: string) {
    if (customStandards.length === 1) setBuilder({ standardId: customStandards[0]!.id, template: key });
    else if (customStandards.length > 1) setPicking(key);
    else {
      toast({ title: 'Create a standard first', description: 'Library rules are added to your own standards.' });
      setNewStandard(true);
    }
  }

  return (
    <div>
      <PageHeader
        overline="Cost & governance"
        title="Standards"
        subtitle="Security, cost, reliability and governance rules evaluated against every resource they apply to — with how to fix each failure, and exemptions for accepted exceptions."
        meta={
          <>
            {busy && evaluation.data && (
              <Badge tone="accent" dot pulse>
                {evaluation.data.state === 'running' ? 'Evaluating' : 'Evaluation queued'}
                {evaluation.data.reason ? ` · ${evaluation.data.reason}` : ''}
              </Badge>
            )}
            {data?.evaluatedAt && (
              <span className="text-caption text-fg-muted">
                Last evaluated <span className="font-mono text-fg-secondary">{new Date(data.evaluatedAt).toLocaleString()}</span>
                {evaluation.data?.last && !busy && (
                  <>
                    {' '}
                    · {evaluation.data.last.reason}
                    {evaluation.data.last.durationMs != null ? ` · ${(evaluation.data.last.durationMs / 1000).toFixed(1)} s` : ''}
                  </>
                )}
              </span>
            )}
            {evaluation.data?.last && !evaluation.data.last.ok && (
              <Badge tone="danger" title={evaluation.data.last.error ?? undefined}>
                last evaluation failed
              </Badge>
            )}
          </>
        }
        actions={
          canManage || canEvaluate ? (
            <>
              {canManage && (
                <Button variant="secondary" icon={Plus} onClick={() => setNewStandard(true)}>
                  New standard
                </Button>
              )}
              {canEvaluate && (
                <Button icon={ListChecks} onClick={runEvaluation} loading={evaluate.isPending || busy}>
                  {busy ? 'Evaluating…' : 'Run evaluation'}
                </Button>
              )}
            </>
          ) : undefined
        }
      />

      {evaluate.isError && (
        <Alert tone="danger" title="Evaluation failed" className="mb-6">
          {apiErrorMessage(evaluate.error)}
        </Alert>
      )}

      {summary.isLoading ? (
        <div className="space-y-6" role="status" aria-label="Loading compliance">
          <Skeleton className="h-28 rounded-md" />
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            <Skeleton className="h-72 rounded-md" />
            <Skeleton className="h-72 rounded-md" />
          </div>
        </div>
      ) : summary.isError ? (
        <ErrorState title="Couldn’t load compliance" error={summary.error} onRetry={() => void summary.refetch()} retrying={summary.isRefetching} />
      ) : !data || !data.evaluatedAt ? (
        <EmptyState
          icon={ShieldCheck}
          title="Not evaluated yet"
          description="Run an evaluation to score every resource against the built-in security, cost, reliability and governance rules."
          action={
            canEvaluate ? (
              <Button icon={ListChecks} onClick={runEvaluation} loading={evaluate.isPending || busy}>
                Run evaluation
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="space-y-6">
          <ReadoutGrid className="grid-cols-1 sm:grid-cols-2 xl:grid-cols-4">
            <Readout label="Compliance score" value={data.score} tone={scoreTone(data.score)} hint="weighted by severity" visual={<SegmentMeter value={data.score} label="Overall compliance score" />} />
            <Readout label="Resources" value={data.resourcesEvaluated} hint={`${data.totalChecks} applicable checks`} />
            <Readout
              label="Failing checks"
              value={data.failed}
              tone={data.failed > 0 ? 'danger' : 'success'}
              hint={
                data.bySeverity.length > 0 ? (
                  <span className="flex flex-wrap gap-1">
                    {[...data.bySeverity]
                      .sort((a, b) => b.failed - a.failed)
                      .map((s) => (
                        <Badge key={s.severity} tone={severityTone(s.severity)}>
                          {s.severity} {s.failed}
                        </Badge>
                      ))}
                  </span>
                ) : (
                  'none'
                )
              }
            />
            <Readout label="Exempted" value={data.exempt} hint="accepted exceptions, not scored" />
          </ReadoutGrid>

          {data.byCategory.length > 0 && (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-7" role="group" aria-label="Filter by category">
              {data.byCategory.map((c) => {
                const Icon = CATEGORY_ICON[c.category];
                const active = category === c.category;
                const scored = c.passed + c.failed > 0;
                return (
                  <button
                    key={c.category}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setCategory(active ? null : c.category)}
                    className={cn(
                      'focus-ring rounded-md border bg-surface px-3 py-2.5 text-left transition-colors duration-150 hover:bg-hover',
                      active ? 'border-accent' : 'border-line',
                    )}
                  >
                    <div className="flex items-center gap-1.5 text-caption text-fg-muted">
                      <Icon className="size-3.5" aria-hidden />
                      <span className="truncate">{c.label}</span>
                    </div>
                    <div className="mt-1 flex items-baseline justify-between gap-2">
                      <span className={cn('font-mono text-h3 tabular-nums', scored ? TONE_TEXT[scoreTone(c.score)] : 'text-fg-faint')}>{scored ? c.score : '—'}</span>
                      {c.failed > 0 && <span className="font-mono text-caption tabular-nums text-danger">{c.failed} failing</span>}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
          {category && (
            <div className="flex items-center gap-2 text-caption text-fg-muted">
              Showing <CategoryBadge category={category} /> only
              <TextButton tone="muted" onClick={() => setCategory(null)}>
                Show all
              </TextButton>
            </div>
          )}

          <Tabs
            baseId="standards"
            label="Standards views"
            value={tab}
            onChange={setTab}
            tabs={[
              { id: 'standards', label: `Standards · ${data.standards.length}`, icon: ShieldCheck },
              { id: 'findings', label: `Findings · ${failingRules.length}`, icon: ListTodo },
              { id: 'exemptions', label: `Exemptions · ${data.exempt}`, icon: ShieldOff },
              { id: 'library', label: `Rule library${library.data ? ` · ${library.data.length}` : ''}`, icon: BookOpen },
            ]}
          />

          <TabPanel id={tab} baseId="standards">
            {tab === 'standards' && (
              <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-2">
                {data.standards.map((std) => {
                  const rules = category ? std.rules.filter((r) => r.category === category) : std.rules;
                  if (category && rules.length === 0) return null;
                  return (
                    <StandardCard
                      key={std.id}
                      std={std}
                      rules={rules}
                      canManage={canManage}
                      onDrill={setDrill}
                      onAddRule={(standardId) => setBuilder({ standardId })}
                      onEditRule={(standardId, rule) => setBuilder({ standardId, rule })}
                      onSettings={setSettings}
                    />
                  );
                })}
              </div>
            )}
            {tab === 'findings' && <FindingsTab standards={data.standards} category={category} onDrill={setDrill} />}
            {tab === 'exemptions' && <ExemptionsTab canManage={can('standards.exempt')} />}
            {tab === 'library' &&
              (library.data ? (
                <LibraryTab library={library.data} standards={data.standards} category={category} canManage={canManage} onConfigure={setSettings} onUse={addTemplate} />
              ) : (
                <Skeleton className="h-72 rounded-md" />
              ))}
          </TabPanel>
          <p className="text-caption text-fg-faint">Categories: {Object.values(RULE_CATEGORY_LABELS).join(' · ')}. Scores weight high 3 · medium 2 · low 1; exempted and not-applicable checks don’t count.</p>
        </div>
      )}

      {drill && <RuleDrilldown rule={drill} canManage={can('standards.exempt')} onClose={() => setDrill(null)} />}
      {newStandard && <NewStandardModal onClose={() => setNewStandard(false)} />}
      {builder && <RuleBuilderModal standardId={builder.standardId} rule={builder.rule} initialTemplate={builder.template} onClose={() => setBuilder(null)} />}
      {settings && <RuleSettingsModal rule={settings} onClose={() => setSettings(null)} />}
      {picking && (
        <StandardPicker
          standards={customStandards}
          onClose={() => setPicking(null)}
          onCreate={() => {
            setPicking(null);
            setNewStandard(true);
          }}
          onPick={(id) => {
            setBuilder({ standardId: id, template: picking });
            setPicking(null);
          }}
        />
      )}
    </div>
  );
}
