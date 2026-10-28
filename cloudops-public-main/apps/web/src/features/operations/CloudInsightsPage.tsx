import { useMemo, useState } from 'react';
import { Activity, Play, RefreshCw, ShieldAlert, ShieldCheck, Square, Users } from 'lucide-react';
import type { GcpInsightSnapshot } from '../../lib/queries';
import {
  useExecuteGcpVm,
  useGcpInsights,
  useSyncGcpInsights,
} from '../../lib/queries';
import { usePermissions } from '../../lib/auth';
import { apiErrorMessage } from '../../lib/api';
import { useConfirm } from '../../components/ui/Dialogs';
import { useToast } from '../../components/ui/Toast';
import {
  Alert,
  Badge,
  Button,
  EmptyState,
  LoadingBlock,
  PageHeader,
  Panel,
  Select,
  SectionHeading,
} from '../../components/ui/primitives';

const TABS = [
  { key: 'security', label: 'Security alerts', icon: ShieldAlert },
  { key: 'metrics', label: 'Metrics', icon: Activity },
  { key: 'rbac', label: 'Access (RBAC)', icon: Users },
  { key: 'health', label: 'Service health', icon: Activity },
  { key: 'recommendations', label: 'Recommendations', icon: ShieldCheck },
] as const;
type InsightTab = (typeof TABS)[number]['key'];
type Row = Record<string, unknown>;

const COLUMNS: Record<InsightTab, { key: string; label: string }[]> = {
  security: [
    { key: 'severity', label: 'Severity' },
    { key: 'category', label: 'Finding' },
    { key: 'state', label: 'State' },
    { key: 'resourceExternalId', label: 'Resource' },
    { key: 'description', label: 'Description' },
    { key: 'detectedAt', label: 'Detected' },
  ],
  metrics: [
    { key: 'resourceExternalId', label: 'Resource' },
    { key: 'metricType', label: 'Metric' },
    { key: 'points', label: 'Recent CPU samples (24h)' },
  ],
  rbac: [
    { key: 'role', label: 'Role' },
    { key: 'member', label: 'Member' },
    { key: 'scope', label: 'Scope' },
    { key: 'condition', label: 'Condition' },
  ],
  health: [
    { key: 'title', label: 'Event' },
    { key: 'state', label: 'State' },
    { key: 'category', label: 'Category' },
    { key: 'relevance', label: 'Relevance' },
    { key: 'description', label: 'Description' },
    { key: 'startTime', label: 'Started' },
    { key: 'endTime', label: 'Ended' },
  ],
  recommendations: [
    { key: 'recommender', label: 'Recommender' },
    { key: 'state', label: 'State' },
    { key: 'impact', label: 'Impact' },
    { key: 'resourceExternalId', label: 'Resource' },
    { key: 'description', label: 'Recommendation' },
  ],
};

function rowsOf(snapshot?: GcpInsightSnapshot): Row[] {
  return Array.isArray(snapshot?.data) ? (snapshot.data as Row[]) : [];
}

