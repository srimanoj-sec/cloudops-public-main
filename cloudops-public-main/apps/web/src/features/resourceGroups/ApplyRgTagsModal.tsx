import { useState } from 'react';
import { Plus, X } from 'lucide-react';
import type { ResourceGroupDto } from '@cloudops/core';
import { useStartRgTagJob, useTagJob } from '../../lib/queries';
import { apiErrorMessage } from '../../lib/api';
import { Alert, Badge, Button, IconButton, InlineError, Input, Meter } from '../../components/ui/primitives';
import { Modal } from '../../components/ui/Modal';
import { useConfirm } from '../../components/ui/Dialogs';

type Row = { key: string; value: string };

/**
 * Apply (merge) one or more tags onto a resource group AND every resource in it.
 * Runs as a background job (one Azure call per resource can take minutes), with
 * live progress; closing the dialog doesn't stop it.
 */
export function ApplyRgTagsModal({ rg, onClose }: { rg: ResourceGroupDto; onClose: () => void }) {
  const start = useStartRgTagJob();
  const confirm = useConfirm();
  const [rows, setRows] = useState<Row[]>([{ key: '', value: '' }]);
  const [jobId, setJobId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const job = useTagJob(jobId);
  const running = Boolean(jobId) && (!job.data || job.data.state === 'queued' || job.data.state === 'running');
  const result = job.data?.state === 'completed' ? job.data.result : null;
  const jobError = job.data?.state === 'failed' ? job.data.error : null;

  const existing = rg.tags ?? {};

  function update(i: number, patch: Partial<Row>) {
    setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }

  const validTags = rows.filter((r) => r.key.trim() && r.value.trim());

  async function submit() {
    setError(null);
    if (validTags.length === 0) return;
    const tags: Record<string, string> = {};
    for (const r of validTags) tags[r.key.trim()] = r.value.trim();
    const ok = await confirm({
      title: 'Write tags to Azure?',
      description: `Apply ${validTags.length} tag(s) to “${rg.name}” and its ${rg.resourceCount ?? 0} resources in Azure?`,
      confirmLabel: 'Apply tags',
    });
    if (!ok) return;
    try {
      const started = await start.mutateAsync({ id: rg.id, tags });
      setJobId(started.id);
    } catch (e) {
      setError(apiErrorMessage(e));
    }
  }

  return (
    <Modal
      title="Tag resource group"
      description={
        <>
          <span className="font-mono text-fg-secondary">{rg.name}</span> · {rg.resourceCount ?? 0} resources
        </>
      }
      onClose={onClose}
      footer={
        result || jobError ? (
          <Button onClick={onClose}>Done</Button>
        ) : running ? (
          <Button variant="secondary" onClick={onClose}>
            Close — keep running in background
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={submit} disabled={validTags.length === 0} loading={start.isPending}>
              {`Apply to RG + ${rg.resourceCount ?? 0} resources`}
            </Button>
          </>
        )
      }
    >
      {running ? (
        <div className="space-y-3 py-2" role="status" aria-live="polite">
          <div className="flex items-baseline justify-between text-body-sm">
            <span className="text-fg">{job.data?.state === 'running' ? 'Writing tags to Azure…' : 'Queued…'}</span>
            <span className="font-mono tabular-nums text-fg-muted">
              {job.data?.progress.done ?? 0} / {job.data?.progress.total || rg.resourceCount || 0}
            </span>
          </div>
          <Meter
            value={job.data?.progress.done ?? 0}
            max={Math.max(1, job.data?.progress.total || rg.resourceCount || 1)}
            label="Tagging progress"
          />
          <p className="text-caption text-fg-muted">
            Each resource is tagged individually, so large groups take a few minutes. You can close this dialog — the job
            keeps running and the table refreshes when it finishes.
          </p>
        </div>
      ) : jobError ? (
        <Alert tone="danger" title="Tagging failed">
          {jobError}
        </Alert>
      ) : result ? (
        <div className="space-y-4 text-body-sm">
          <Alert tone={result.failed > 0 || !result.rgApplied ? 'warning' : 'success'}>
            Applied to the resource group{result.rgApplied ? '' : ' failed'} and its resources.
          </Alert>
          <div className="flex flex-wrap gap-2">
            <Badge tone="success" dot>
              {result.tagged} tagged in Azure
            </Badge>
            {result.platformOnly > 0 && <Badge tone="info">{result.platformOnly} CloudOps-only</Badge>}
            {result.failed > 0 && (
              <Badge tone="danger" dot>
                {result.failed} failed
              </Badge>
            )}
            <Badge>{result.total} total</Badge>
          </div>
          {result.errors.length > 0 && (
            <ul className="max-h-40 space-y-1 overflow-y-auto rounded-sm border border-danger/20 bg-danger/5 p-3 text-caption text-danger">
              {result.errors.map((e, i) => (
                <li key={i}>
                  <span className="font-mono text-fg-secondary">{e.resource}</span>: {e.message}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <div className="space-y-5">
          {Object.keys(existing).length > 0 && (
            <div>
              <div className="mb-2 font-mono text-overline uppercase text-fg-muted">Current RG tags</div>
              <div className="flex flex-wrap gap-2">
                {Object.entries(existing).map(([k, v]) => (
                  <span key={k} className="inline-flex overflow-hidden rounded-xs border border-line font-mono text-caption">
                    <span className="bg-raised px-2 py-1 text-fg-muted">{k}</span>
                    <span className="px-2 py-1 text-fg">{v}</span>
                  </span>
                ))}
              </div>
            </div>
          )}

          <div>
            <div className="mb-2 font-mono text-overline uppercase text-fg-muted">Tags to apply (merged onto every resource)</div>
            <div className="space-y-2">
              {rows.map((r, i) => (
                <div key={i} className="flex items-center gap-2">
                  <Input
                    controlSize="sm"
                    className="w-[40%] font-mono"
                    value={r.key}
                    onChange={(e) => update(i, { key: e.target.value })}
                    placeholder="key"
                    aria-label={`Tag ${i + 1} key`}
                  />
                  <span className="font-mono text-fg-faint" aria-hidden>
                    =
                  </span>
                  <Input
                    controlSize="sm"
                    className="flex-1 font-mono"
                    value={r.value}
                    onChange={(e) => update(i, { value: e.target.value })}
                    placeholder="value"
                    aria-label={`Tag ${i + 1} value`}
                  />
                  {rows.length > 1 && (
                    <IconButton
                      icon={X}
                      label="Remove row"
                      size="sm"
                      className="hover:!text-danger"
                      onClick={() => setRows((rs) => rs.filter((_, idx) => idx !== i))}
                    />
                  )}
                </div>
              ))}
            </div>
            <Button
              variant="secondary"
              size="sm"
              icon={Plus}
              className="mt-3"
              onClick={() => setRows((rs) => [...rs, { key: '', value: '' }])}
            >
              Add another
            </Button>
          </div>

          <p className="text-caption text-fg-muted">
            Azure tags aren’t inherited — CloudOps writes each tag onto the RG and every resource. Resources Azure can’t tag
            are stored in CloudOps and reported below.
          </p>
          {error && <InlineError>{error}</InlineError>}
        </div>
      )}
    </Modal>
  );
}
