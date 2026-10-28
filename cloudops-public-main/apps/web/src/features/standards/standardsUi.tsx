import { CircleDollarSign, Gauge, Landmark, LifeBuoy, ShieldCheck, Tag, Type, type LucideIcon } from 'lucide-react';
import { RULE_CATEGORY_LABELS, type RuleCategory, type RuleScoreDto } from '@cloudops/core';
import { Badge, cn } from '../../components/ui/primitives';

export const CATEGORY_ICON: Record<RuleCategory, LucideIcon> = {
  security: ShieldCheck,
  cost: CircleDollarSign,
  reliability: LifeBuoy,
  tagging: Tag,
  naming: Type,
  governance: Landmark,
  operations: Gauge,
};

export function CategoryBadge({ category, className }: { category: RuleCategory | null; className?: string }) {
  if (!category) return null;
  const Icon = CATEGORY_ICON[category];
  return (
    <Badge className={cn('gap-1', className)}>
      <Icon className="-mt-px mr-1 inline size-3 align-middle" aria-hidden />
      {RULE_CATEGORY_LABELS[category]}
    </Badge>
  );
}

/** "12 of 40 failing" style status for a rule. */
export function ruleChecks(rule: RuleScoreDto): number {
  return rule.passed + rule.failed + rule.exempt;
}

/** Pass rate (%) over scored checks; null when nothing applies. */
export function passRate(rule: { passed: number; failed: number }): number | null {
  const n = rule.passed + rule.failed;
  return n > 0 ? Math.round((rule.passed / n) * 100) : null;
}