function renderValue(key: string, value: unknown): string {
  if (value == null || value === '') return '—';
  if (key === 'points' && Array.isArray(value)) {
    return value
      .map((point) => {
        if (!point || typeof point !== 'object') return '';
        const sample = point as { at?: unknown; value?: unknown };
        const val = typeof sample.value === 'number' ? `${(sample.value * 100).toFixed(1)}%` : '—';
        return `${val} · ${typeof sample.at === 'string' ? new Date(sample.at).toLocaleString() : ''}`;
      })
      .filter(Boolean)
      .join('\n');
  }
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function InsightTable({ capability, rows }: { capability: InsightTab; rows: Row[] }) {
  const columns = COLUMNS[capability];
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={TABS.find((tab) => tab.key === capability)?.icon ?? Activity}
        title={`No ${TABS.find((tab) => tab.key === capability)?.label.toLowerCase()} found`}
        description="A successful sync may return no findings. Check the capability status above if the data is unavailable."
      />
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left text-body-sm">
        <thead className="border-b border-line text-caption uppercase text-fg-muted">
          <tr>
            {columns.map((column) => (
              <th key={column.key} className="px-3 py-2 font-medium">
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line-subtle">
          {rows.map((row, index) => (
            <tr key={String(row.id ?? row.name ?? index)} className="align-top">
              {columns.map((column) => (
                <td
                  key={column.key}
                  className="max-w-[32rem] whitespace-pre-line break-words px-3 py-3 text-fg-secondary"
                >
                  {renderValue(column.key, row[column.key])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function CloudInsightsPage() {
  const { can } = usePermissions();
  const toast = useToast();
  const confirm = useConfirm();
  const query = useGcpInsights();
  const sync = useSyncGcpInsights();
  const execute = useExecuteGcpVm();
  const [selectedProject, setSelectedProject] = useState('');
  const [tab, setTab] = useState<InsightTab>('security');
  const [vmId, setVmId] = useState('');

  const projectId = selectedProject || query.data?.projects[0]?.projectId || '';
  const project = query.data?.projects.find((item) => item.projectId === projectId);
  const projectSnapshots = useMemo(
    () => query.data?.snapshots.filter((snapshot) => snapshot.projectId === projectId) ?? [],
    [query.data?.snapshots, projectId],
  );
  const snapshot = projectSnapshots.find((item) => item.capability === tab);
  const vmTargets = query.data?.vmTargets ?? [];

  async function syncInsights() {
    try {
      const result = await sync.mutateAsync();
      const failures = result.snapshots.filter(
        (item) => Boolean((item as { error?: string | null }).error),
      ).length;
      toast({
        tone: failures ? 'warning' : 'success',
        title: failures ? 'Insights synced with unavailable capabilities' : 'GCP insights synced',
        description: failures
          ? `${failures} project/capability request(s) failed. Open the capability to see the error.`
          : 'Latest data is saved locally in CloudOps.',
      });
    } catch (error) {
      toast({ tone: 'danger', title: 'Couldn’t sync GCP insights', description: apiErrorMessage(error) });
    }
  }

  async function executeVm(operation: 'start' | 'stop') {
    const target = vmTargets.find((item) => item.externalId === vmId);
    if (!target) return;
    const accepted = await confirm({
      title: `${operation === 'start' ? 'Start' : 'Stop'} ${target.name}?`,
      description:
        operation === 'start'
          ? 'This sends a start request to Compute Engine. The VM may incur costs while running.'
          : 'This sends a stop request to Compute Engine. Applications currently using the VM may be interrupted.',
      confirmLabel: operation === 'start' ? 'Start VM' : 'Stop VM',
      tone: operation === 'stop' ? 'danger' : 'default',
    });
    if (!accepted) return;
    try {
      const result = await execute.mutateAsync({ externalId: vmId, operation });
      toast({ tone: 'success', title: result.message, description: target.name });
    } catch (error) {
      toast({ tone: 'danger', title: `Couldn’t ${operation} VM`, description: apiErrorMessage(error) });
    }
  }

  return (
    <div>
      <PageHeader
        overline="Google Cloud"
        title="Cloud insights"
        subtitle="Security findings, CPU metrics, project IAM, service health, and recommendations synced from your configured GCP projects."
        actions={
          can('inventory.sync') ? (
            <Button icon={RefreshCw} loading={sync.isPending} onClick={() => void syncInsights()}>
              Sync insights
            </Button>
          ) : undefined
        }
      />

      {query.isLoading ? (
        <LoadingBlock label="Loading cloud insights…" />
      ) : query.error ? (
        <Alert tone="danger">{apiErrorMessage(query.error)}</Alert>
      ) : !query.data?.projects.length ? (
        <EmptyState
          icon={ShieldAlert}
          title="No Google Cloud projects configured"
          description="Add a project in Providers, then sync insights to load GCP data."
        />
      ) : (
        <div className="space-y-6">
          {query.data.projects.length > 1 && (
            <div className="max-w-sm">
              <Select
                value={projectId}
                onChange={(event) => setSelectedProject(event.target.value)}
                aria-label="Google Cloud project"
              >
                {query.data.projects.map((item) => (
                  <option key={item.projectId} value={item.projectId}>
                    {item.name} · {item.projectId}
                  </option>
                ))}
              </Select>
            </div>
          )}

          <Panel className="overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
              <div>
                <SectionHeading title={project?.name ?? projectId} />
                <p className="font-mono text-caption text-fg-muted">{projectId}</p>
              </div>
              {snapshot && (
                <div className="flex items-center gap-2">
                  {snapshot.error ? (
                    <Badge tone="danger">Unavailable</Badge>
                  ) : (
                    <Badge tone="success">{rowsOf(snapshot).length} records</Badge>
                  )}
                  <span className="text-caption text-fg-muted">
                    {new Date(snapshot.syncedAt).toLocaleString()}
                  </span>
                </div>
              )}
            </div>
            <div className="flex gap-1 overflow-x-auto border-b border-line px-3 pt-2">
              {TABS.map((item) => (
                <button
                  type="button"
                  key={item.key}
                  onClick={() => setTab(item.key)}
                  aria-pressed={tab === item.key}
                  className={`flex shrink-0 items-center gap-2 rounded-t-sm px-3 py-2 text-body-sm ${
                    tab === item.key
                      ? 'border-b-2 border-accent text-fg'
                      : 'text-fg-muted hover:text-fg-secondary'
                  }`}
                >
                  <item.icon className="size-4" aria-hidden />
                  {item.label}
                </button>
              ))}
            </div>
            <div className="p-4">
              {snapshot?.error ? (
                <Alert tone="warning">
                  {snapshot.error}
                  <span className="mt-1 block text-caption">
                    Verify that the required Google API is enabled and the service account has the documented viewer role.
                  </span>
                </Alert>
              ) : snapshot ? (
                <InsightTable capability={tab} rows={rowsOf(snapshot)} />
              ) : (
                <EmptyState
                  icon={Activity}
                  title="No insights synced yet"
                  description="Run Sync insights to fetch and save current data from Google Cloud."
                  action={
                    can('inventory.sync') ? (
                      <Button icon={RefreshCw} loading={sync.isPending} onClick={() => void syncInsights()}>
                        Sync insights
                      </Button>
                    ) : undefined
                  }
                />
              )}
            </div>
          </Panel>

          <Panel className="p-4">
            <SectionHeading title="Compute Engine VM operations" />
            <p className="mb-4 mt-1 text-body-sm text-fg-muted">
              Only start and stop operations are available. No shell commands, SSH, or deletion are exposed.
            </p>
            {can('remediation.execute') ? (
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                <Select
                  className="min-w-0 flex-1"
                  value={vmId}
                  onChange={(event) => setVmId(event.target.value)}
                  aria-label="Compute Engine VM"
                >
                  <option value="">Choose a synced VM…</option>
                  {vmTargets.map((target) => (
                    <option key={target.externalId} value={target.externalId}>
                      {target.name}{target.location ? ` · ${target.location}` : ''}
                    </option>
                  ))}
                </Select>
                <Button
                  variant="secondary"
                  icon={Play}
                  disabled={!vmId || execute.isPending}
                  loading={execute.isPending}
                  onClick={() => void executeVm('start')}
                >
                  Start VM
                </Button>
                <Button
                  variant="danger"
                  icon={Square}
                  disabled={!vmId || execute.isPending}
                  loading={execute.isPending}
                  onClick={() => void executeVm('stop')}
                >
                  Stop VM
                </Button>
              </div>
            ) : (
              <Alert tone="info">The remediation.execute permission is required to operate VMs.</Alert>
            )}
          </Panel>
        </div>
      )}
    </div>
  );
}
