import { useState } from 'react';
import { Link } from 'react-router-dom';
import { CircleCheck, CircleX, ShieldCheck, ShieldOff, Undo2, Wrench } from 'lucide-react';
import type { ResourceComplianceDto } from '@cloudops/core';
import { useCreateExemption, useDeleteExemption, useResourceCompliance } from '../../lib/queries';
import { usePermissions } from '../../lib/auth';
import { apiErrorMessage } from '../../lib/api';
import {
  Badge,
  Button,
  EmptyState,
  Field,
  InlineError,
  Input,
  LoadingBlock,
  Panel,
  Readout,
  ReadoutGrid,
  SegmentMeter,
  TextButton,
  scoreTone,
  severityTone,
} from '../../components/ui/primitives';
import { CategoryBadge } from './standardsUi';

type Result = ResourceComplianceDto['results'][number];

function ExemptInline({ resourceId, r, onDone }: { resourceId: string; r: Result; onDone: () => void }) {
  const create = useCreateExemption();
  const [reason, setReason] = useState('');
  const [until, setUntil] = useState('');
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="mt-2 space-y-2 rounded-sm border border-line bg-canvas/60 p-3">
      <div className="grid gap-2 sm:grid-cols-[1fr_11rem]">
        <Field label="Why is this acceptable?" required>
          <Input value={reason} onChange={(e) => setReason(e.target.value)} autoFocus placeholder="e.g. Public by design — CDN origin" />
        </Field>
        <Field label="Until (optional)">
          <Input type="date" min={new Date().toISOString().slice(0, 10)} value={until} onChange={(e) => setUntil(e.target.value)} />
        </Field>
      </div>
      {error && <InlineError>{error}</InlineError>}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onDone}>
          Cancel
        </Button>
        <Button
          size="sm"
          disabled={reason.trim().length < 3}
          loading={create.isPending}
          onClick={async () => {
            setError(null);
            try {
              await create.mutateAsync({ ruleId: r.ruleId, resourceId, reason: reason.trim(), expiresAt: until || undefined });
              onDone();
            } catch (e) {
              setError(apiErrorMessage(e));
            }
          }}
        >
          Exempt
        </Button>
      </div>
    </div>
  );
}

function Check({ resourceId, r, canManage }: { resourceId: string; r: Result; canManage: boolean }) {
  const [exempting, setExempting] = useState(false);
  const remove = useDeleteExemption();
  return (
    <li className="px-4 py-3 md:px-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 gap-3">
          {r.passed ? (
            <CircleCheck className="mt-0.5 size-4 shrink-0 text-success" aria-label="Passing" />
          ) : r.exempt ? (
            <ShieldOff className="mt-0.5 size-4 shrink-0 text-fg-muted" aria-label="Exempt" />
          ) : (
            <CircleX className="mt-0.5 size-4 shrink-0 text-danger" aria-label="Failing" />
          )}
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-body-sm text-fg">{r.ruleName}</span>
              <Badge tone={severityTone(r.severity)}>{r.severity}</Badge>
              <CategoryBadge category={r.category} />
            </div>
            <div className="mt-0.5 text-caption text-fg-muted">{r.standardName}</div>
            {!r.passed && r.detail && <div className="mt-1 text-caption text-danger/90">{r.detail}</div>}
            {!r.passed && !r.exempt && r.remediation && (
              <div className="mt-1 flex gap-1.5 text-caption text-fg-secondary">
                <Wrench className="mt-0.5 size-3 shrink-0" aria-hidden />
                {r.remediation}
              </div>
            )}
            {r.exempt && r.exemption && (
              <div className="mt-1 text-caption text-fg-secondary">
                Exempt: {r.exemption.reason}
                <span className="text-fg-muted">
                  {r.exemption.expiresAt ? ` · until ${new Date(r.exemption.expiresAt).toLocaleDateString()}` : ''}
                  {r.exemption.createdBy ? ` · by ${r.exemption.createdBy}` : ''}
                </span>
              </div>
            )}
          </div>
        </div>
        {canManage && !r.passed && (
          r.exempt && r.exemption ? (
            <TextButton tone="muted" onClick={() => remove.mutate(r.exemption!.id)} disabled={remove.isPending}>
              <Undo2 className="mr-1 inline size-3.5" aria-hidden /> Un-exempt
            </TextButton>
          ) : (
            !exempting && (
              <TextButton tone="muted" onClick={() => setExempting(true)}>
                <ShieldOff className="mr-1 inline size-3.5" aria-hidden /> Exempt
              </TextButton>
            )
          )
        )}
      </div>
      {exempting && <ExemptInline resourceId={resourceId} r={r} onDone={() => setExempting(false)} />}
    </li>
  );
}

/** Per-resource compliance verdicts (resource detail Compliance tab). */
export function ResourceCompliance({ resourceId }: { resourceId: string }) {
  const c = useResourceCompliance(resourceId);
  const { can } = usePermissions();
  if (c.isLoading) return <LoadingBlock label="Loading compliance…" />;
  const data = c.data;

  if (!data || data.results.length === 0) {
    return (
      <EmptyState
        icon={ShieldCheck}
        title="No compliance data for this resource"
        description="Either no rule applies to this resource type, or no evaluation has run yet."
        action={
          <Link to="/standards" className="link text-body-sm">
            Open Standards
          </Link>
        }
      />
    );
  }

  return (
    <div className="space-y-4">
      <ReadoutGrid className="grid-cols-1 sm:grid-cols-4">
        <Readout label="Compliance score" value={data.score} tone={scoreTone(data.score)} visual={<SegmentMeter value={data.score} label="Resource compliance score" />} />
        <Readout label="Passing" value={data.passed} tone="success" />
        <Readout label="Failing" value={data.failed} tone={data.failed > 0 ? 'danger' : undefined} />
        <Readout label="Exempt" value={data.exempt} />
      </ReadoutGrid>

      <Panel title="Checks" description="Only rules that apply to this resource · failing first" flush>
        <ul className="divide-y divide-line-subtle">
          {data.results.map((r) => (
            <Check key={r.ruleId} resourceId={resourceId} r={r} canManage={can('standards.exempt')} />
          ))}
        </ul>
      </Panel>
    </div>
  );
}
