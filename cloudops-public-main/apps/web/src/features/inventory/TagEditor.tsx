import { useEffect, useState } from 'react';
import { CircleCheck, Plus, X } from 'lucide-react';
import type { ResourceDetailDto, TagWriteResult } from '@cloudops/core';
import { useAzureWriteEnabled, useSetResourceTags } from '../../lib/queries';
import { usePermissions } from '../../lib/auth';
import { apiErrorMessage } from '../../lib/api';
import { Alert, Badge, Button, IconButton, InlineError, Input, Panel } from '../../components/ui/primitives';

type Row = { key: string; value: string };

function TagToken({ k, v }: { k: string; v: string }) {
  return (
    <span className="inline-flex max-w-full items-center overflow-hidden rounded-xs border border-line font-mono text-caption">
      <span className="truncate bg-raised px-2 py-1 text-fg-muted">{k}</span>
      <span className="truncate px-2 py-1 text-fg">{v}</span>
    </span>
  );
}

/** Editable tag panel for a resource — writes back to Azure (or CloudOps-only). */
export function TagEditor({ resource }: { resource: ResourceDetailDto }) {
  const { can } = usePermissions();
  const canManage = can('inventory.tag');
  const writeEnabled = useAzureWriteEnabled();
  const editable = canManage && writeEnabled;
  const setTags = useSetResourceTags();

  const [rows, setRows] = useState<Row[]>(() => Object.entries(resource.tags).map(([key, value]) => ({ key, value })));
  const [newKey, setNewKey] = useState('');
  const [newVal, setNewVal] = useState('');
  const [dirty, setDirty] = useState(false);
  const [result, setResult] = useState<TagWriteResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Reset the draft whenever the resource's tags change (e.g. after a save/refetch).
  const tagsKey = JSON.stringify(resource.tags);
  useEffect(() => {
    setRows(Object.entries(resource.tags).map(([key, value]) => ({ key, value })));
    setDirty(false);
  }, [tagsKey]);

  const untaggable = resource.taggableInAzure === false;
  const platformTags = resource.platformTags ?? {};
  const hasPlatformTags = Object.keys(platformTags).length > 0;

  function updateRow(i: number, patch: Partial<Row>) {
    setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
    setDirty(true);
  }
  function removeRow(i: number) {
    setRows((rs) => rs.filter((_, idx) => idx !== i));
    setDirty(true);
  }
  function addRow() {
    if (!newKey.trim()) return;
    setRows((rs) => [...rs.filter((r) => r.key !== newKey.trim()), { key: newKey.trim(), value: newVal }]);
    setNewKey('');
    setNewVal('');
    setDirty(true);
  }

  async function save() {
    setError(null);
    setResult(null);
    // Build the desired set (last write wins on duplicate keys).
    const desired: Record<string, string> = {};
    for (const r of rows) if (r.key.trim()) desired[r.key.trim()] = r.value;
    try {
      const res = await setTags.mutateAsync({ id: resource.id, tags: desired });
      setResult(res);
      setDirty(false);
    } catch (e) {
      setError(apiErrorMessage(e));
    }
  }

  return (
    <Panel
      title={
        <span className="flex items-center gap-2">
          Tags <span className="font-mono font-normal text-fg-muted">{rows.length}</span>
        </span>
      }
      actions={
        untaggable ? (
          <Badge tone="warning" dot>
            not taggable in Azure
          </Badge>
        ) : dirty ? (
          <Badge tone="warning" dot pulse>
            unsaved changes
          </Badge>
        ) : undefined
      }
      className="self-start"
    >
      {untaggable && (
        <Alert tone="warning" className="mb-4">
          Azure can’t tag this resource type — tags you set here are stored in CloudOps only.
        </Alert>
      )}

      {/* Rows */}
      {rows.length === 0 && <p className="text-body-sm text-fg-muted">No tags.</p>}
      {editable ? (
        <div className="space-y-2">
          {rows.map((r, i) => (
            <div key={i} className="flex items-center gap-2">
              <Input
                controlSize="sm"
                className="w-[40%] font-mono"
                value={r.key}
                onChange={(e) => updateRow(i, { key: e.target.value })}
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
                onChange={(e) => updateRow(i, { value: e.target.value })}
                placeholder="value"
                aria-label={`Tag ${i + 1} value`}
              />
              <IconButton icon={X} label="Remove tag" size="sm" onClick={() => removeRow(i)} className="hover:!text-danger" />
            </div>
          ))}
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {rows.map((r, i) => (
            <TagToken key={i} k={r.key} v={r.value} />
          ))}
        </div>
      )}

      {/* Add row + save */}
      {editable && (
        <>
          <div className="mt-3 flex items-center gap-2 border-t border-dashed border-line pt-3">
            <Input
              controlSize="sm"
              className="w-[40%] font-mono"
              value={newKey}
              onChange={(e) => setNewKey(e.target.value)}
              placeholder="new key"
              aria-label="New tag key"
            />
            <span className="font-mono text-fg-faint" aria-hidden>
              =
            </span>
            <Input
              controlSize="sm"
              className="flex-1 font-mono"
              value={newVal}
              onChange={(e) => setNewVal(e.target.value)}
              placeholder="value"
              aria-label="New tag value"
              onKeyDown={(e) => e.key === 'Enter' && addRow()}
            />
            <IconButton icon={Plus} label="Add tag" size="sm" variant="secondary" onClick={addRow} disabled={!newKey.trim()} />
          </div>
          <div className="mt-4 flex items-center gap-3">
            <Button onClick={save} disabled={!dirty} loading={setTags.isPending}>
              {setTags.isPending ? 'Saving…' : untaggable ? 'Save (CloudOps)' : 'Save to Azure'}
            </Button>
          </div>
        </>
      )}

      {!writeEnabled && canManage && (
        <p className="mt-4 text-caption text-fg-muted">
          Tag editing is disabled (set <span className="font-mono text-fg-secondary">AZURE_ALLOW_WRITE=true</span> on the
          API to enable).
        </p>
      )}

      {result && (
        <p
          role="status"
          className={`mt-3 flex items-center gap-1.5 text-body-sm ${result.appliedToAzure ? 'text-success' : 'text-warning'}`}
        >
          <CircleCheck className="size-4" aria-hidden />
          {result.appliedToAzure ? 'Written to Azure.' : result.message ?? 'Stored in CloudOps only.'}
        </p>
      )}
      {error && <InlineError className="mt-3">{error}</InlineError>}

      {/* Platform-only tags (stored in CloudOps, not in Azure) */}
      {hasPlatformTags && (
        <div className="mt-5 border-t border-line-subtle pt-4">
          <div className="mb-2 flex items-center gap-2 font-mono text-overline uppercase text-fg-muted">
            CloudOps-only tags <Badge tone="info">not in Azure</Badge>
          </div>
          <div className="flex flex-wrap gap-2">
            {Object.entries(platformTags).map(([k, v]) => (
              <TagToken key={k} k={k} v={v} />
            ))}
          </div>
        </div>
      )}
    </Panel>
  );
}
