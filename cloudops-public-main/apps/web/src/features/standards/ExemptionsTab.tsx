import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ShieldOff, Undo2 } from 'lucide-react';
import type { ExemptionDto } from '@cloudops/core';
import { useDeleteExemption, useExemptions } from '../../lib/queries';
import { apiErrorMessage } from '../../lib/api';
import { Badge, EmptyState, ErrorState, SegmentedControl, TableSkeleton, TextButton, severityTone, type Tone } from '../../components/ui/primitives';
import { useConfirm } from '../../components/ui/Dialogs';
import { useToast } from '../../components/ui/Toast';

const STATUS: Record<NonNullable<ExemptionDto['status']>, { tone: Tone; label: string }> = {
  expiring: { tone: 'warning', label: 'expires soon' },
  expired: { tone: 'danger', label: 'expired' },
  permanent: { tone: 'danger', label: 'no end date' },
  active: { tone: 'success', label: 'active' },
};

type View = 'attention' | 'all';

/**
 * The exemption register: every accepted exception, who granted it, why and
 * until when. Permanent and expiring ones are surfaced first — an exemption
 * should be a decision with an end date, not a way to hide a finding.
 */
export function ExemptionsTab({ canManage }: { canManage: boolean }) {
  const list = useExemptions();
  const remove = useDeleteExemption();
  const confirm = useConfirm();
  const toast = useToast();
  const [view, setView] = useState<View>('attention');
  const all = list.data ?? [];
  const attention = all.filter((e) => e.status !== 'active');
  const rows = view === 'attention' ? attention : all;

  async function revoke(e: ExemptionDto) {
    const ok = await confirm({
      title: 'Revoke this exemption?',
      description: `${e.resourceName} counts against “${e.ruleName}” again from now on. The revocation is recorded in the audit log.`,
      confirmLabel: 'Revoke',
      tone: 'danger',
    });
    if (!ok) return;
    try {
      await remove.mutateAsync(e.id);
      toast({ title: 'Exemption revoked' });
    } catch (err) {
      toast({ tone: 'danger', title: 'Couldn’t revoke it', description: apiErrorMessage(err) });
    }
  }

  if (list.isLoading) return <TableSkeleton rows={5} cols={5} />;
  if (list.isError) return <ErrorState compact error={list.error} onRetry={() => void list.refetch()} />;
  if (all.length === 0) {
    return (
      <EmptyState
        icon={ShieldOff}
        title="No exemptions"
        description="An exemption accepts a failing check for one resource — with a reason, the person who granted it and an end date. Grant one from a finding when a failure is deliberate."
      />
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SegmentedControl
          label="Show"
          size="sm"
          value={view}
          onChange={setView}
          options={[
            { value: 'attention', label: `Needs a look · ${attention.length}` },
            { value: 'all', label: `All · ${all.length}` },
          ]}
        />
        <p className="text-caption text-fg-muted">Expired exemptions stop applying at the next evaluation.</p>
      </div>
      {rows.length === 0 ? (
        <EmptyState compact icon={ShieldOff} title="Nothing needs a look" description="Every exemption has an end date that isn’t close." />
      ) : (
        <div className="overflow-x-auto rounded-md border border-line bg-surface">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">Resource · rule</th>
                <th scope="col">Why</th>
                <th scope="col">Until</th>
                <th scope="col" className="hidden lg:table-cell">
                  Granted by
                </th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => {
                const s = STATUS[e.status ?? 'active'];
                return (
                  <tr key={e.id}>
                    <td>
                      <Link to={`/inventory/${e.resourceId}?tab=Compliance`} className="link-quiet font-medium">
                        {e.resourceName}
                      </Link>
                      <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-caption text-fg-muted">
                        {e.severity && <Badge tone={severityTone(e.severity)}>{e.severity}</Badge>}
                        <Link to={`/standards?rule=${e.ruleId}`} className="hover:text-fg">
                          {e.ruleName}
                        </Link>
                      </div>
                    </td>
                    <td className="max-w-[22rem] text-body-sm text-fg-secondary">{e.reason}</td>
                    <td className="whitespace-nowrap">
                      <Badge tone={s.tone}>{s.label}</Badge>
                      {e.expiresAt && <div className="mt-1 font-mono text-caption text-fg-muted">{new Date(e.expiresAt).toLocaleDateString()}</div>}
                    </td>
                    <td className="hidden text-caption lg:table-cell">
                      <div className="text-fg-secondary">{e.createdBy ?? '—'}</div>
                      <div className="font-mono text-fg-muted">{new Date(e.createdAt).toLocaleDateString()}</div>
                    </td>
                    <td className="text-right">
                      {canManage && (
                        <TextButton tone="muted" onClick={() => void revoke(e)}>
                          <Undo2 className="size-3.5" aria-hidden /> Revoke
                        </TextButton>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
