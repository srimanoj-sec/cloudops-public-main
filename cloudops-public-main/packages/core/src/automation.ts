import { z } from 'zod';
import { COST_ANOMALY_KINDS } from './finops.js';
import { NOTIFICATION_SEVERITIES } from './notifications.js';
import { PERMISSION_KEYS, type Permission } from './permissions.js';
import { STANDARD_SEVERITIES } from './standards.js';
import { WORK_ITEM_TYPES } from './work.js';

/**
 * Automation rules: WHEN something happens (a trigger), IF it matches the
 * conditions, THEN do something (actions). Actions raise work and tell people —
 * they never change the cloud: a change always goes through remediation, where
 * it is previewed and approved.
 */

export const AUTOMATION_TRIGGERS = [
  'compliance.new-failures',
  'cost.anomaly',
  'budget.threshold',
  'drift.detected',
  'sync.failed',
  'sync.unreachable',
  'remediation.failed',
] as const;
export type AutomationTrigger = (typeof AUTOMATION_TRIGGERS)[number];

export const automationConditionsSchema = z
  .object({
    /** compliance: only findings at least this severe. */
    minSeverity: z.enum(STANDARD_SEVERITIES).optional(),
    /** compliance: only these rules (standard rule ids). */
    ruleIds: z.array(z.string().max(64)).max(50).optional(),
    /** compliance / drift: only when at least this many resources are affected. */
    minResources: z.coerce.number().int().min(1).max(100_000).optional(),
    /** cost anomaly: only when it would cost at least this much more per month. */
    minMonthlyImpact: z.coerce.number().min(0).max(1e10).optional(),
    /** cost anomaly: only these kinds. */
    anomalyKinds: z.array(z.enum(COST_ANOMALY_KINDS)).max(3).optional(),
    /** budget: `over` = only exceeded budgets; `at-risk` = also forecast to exceed. */
    budgetStatus: z.enum(['at-risk', 'over']).optional(),
    /** drift: only changes to these fields (tags, owner, sku, location, state…). */
    fields: z.array(z.string().max(40)).max(10).optional(),
  })
  .strict();
export type AutomationConditions = z.infer<typeof automationConditionsSchema>;

export const automationActionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('notify'),
    /** Who sees it: holders of this permission; null = everyone. */
    audience: z
      .enum(PERMISSION_KEYS as [Permission, ...Permission[]])
      .nullable()
      .default(null),
    severity: z.enum(NOTIFICATION_SEVERITIES).default('medium'),
  }),
  z.object({
    type: z.literal('create-work-item'),
    workType: z.enum(WORK_ITEM_TYPES).default('task'),
    priority: z.coerce.number().int().min(1).max(5).default(3),
    assignee: z.string().trim().max(200).optional(),
    /** Due this many days after it's raised. */
    dueInDays: z.coerce.number().int().min(0).max(365).optional(),
  }),
]);
export type AutomationAction = z.infer<typeof automationActionSchema>;
export type AutomationActionType = AutomationAction['type'];

export const automationRuleInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1000).optional(),
  enabled: z.boolean().default(true),
  trigger: z.enum(AUTOMATION_TRIGGERS),
  conditions: automationConditionsSchema.default({}),
  actions: z.array(automationActionSchema).min(1).max(5),
});
export type AutomationRuleInput = z.infer<typeof automationRuleInputSchema>;
export type AutomationRuleRequest = z.input<typeof automationRuleInputSchema>;

/** What each trigger means and which conditions apply to it (drives the rule editor). */
export const AUTOMATION_TRIGGER_INFO: Record<
  AutomationTrigger,
  { label: string; description: string; conditions: (keyof AutomationConditions)[] }
> = {
  'compliance.new-failures': {
    label: 'New compliance failures',
    description:
      'An evaluation finds resources failing a rule they passed before (once per rule per evaluation).',
    conditions: ['minSeverity', 'ruleIds', 'minResources'],
  },
  'cost.anomaly': {
    label: 'Cost anomaly',
    description:
      'After a cost sync: a resource’s daily cost is outside its expected range, or new spend appears.',
    conditions: ['minMonthlyImpact', 'anomalyKinds'],
  },
  'budget.threshold': {
    label: 'Budget threshold',
    description: 'After a cost sync: a budget is over, or forecast to cross its alert threshold.',
    conditions: ['budgetStatus'],
  },
  'drift.detected': {
    label: 'Configuration drift',
    description: 'A sync finds resources changed outside CloudOps (one match per changed field).',
    conditions: ['fields', 'minResources'],
  },
  'sync.failed': {
    label: 'Inventory sync failed',
    description: 'An inventory sync fails outright.',
    conditions: [],
  },
  'sync.unreachable': {
    label: 'Organization unreachable',
    description: 'A sync completes but can’t reach an organization (e.g. rejected credentials).',
    conditions: [],
  },
  'remediation.failed': {
    label: 'Remediation failed',
    description: 'A remediation finishes with resources it couldn’t change or verify.',
    conditions: [],
  },
};

/** One thing a trigger produced that a rule may act on. */
export interface AutomationMatchDto {
  /** Stable identity of the condition — work items are not duplicated while one is open for it. */
  key: string;
  title: string;
  detail: string;
  severity: string;
  link: string | null;
  /** Resources it concerns (linked to the work item, capped). */
  resourceIds: string[];
}

export interface AutomationActionResultDto {
  type: AutomationActionType;
  outcome: 'done' | 'skipped' | 'failed';
  /** How many notifications / work items it produced. */
  count: number;
  message: string | null;
}

export interface AutomationRunDto {
  id: string;
  ruleId: string;
  ruleName: string;
  trigger: string;
  /** succeeded | partial | failed | skipped (nothing matched) */
  status: string;
  matched: number;
  truncated: boolean;
  matches: { key: string; title: string; link: string | null }[];
  actions: AutomationActionResultDto[];
  error: string | null;
  createdAt: string;
}

export interface AutomationRuleDto {
  id: string;
  name: string;
  description: string | null;
  enabled: boolean;
  trigger: AutomationTrigger;
  conditions: AutomationConditions;
  actions: AutomationAction[];
  createdBy: string | null;
  lastRunAt: string | null;
  runCount: number;
  lastRun: { status: string; matched: number; createdAt: string } | null;
  createdAt: string;
  updatedAt: string;
}

/** What a rule would act on with today's data — nothing is done. */
export interface AutomationPreviewDto {
  /** Which data the preview used, in words. */
  basis: string;
  matches: AutomationMatchDto[];
  /** Total before the per-run cap. */
  total: number;
  /** What the actions would do, in words. */
  wouldDo: string[];
}

export const automationRunsQuerySchema = z.object({
  ruleId: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type AutomationRunsQuery = z.infer<typeof automationRunsQuerySchema>;
