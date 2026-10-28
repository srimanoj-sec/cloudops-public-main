import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  DashboardSummary,
  DashboardOverview,
  FacetsDto,
  FinopsQuery,
  FinopsQueryResult,
  OrganizationDto,
  Paginated,
  ProviderTestResult,
  ResourceCostTrendDto,
  ResourceDetailDto,
  ResourceDto,
  ResourceGroupDto,
  ResourceHistoryDto,
  SubscriptionDto,
  SyncRequest,
  SyncRunDto,
  SyncRunChangeDto,
  CostCoverageDto,
  CostSyncRunDto,
  SystemStatusDto,
  DuplicatePreviewDto,
  DuplicateMergeResultDto,
  CostAnomaliesDto,
  TopologyResult,
  CreateWorkItemRequest,
  UpdateWorkItemRequest,
  WorkItemDetailDto,
  WorkItemDto,
  WorkItemQuery,
  WorkSummaryDto,
  SavedViewDto,
  CreateSavedViewRequest,
  UpdateSavedViewRequest,
  WorkspaceDto,
  ScopeWorkspaceDto,
  DocumentDto,
  CreateDocumentRequest,
  UpdateDocumentRequest,
  StandardsSummaryDto,
  ComplianceResultDto,
  ResourceComplianceDto,
  CreateStandardRequest,
  BudgetInput,
  FinopsOverviewDto,
  InventoryGroupBy,
  InventoryGroupsDto,
  InventoryTreeDto,
  CreateExemptionRequest,
  ExemptionDto,
  PreviewRuleRequest,
  RulePreviewDto,
  RuleTemplateDto,
  CreateRuleRequest,
  UpdateRuleRequest,
  TagWriteResult,
  ResourceGroupTagResult,
  ProviderAccountDto,
  ProviderAccountsStatusDto,
  CreateProviderAccountRequest,
  UpdateProviderAccountRequest,
  AccountConnResult,
  AdminUserDto,
  AuditLogDto,
  AuditQuery,
  CreateUserInput,
  UpdateUserInput,
  TagJobDto,
  NotificationListDto,
  NotificationQuery,
  SearchKind,
  SearchResponseDto,
  RemediationActionDto,
  RemediationPlanDto,
  RemediationQuery,
  RemediationRunDetailDto,
  RemediationRunDto,
  RemediationTargeting,
  CreateRemediationRequest,
  EvaluationStatusDto,
  BulkExemptionRequest,
  ResourceActivityDto,
  ResourceRefreshResultDto,
  TopologyClusterResult,
  SyncRunsQuery,
  DriftQuery,
  DriftListDto,
  DriftChangeDto,
  DriftActivityDto,
  JobDetailDto,
  JobState,
  JobSummaryDto,
  SessionDto,
  AuditActorDto,
  AutomationPreviewDto,
  AutomationRuleDto,
  AutomationRuleRequest,
  AutomationRunDto,
  DocumentRevisionDto,
} from '@cloudops/core';
import { api } from './api';

export function useDashboard(tenantId?: string) {
  return useQuery({
    queryKey: ['dashboard', tenantId ?? 'all'],
    queryFn: async () =>
      (
        await api.get<DashboardSummary>('/api/dashboard/summary', {
          params: tenantId ? { tenantId } : undefined,
        })
      ).data,
    refetchInterval: 15_000,
  });
}

/** Operations Command Center — cross-module overview (health, cost, compliance, work). */
export function useDashboardOverview(tenantId?: string) {
  return useQuery({
    queryKey: ['dashboard-overview', tenantId ?? 'all'],
    queryFn: async () =>
      (
        await api.get<DashboardOverview>('/api/dashboard/overview', {
          params: tenantId ? { tenantId } : undefined,
        })
      ).data,
    refetchInterval: 30_000,
    placeholderData: (prev) => prev,
  });
}

/** Client → API query params. Multi-select filters are sent comma-separated. */
export type ResourceQueryParams = Record<string, string | number | undefined>;

export function useResources(query: ResourceQueryParams, enabled = true) {
  return useQuery({
    queryKey: ['resources', query],
    enabled,
    queryFn: async () =>
      (await api.get<Paginated<ResourceDto>>('/api/inventory/resources', { params: query })).data,
    placeholderData: (prev) => prev,
  });
}

/** The filtered inventory grouped by org / subscription / resource group / category / type / region / owner. */
export function useInventoryGroups(query: ResourceQueryParams, groupBy: InventoryGroupBy | null) {
  return useQuery({
    queryKey: ['inventory-groups', groupBy, query],
    enabled: Boolean(groupBy),
    queryFn: async () =>
      (
        await api.get<InventoryGroupsDto>('/api/inventory/resources/groups', {
          params: { ...query, groupBy },
        })
      ).data,
    placeholderData: (prev) => prev,
  });
}

/** Org › subscription › resource group with counts — the inventory's scope navigator. */
export function useInventoryTree(states: string) {
  return useQuery({
    queryKey: ['inventory-tree', states],
    queryFn: async () =>
      (await api.get<InventoryTreeDto>('/api/inventory/tree', { params: { states } })).data,
    staleTime: 60_000,
  });
}

export function useResource(id: string | null) {
  return useQuery({
    queryKey: ['resource', id],
    enabled: Boolean(id),
    queryFn: async () => (await api.get<ResourceDetailDto>(`/api/inventory/resources/${id}`)).data,
  });
}

export function useResourceHistory(id: string | null) {
  return useQuery({
    queryKey: ['resource-history', id],
    enabled: Boolean(id),
    queryFn: async () =>
      (await api.get<ResourceHistoryDto>(`/api/inventory/resources/${id}/history`)).data,
  });
}

export function useFacets() {
  return useQuery({
    queryKey: ['facets'],
    queryFn: async () => (await api.get<FacetsDto>('/api/inventory/resources/facets')).data,
  });
}

export function useOrganizations(tenantId?: string) {
  return useQuery({
    queryKey: ['organizations', tenantId ?? 'all'],
    queryFn: async () =>
      (
        await api.get<OrganizationDto[]>('/api/inventory/organizations', {
          params: tenantId ? { tenantId } : undefined,
        })
      ).data,
  });
}

/** On-demand: validate each configured org's service-principal read access. */
export function useTestConnections(providerKey = 'azure') {
  return useMutation({
    mutationFn: async () =>
      (await api.get<ProviderTestResult>(`/api/providers/${providerKey}/test`)).data,
  });
}

export function useSubscriptions(tenantId?: string) {
  return useQuery({
    queryKey: ['subscriptions', tenantId ?? 'all'],
    queryFn: async () =>
      (
        await api.get<SubscriptionDto[]>('/api/inventory/subscriptions', {
          params: tenantId ? { tenantId } : undefined,
        })
      ).data,
  });
}

export function useResourceGroups(subscriptionId?: string, tenantId?: string) {
  return useQuery({
    queryKey: ['resource-groups', subscriptionId ?? 'all', tenantId ?? 'all'],
    queryFn: async () => {
      const params: Record<string, string> = {};
      if (subscriptionId) params.subscriptionId = subscriptionId;
      if (tenantId) params.tenantId = tenantId;
      return (
        await api.get<ResourceGroupDto[]>('/api/inventory/resource-groups', {
          params: Object.keys(params).length ? params : undefined,
        })
      ).data;
    },
  });
}

export function useFinopsQuery(params: Partial<FinopsQuery>) {
  return useQuery({
    queryKey: ['finops-query', params],
    queryFn: async () => (await api.get<FinopsQueryResult>('/api/finops/query', { params })).data,
    placeholderData: (prev) => prev,
  });
}

/** Topology query params as sent (comma lists stay strings; the API parses them). */
export type TopologyParams = Record<string, string | number | undefined>;

export function useTopology(params: TopologyParams, enabled = true) {
  return useQuery({
    queryKey: ['topology', params],
    enabled,
    queryFn: async () => (await api.get<TopologyResult>('/api/topology', { params })).data,
    placeholderData: (prev) => prev,
  });
}

export function useResourceCostTrend(id: string | null) {
  return useQuery({
    queryKey: ['resource-cost-trend', id],
    enabled: Boolean(id),
    queryFn: async () =>
      (await api.get<ResourceCostTrendDto>(`/api/finops/resources/${id}/trend`)).data,
  });
}

export function useSyncCost() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (days?: number) =>
      (
        await api.post<{ status: string; days: number; deduplicated?: boolean }>(
          '/api/finops/sync',
          days ? { days } : {},
        )
      ).data,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['finops-summary'] });
      void qc.invalidateQueries({ queryKey: ['finops-runs'] });
    },
  });
}

// ── Run feeds: poll fast only while something is running ────────────
const LIVE_RUN = new Set(['queued', 'running']);
/** While a run is queued/running, check every 3 s; otherwise once a minute. */
const runPollInterval = (runs: { status: string }[] | undefined) =>
  runs?.some((r) => LIVE_RUN.has(r.status)) ? 3_000 : 60_000;

/** Did any run that was live in `prev` finish in `next`? */
export function runFinished(
  prev: { id: string; status: string }[] | undefined,
  next: { id: string; status: string }[],
): boolean {
  if (!prev) return false;
  const live = new Set(prev.filter((r) => LIVE_RUN.has(r.status)).map((r) => r.id));
  return next.some((r) => live.has(r.id) && !LIVE_RUN.has(r.status));
}

/** Data an inventory sync can change — refreshed the moment a sync finishes. */
const INVENTORY_KEYS = [
  'dashboard',
  'dashboard-overview',
  'resources',
  'facets',
  'subscriptions',
  'resource-groups',
  'organizations',
  'topology',
  'resource',
  'resource-history',
  'standards-summary',
  'compliance-results',
  'resource-compliance',
  'inventory-groups',
  'inventory-tree',
];
/** Data a cost sync can change. */
const COST_KEYS = [
  'finops-overview',
  'finops-coverage',
  'finops-summary',
  'finops-query',
  'cost-anomalies',
  'dashboard',
  'dashboard-overview',
  'resources',
  'resource',
  'resource-cost-trend',
];

/** Recent cost-sync job status (queued/running/completed). */
export function useFinopsRuns() {
  const qc = useQueryClient();
  return useQuery({
    queryKey: ['finops-runs'],
    queryFn: async () => {
      const prev = qc.getQueryData<CostSyncRunDto[]>(['finops-runs']);
      const runs = (await api.get<CostSyncRunDto[]>('/api/finops/runs')).data;
      // A cost sync takes minutes — show its results without making the user reload.
      if (runFinished(prev, runs))
        COST_KEYS.forEach((key) => void qc.invalidateQueries({ queryKey: [key] }));
      return runs;
    },
    refetchInterval: (q) => runPollInterval(q.state.data),
  });
}

/** Per-subscription cost data coverage: latest stored day and last sync outcome. */
export function useCostCoverage() {
  return useQuery({
    queryKey: ['finops-coverage'],
    queryFn: async () => (await api.get<CostCoverageDto[]>('/api/finops/coverage')).data,
  });
}

/** This month (to date / forecast / vs last month), unattributed spend, savings and budgets. */
export function useFinopsOverview(scope: { tenantId?: string; subscriptionId?: string }) {
  return useQuery({
    queryKey: ['finops-overview', scope],
    queryFn: async () =>
      (await api.get<FinopsOverviewDto>('/api/finops/overview', { params: scope })).data,
    placeholderData: (prev) => prev,
  });
}

export function useSaveBudget() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, input }: { id?: string; input: BudgetInput }) =>
      id
        ? (await api.put(`/api/finops/budgets/${id}`, input)).data
        : (await api.post('/api/finops/budgets', input)).data,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['finops-overview'] }),
  });
}

export function useDeleteBudget() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await api.delete(`/api/finops/budgets/${id}`);
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['finops-overview'] }),
  });
}

/** Cost-spike monitor: resources whose latest daily cost jumped above baseline. */
export function useCostAnomalies(tenantId?: string, threshold?: number) {
  return useQuery({
    queryKey: ['cost-anomalies', tenantId ?? 'all', threshold ?? 10],
    queryFn: async () =>
      (
        await api.get<CostAnomaliesDto>('/api/finops/anomalies', {
          params: { ...(tenantId ? { tenantId } : {}), ...(threshold ? { threshold } : {}) },
        })
      ).data,
    placeholderData: (prev) => prev,
  });
}

export function useSyncRuns() {
  const qc = useQueryClient();
  return useQuery({
    queryKey: ['sync-runs'],
    queryFn: async () => {
      const prev = qc.getQueryData<SyncRunDto[]>(['sync-runs']);
      const runs = (await api.get<SyncRunDto[]>('/api/sync/runs')).data;
      if (runFinished(prev, runs))
        INVENTORY_KEYS.forEach((key) => void qc.invalidateQueries({ queryKey: [key] }));
      return runs;
    },
    refetchInterval: (q) => runPollInterval(q.state.data),
  });
}

/** Field-level changes a specific sync run detected — the "what changed" drilldown. */
export function useSyncRunChanges(runId: string | null) {
  return useQuery({
    queryKey: ['sync-run-changes', runId],
    enabled: Boolean(runId),
    queryFn: async () =>
      (await api.get<SyncRunChangeDto[]>(`/api/sync/runs/${runId}/changes`)).data,
  });
}

export function useEnqueueSync() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (req: SyncRequest) =>
      (await api.post<SyncRunDto>('/api/sync/azure', req)).data,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['sync-runs'] });
    },
  });
}

export interface ProviderInfo {
  key: string;
  displayName: string;
  capabilities: string[];
  registered: boolean;
  /** Organizations configured for this provider (store + env). */
  accountCount: number;
}

export function useProviders() {
  return useQuery({
    queryKey: ['providers'],
    queryFn: async () => (await api.get<ProviderInfo[]>('/api/providers')).data,
  });
}

export interface GcpInsightSnapshot {
  id: string;
  providerKey: string;
  projectId: string;
  capability: string;
  data: unknown;
  error: string | null;
  syncedAt: string;
  updatedAt: string;
}

export interface GcpInsightsDto {
  projects: { name: string; projectId: string }[];
  snapshots: GcpInsightSnapshot[];
  vmTargets: { externalId: string; name: string; location: string | null }[];
}

export function useGcpInsights() {
  return useQuery({
    queryKey: ['gcp-insights'],
    queryFn: async () =>
      (await api.get<GcpInsightsDto>('/api/providers/gcp-insights')).data,
  });
}

export function useSyncGcpInsights() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () =>
      (await api.post<{ snapshots: unknown[] }>('/api/providers/gcp-insights/sync')).data,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['gcp-insights'] });
    },
  });
}

export function useExecuteGcpVm() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { externalId: string; operation: 'start' | 'stop' }) =>
      (await api.post<{ message: string; preview: string }>('/api/providers/gcp-insights/execute', input)).data,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['gcp-insights'] });
      void qc.invalidateQueries({ queryKey: ['resources'] });
    },
  });
}

// ── Provider accounts (organizations) ─────────────────────────────
// Credentials are entered here instead of .env. The client secret is write-only:
// it is sent on create/update and never returned.

export function useProviderAccounts(providerKey: string) {
  return useQuery({
    queryKey: ['provider-accounts', providerKey],
    queryFn: async () =>
      (await api.get<ProviderAccountDto[]>(`/api/providers/${providerKey}/accounts`)).data,
  });
}

export function useProviderAccountsStatus(providerKey: string) {
  return useQuery({
    queryKey: ['provider-accounts-status', providerKey],
    queryFn: async () =>
      (await api.get<ProviderAccountsStatusDto>(`/api/providers/${providerKey}/accounts/status`))
        .data,
  });
}

/** Invalidate everything that depends on which organizations are configured. */
function useAccountsInvalidator(providerKey: string) {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ['provider-accounts', providerKey] });
    void qc.invalidateQueries({ queryKey: ['provider-accounts-status', providerKey] });
    void qc.invalidateQueries({ queryKey: ['providers'] });
  };
}

export function useCreateProviderAccount(providerKey: string) {
  const invalidate = useAccountsInvalidator(providerKey);
  return useMutation({
    mutationFn: async (input: CreateProviderAccountRequest) =>
      (await api.post<ProviderAccountDto>(`/api/providers/${providerKey}/accounts`, input)).data,
    onSuccess: invalidate,
  });
}

export function useUpdateProviderAccount(providerKey: string) {
  const invalidate = useAccountsInvalidator(providerKey);
  return useMutation({
    mutationFn: async ({ id, input }: { id: string; input: UpdateProviderAccountRequest }) =>
      (await api.patch<ProviderAccountDto>(`/api/providers/${providerKey}/accounts/${id}`, input))
        .data,
    onSuccess: invalidate,
  });
}

export function useDeleteProviderAccount(providerKey: string) {
  const invalidate = useAccountsInvalidator(providerKey);
  return useMutation({
    mutationFn: async (id: string) => {
      await api.delete(`/api/providers/${providerKey}/accounts/${id}`);
    },
    onSuccess: invalidate,
  });
}

/** Verify credentials typed into the form, before saving them. */
export function useTestProviderCredentials(providerKey: string) {
  return useMutation({
    mutationFn: async (input: CreateProviderAccountRequest) =>
      (await api.post<AccountConnResult>(`/api/providers/${providerKey}/accounts/test`, input))
        .data,
  });
}

/** Verify one saved organization using the secret held server-side. */
export function useTestProviderAccount(providerKey: string) {
  return useMutation({
    mutationFn: async (id: string) =>
      (await api.post<AccountConnResult>(`/api/providers/${providerKey}/accounts/${id}/test`, {}))
        .data,
  });
}

/** True when Azure advertises the `tags` (write) capability — i.e. AZURE_ALLOW_WRITE is on. */
export function useAzureWriteEnabled(): boolean {
  const providers = useProviders();
  return Boolean(providers.data?.find((p) => p.key === 'azure')?.capabilities.includes('tags'));
}

// ── Tag write-back ────────────────────────────────────────────────

export function useSetResourceTags() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, tags }: { id: string; tags: Record<string, string> }) =>
      (await api.put<TagWriteResult>(`/api/inventory/resources/${id}/tags`, { tags })).data,
    onSuccess: (_data, vars) => {
      void qc.invalidateQueries({ queryKey: ['resource', vars.id] });
      void qc.invalidateQueries({ queryKey: ['resources'] });
      void qc.invalidateQueries({ queryKey: ['facets'] });
    },
  });
}

export function useApplyResourceGroupTags() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, tags }: { id: string; tags: Record<string, string> }) =>
      (await api.put<ResourceGroupTagResult>(`/api/inventory/resource-groups/${id}/tags`, { tags }))
        .data,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['resource-groups'] });
      void qc.invalidateQueries({ queryKey: ['resources'] });
    },
  });
}

// ── Work management (tasks at any scope) ──────────────────────────

export function useWorkItems(query: Partial<WorkItemQuery>) {
  return useQuery({
    queryKey: ['work-items', query],
    queryFn: async () => (await api.get<WorkItemDto[]>('/api/work/items', { params: query })).data,
    placeholderData: (prev) => prev,
  });
}

export function useWorkItem(id: string | null) {
  return useQuery({
    queryKey: ['work-item', id],
    enabled: Boolean(id),
    queryFn: async () => (await api.get<WorkItemDetailDto>(`/api/work/items/${id}`)).data,
  });
}

export function useWorkSummary(query: Partial<WorkItemQuery>) {
  return useQuery({
    queryKey: ['work-summary', query],
    queryFn: async () =>
      (await api.get<WorkSummaryDto>('/api/work/summary', { params: query })).data,
  });
}

/** Invalidate all work lists/summaries after a mutation. */
function invalidateWork(qc: ReturnType<typeof useQueryClient>) {
  void qc.invalidateQueries({ queryKey: ['work-items'] });
  void qc.invalidateQueries({ queryKey: ['work-summary'] });
}

export function useCreateWorkItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateWorkItemRequest) =>
      (await api.post<WorkItemDto>('/api/work/items', input)).data,
    onSuccess: () => invalidateWork(qc),
  });
}

export function useUpdateWorkItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, input }: { id: string; input: UpdateWorkItemRequest }) =>
      (await api.patch<WorkItemDto>(`/api/work/items/${id}`, input)).data,
    onSuccess: (_data, vars) => {
      invalidateWork(qc);
      void qc.invalidateQueries({ queryKey: ['work-item', vars.id] });
    },
  });
}

export function useDeleteWorkItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await api.delete(`/api/work/items/${id}`);
    },
    onSuccess: () => invalidateWork(qc),
  });
}

export function useAddWorkComment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, body }: { id: string; body: string }) =>
      (await api.post(`/api/work/items/${id}/comments`, { body })).data,
    onSuccess: (_data, vars) => void qc.invalidateQueries({ queryKey: ['work-item', vars.id] }),
  });
}

// ── Saved views (P6) ──────────────────────────────────────────────

export function useSavedViews(scope = 'inventory') {
  return useQuery({
    queryKey: ['saved-views', scope],
    queryFn: async () => (await api.get<SavedViewDto[]>('/api/views', { params: { scope } })).data,
  });
}

export function useCreateSavedView() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateSavedViewRequest) =>
      (await api.post<SavedViewDto>('/api/views', input)).data,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['saved-views'] }),
  });
}

export function useUpdateSavedView() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, input }: { id: string; input: UpdateSavedViewRequest }) =>
      (await api.put<SavedViewDto>(`/api/views/${id}`, input)).data,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['saved-views'] }),
  });
}

export function useDeleteSavedView() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await api.delete(`/api/views/${id}`);
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['saved-views'] }),
  });
}

// ── Resource workspaces / docs (Phase 4) ──────────────────────────

export function useWorkspaces() {
  return useQuery({
    queryKey: ['workspaces'],
    queryFn: async () => (await api.get<WorkspaceDto[]>('/api/workspaces')).data,
  });
}

export function useScopeWorkspace(scopeType: string, scopeId: string | null) {
  return useQuery({
    queryKey: ['workspace-scope', scopeType, scopeId],
    enabled: Boolean(scopeType && scopeId),
    queryFn: async () =>
      (await api.get<ScopeWorkspaceDto>(`/api/workspaces/scope/${scopeType}/${scopeId}`)).data,
  });
}

interface DocScope {
  scopeType: string;
  scopeId: string;
}

function invalidateWorkspace(qc: ReturnType<typeof useQueryClient>, s: DocScope) {
  void qc.invalidateQueries({ queryKey: ['workspace-scope', s.scopeType, s.scopeId] });
  void qc.invalidateQueries({ queryKey: ['workspaces'] });
}

export function useCreateDocument() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      scopeType,
      scopeId,
      input,
    }: DocScope & { input: CreateDocumentRequest }) =>
      (
        await api.post<DocumentDto>(
          `/api/workspaces/scope/${scopeType}/${scopeId}/documents`,
          input,
        )
      ).data,
    onSuccess: (_d, v) => invalidateWorkspace(qc, v),
  });
}

export function useUpdateDocument() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, input }: DocScope & { id: string; input: UpdateDocumentRequest }) =>
      (await api.patch<DocumentDto>(`/api/workspaces/documents/${id}`, input)).data,
    onSuccess: (_d, v) => invalidateWorkspace(qc, v),
  });
}

export function useDeleteDocument() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id }: DocScope & { id: string }) => {
      await api.delete(`/api/workspaces/documents/${id}`);
    },
    onSuccess: (_d, v) => invalidateWorkspace(qc, v),
  });
}

// ── Standards & governance (Phase 5) ──────────────────────────────

export function useStandardsSummary() {
  return useQuery({
    queryKey: ['standards-summary'],
    queryFn: async () => (await api.get<StandardsSummaryDto>('/api/standards')).data,
  });
}

export function useComplianceResults(ruleId: string | null, passed?: boolean) {
  return useQuery({
    queryKey: ['compliance-results', ruleId, passed],
    enabled: Boolean(ruleId),
    queryFn: async () =>
      (
        await api.get<ComplianceResultDto[]>('/api/standards/results', {
          params: { ruleId, ...(passed === undefined ? {} : { passed }) },
        })
      ).data,
  });
}

export function useResourceCompliance(id: string | null) {
  return useQuery({
    queryKey: ['resource-compliance', id],
    enabled: Boolean(id),
    queryFn: async () =>
      (await api.get<ResourceComplianceDto>(`/api/standards/resources/${id}`)).data,
  });
}

/** Everything that shows verdicts — refetched when an evaluation finishes. */
const COMPLIANCE_KEYS = [
  'standards-summary',
  'compliance-results',
  'resource-compliance',
  'dashboard-overview',
  'resources',
];

/** Queue a background evaluation; `useEvaluationStatus` follows it. */
export function useEvaluateStandards() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () =>
      (
        await api.post<EvaluationStatusDto & { deduplicated: boolean }>(
          '/api/standards/evaluate',
          undefined,
          { params: { background: 1 } },
        )
      ).data,
    onSuccess: (status) => qc.setQueryData(['evaluation-status'], status),
  });
}

/** The background evaluation — polled while one is queued or running; refetches verdicts when it ends. */
export function useEvaluationStatus() {
  const qc = useQueryClient();
  return useQuery({
    queryKey: ['evaluation-status'],
    queryFn: async () => {
      const prev = qc.getQueryData<EvaluationStatusDto>(['evaluation-status']);
      const next = (await api.get<EvaluationStatusDto>('/api/standards/evaluation')).data;
      const finished = prev && prev.state !== 'idle' && next.state === 'idle';
      const newer = prev?.last?.finishedAt !== next.last?.finishedAt && prev !== undefined;
      if (finished || newer)
        COMPLIANCE_KEYS.forEach((key) => void qc.invalidateQueries({ queryKey: [key] }));
      return next;
    },
    refetchInterval: (q) => (q.state.data && q.state.data.state !== 'idle' ? 2_000 : 60_000),
  });
}

/** Any custom-standard mutation returns the fresh summary; seed it + refetch. */
function onStandardsMutated(qc: ReturnType<typeof useQueryClient>, data: StandardsSummaryDto) {
  qc.setQueryData(['standards-summary'], data);
  void qc.invalidateQueries({ queryKey: ['standards-summary'] });
}

export function useCreateCustomStandard() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateStandardRequest) =>
      (await api.post<StandardsSummaryDto>('/api/standards/custom', input)).data,
    onSuccess: (data) => onStandardsMutated(qc, data),
  });
}

export function useDeleteCustomStandard() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) =>
      (await api.delete<StandardsSummaryDto>(`/api/standards/custom/${id}`)).data,
    onSuccess: (data) => onStandardsMutated(qc, data),
  });
}

export function useCreateStandardRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ standardId, input }: { standardId: string; input: CreateRuleRequest }) =>
      (await api.post<StandardsSummaryDto>(`/api/standards/${standardId}/rules`, input)).data,
    onSuccess: (data) => onStandardsMutated(qc, data),
  });
}

export function useUpdateStandardRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, input }: { id: string; input: UpdateRuleRequest }) =>
      (await api.patch<StandardsSummaryDto>(`/api/standards/rules/${id}`, input)).data,
    onSuccess: (data) => onStandardsMutated(qc, data),
  });
}

export function useDeleteStandardRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) =>
      (await api.delete<StandardsSummaryDto>(`/api/standards/rules/${id}`)).data,
    onSuccess: (data) => onStandardsMutated(qc, data),
  });
}

/** The rule library — every rule that can be used, with what it checks and how to fix failures. */
export function useStandardsLibrary() {
  return useQuery({
    queryKey: ['standards-library'],
    queryFn: async () => (await api.get<RuleTemplateDto[]>('/api/standards/library')).data,
    staleTime: 60 * 60_000,
  });
}

/** Dry-run a rule against the current inventory (nothing saved). */
export function usePreviewRule() {
  return useMutation({
    mutationFn: async (input: PreviewRuleRequest) =>
      (await api.post<RulePreviewDto>('/api/standards/rules/preview', input)).data,
  });
}

function onExemptionsChanged(qc: ReturnType<typeof useQueryClient>) {
  void qc.invalidateQueries({ queryKey: ['exemptions'] });
  void qc.invalidateQueries({ queryKey: ['standards-summary'] });
  void qc.invalidateQueries({ queryKey: ['compliance-results'] });
  void qc.invalidateQueries({ queryKey: ['resource-compliance'] });
}

export function useCreateExemption() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateExemptionRequest) =>
      (await api.post<ExemptionDto>('/api/standards/exemptions', input)).data,
    onSuccess: () => onExemptionsChanged(qc),
  });
}

/** The exemption register (names, who, until when, status). */
export function useExemptions(filter: { ruleId?: string; resourceId?: string } = {}) {
  return useQuery({
    queryKey: ['exemptions', filter],
    queryFn: async () =>
      (await api.get<ExemptionDto[]>('/api/standards/exemptions', { params: filter })).data,
  });
}

export function useBulkExemption() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: BulkExemptionRequest) =>
      (await api.post<{ created: number }>('/api/standards/exemptions/bulk', input)).data,
    onSuccess: () => onExemptionsChanged(qc),
  });
}

export function useDeleteExemption() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) =>
      (await api.delete<ExemptionDto>(`/api/standards/exemptions/${id}`)).data,
    onSuccess: () => onExemptionsChanged(qc),
  });
}

// ── Background RG tag jobs ────────────────────────────────────────

export function useStartRgTagJob() {
  return useMutation({
    mutationFn: async ({ id, tags }: { id: string; tags: Record<string, string> }) =>
      (await api.post<TagJobDto>(`/api/inventory/resource-groups/${id}/tags/jobs`, { tags })).data,
  });
}

/** Poll a tag job every second until it finishes; refresh inventory when it does. */
export function useTagJob(jobId: string | null) {
  const qc = useQueryClient();
  return useQuery({
    queryKey: ['tag-job', jobId],
    enabled: Boolean(jobId),
    queryFn: async () => {
      const job = (await api.get<TagJobDto>(`/api/inventory/tag-jobs/${jobId}`)).data;
      if (job.state === 'completed' || job.state === 'failed') {
        void qc.invalidateQueries({ queryKey: ['resource-groups'] });
        void qc.invalidateQueries({ queryKey: ['resources'] });
      }
      return job;
    },
    refetchInterval: (q) =>
      q.state.data && ['completed', 'failed'].includes(q.state.data.state) ? false : 1_000,
  });
}

// ── Administration: users + audit ─────────────────────────────────

export function useUsers() {
  return useQuery({
    queryKey: ['users'],
    queryFn: async () => (await api.get<AdminUserDto[]>('/api/users')).data,
  });
}

export function useCreateUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateUserInput) =>
      (await api.post<AdminUserDto>('/api/users', input)).data,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['users'] }),
  });
}

export function useUpdateUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, input }: { id: string; input: UpdateUserInput }) =>
      (await api.patch<AdminUserDto>(`/api/users/${id}`, input)).data,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['users'] }),
  });
}

export function useResetUserPassword() {
  return useMutation({
    mutationFn: async ({ id, password }: { id: string; password: string }) => {
      await api.post(`/api/users/${id}/reset-password`, { password });
    },
  });
}

/** Same Azure resource stored more than once (id letter-case) — what a merge would do (admin). */
export function useDuplicateResources() {
  return useQuery({
    queryKey: ['duplicate-resources'],
    queryFn: async () => (await api.get<DuplicatePreviewDto>('/api/system/duplicates')).data,
  });
}

export function useMergeDuplicateResources() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () =>
      (await api.post<DuplicateMergeResultDto>('/api/system/duplicates/merge')).data,
    onSuccess: () => {
      for (const key of [
        'duplicate-resources',
        'resources',
        'inventory-groups',
        'inventory-tree',
        'dashboard',
        'dashboard-overview',
        'finops-overview',
        'finops-query',
      ]) {
        void qc.invalidateQueries({ queryKey: [key] });
      }
    },
  });
}

/** On-call view (admin). Refreshes every 15 s while open. */
export function useSystemStatus() {
  return useQuery({
    queryKey: ['system-status'],
    queryFn: async () => (await api.get<SystemStatusDto>('/api/system/status')).data,
    refetchInterval: 15_000,
  });
}

export function useAuditLog(query: Partial<AuditQuery>) {
  return useQuery({
    queryKey: ['audit', query],
    queryFn: async () =>
      (await api.get<Paginated<AuditLogDto>>('/api/audit', { params: query })).data,
    placeholderData: (prev) => prev,
  });
}

export function useAuditActors() {
  return useQuery({
    queryKey: ['audit-actors'],
    queryFn: async () => (await api.get<AuditActorDto[]>('/api/audit/actors')).data,
    staleTime: 60_000,
  });
}

/** Download the filtered audit log as CSV (the API caps and records the export). */
export async function downloadAuditCsv(
  query: Partial<AuditQuery>,
): Promise<{ truncated: boolean }> {
  const res = await api.get<Blob>('/api/audit/export', { params: query, responseType: 'blob' });
  const url = URL.createObjectURL(res.data);
  const a = document.createElement('a');
  a.href = url;
  a.download = `cloudops-audit-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  return { truncated: res.headers['x-export-truncated'] === 'true' };
}

export function useAuditActions() {
  return useQuery({
    queryKey: ['audit-actions'],
    queryFn: async () => (await api.get<string[]>('/api/audit/actions')).data,
    staleTime: 60_000,
  });
}

// ── Notifications ─────────────────────────────────────────────────

/** Unread count for the header bell — a cheap poll. */
export function useUnreadNotifications(enabled = true) {
  return useQuery({
    queryKey: ['notifications-unread'],
    enabled,
    queryFn: async () =>
      (await api.get<{ unread: number }>('/api/notifications/unread-count')).data.unread,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  });
}

export function useNotifications(query: Partial<NotificationQuery>, enabled = true) {
  return useQuery({
    queryKey: ['notifications', query],
    enabled,
    queryFn: async () =>
      (await api.get<NotificationListDto>('/api/notifications', { params: query })).data,
    placeholderData: (prev) => prev,
  });
}

function invalidateNotifications(qc: ReturnType<typeof useQueryClient>) {
  void qc.invalidateQueries({ queryKey: ['notifications'] });
  void qc.invalidateQueries({ queryKey: ['notifications-unread'] });
}

export function useMarkNotificationsRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (ids: string[]) => {
      await api.post('/api/notifications/read', { ids });
    },
    onSuccess: () => invalidateNotifications(qc),
  });
}

export function useMarkAllNotificationsRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      await api.post('/api/notifications/read-all');
    },
    onSuccess: () => invalidateNotifications(qc),
  });
}

// ── Global search ─────────────────────────────────────────────────

export function useGlobalSearch(
  q: string,
  opts: { kinds?: SearchKind[]; tenantId?: string; limit?: number } = {},
) {
  const query = q.trim();
  return useQuery({
    queryKey: ['search', query, opts.kinds?.join(',') ?? '', opts.tenantId ?? '', opts.limit ?? 6],
    enabled: query.length >= 2,
    queryFn: async ({ signal }) =>
      (
        await api.get<SearchResponseDto>('/api/search', {
          params: {
            q: query,
            kinds: opts.kinds?.join(',') || undefined,
            tenantId: opts.tenantId || undefined,
            limit: opts.limit,
          },
          signal,
        })
      ).data,
    placeholderData: (prev) => prev,
    staleTime: 15_000,
  });
}

/** Active people (names only) — assignee picker and @mentions. */
export function useDirectory() {
  return useQuery({
    queryKey: ['directory-users'],
    queryFn: async () =>
      (await api.get<{ id: string; name: string }[]>('/api/directory/users')).data,
    staleTime: 5 * 60_000,
  });
}

// ── Remediation ───────────────────────────────────────────────────

export function useRemediationActions() {
  return useQuery({
    queryKey: ['remediation-actions'],
    queryFn: async () => (await api.get<RemediationActionDto[]>('/api/remediation/actions')).data,
    staleTime: 5 * 60_000,
  });
}

/** Dry run — what would change. Nothing is saved. */
export function useRemediationPlan(input: RemediationTargeting | null) {
  return useQuery({
    queryKey: ['remediation-plan', input],
    enabled: Boolean(input?.actionKey && (input.ruleId || input.resourceIds?.length)),
    queryFn: async () => (await api.post<RemediationPlanDto>('/api/remediation/plan', input)).data,
    placeholderData: (prev) => prev,
  });
}

export function useRemediationRuns(query: Partial<RemediationQuery>) {
  return useQuery({
    queryKey: ['remediation-runs', query],
    queryFn: async () =>
      (await api.get<Paginated<RemediationRunDto>>('/api/remediation/runs', { params: query }))
        .data,
    placeholderData: (prev) => prev,
    refetchInterval: (q) =>
      q.state.data?.items.some((r) => r.status === 'queued' || r.status === 'running')
        ? 3_000
        : 60_000,
  });
}

export function useRemediationRun(id: string | null) {
  return useQuery({
    queryKey: ['remediation-run', id],
    enabled: Boolean(id),
    queryFn: async () =>
      (await api.get<RemediationRunDetailDto>(`/api/remediation/runs/${id}`)).data,
    refetchInterval: (q) =>
      q.state.data && ['queued', 'running'].includes(q.state.data.status) ? 2_000 : false,
  });
}

function invalidateRemediation(
  qc: ReturnType<typeof useQueryClient>,
  run?: RemediationRunDetailDto,
) {
  void qc.invalidateQueries({ queryKey: ['remediation-runs'] });
  if (run) qc.setQueryData(['remediation-run', run.id], run);
  for (const key of ['dashboard-overview', 'notifications', 'notifications-unread'])
    void qc.invalidateQueries({ queryKey: [key] });
}

export function useRequestRemediation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateRemediationRequest) =>
      (await api.post<RemediationRunDetailDto>('/api/remediation/runs', input)).data,
    onSuccess: (run) => invalidateRemediation(qc, run),
  });
}

export function useRemediationTransition() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      op,
      approve,
      note,
    }: {
      id: string;
      op: 'decision' | 'execute' | 'cancel';
      approve?: boolean;
      note?: string;
    }) =>
      (
        await api.post<RemediationRunDetailDto>(
          `/api/remediation/runs/${id}/${op}`,
          op === 'decision' ? { approve, note } : undefined,
        )
      ).data,
    onSuccess: (run) => {
      invalidateRemediation(qc, run);
      // A finished run changes compliance, tags and cost views.
      for (const key of [
        'standards-summary',
        'compliance-results',
        'resource-compliance',
        'resource',
        'resources',
      ])
        void qc.invalidateQueries({ queryKey: [key] });
    },
  });
}

// ── Resource operations & activity ────────────────────────────────

export function useResourceActivity(id: string | null) {
  return useQuery({
    queryKey: ['resource-activity', id],
    enabled: Boolean(id),
    queryFn: async () =>
      (await api.get<ResourceActivityDto[]>(`/api/inventory/resources/${id}/activity`)).data,
  });
}

function invalidateResource(qc: ReturnType<typeof useQueryClient>, id: string) {
  for (const key of ['resource', 'resource-activity', 'resource-history', 'resource-compliance'])
    void qc.invalidateQueries({ queryKey: [key, id] });
  for (const key of ['resources', 'standards-summary', 'compliance-results'])
    void qc.invalidateQueries({ queryKey: [key] });
}

/** Re-read one resource from the provider now. */
export function useRefreshResource() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) =>
      (await api.post<ResourceRefreshResultDto>(`/api/inventory/resources/${id}/refresh`)).data,
    onSuccess: (_d, id) => invalidateResource(qc, id),
  });
}

export function useEvaluateResources() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (ids: string[]) =>
      (await api.post<{ evaluated: number }>('/api/inventory/resources/evaluate', { ids })).data,
    onSuccess: () => {
      for (const key of [
        'resources',
        'resource-compliance',
        'standards-summary',
        'compliance-results',
      ])
        void qc.invalidateQueries({ queryKey: [key] });
    },
  });
}

export function useEvaluateResource() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await api.post(`/api/inventory/resources/${id}/evaluate`);
    },
    onSuccess: (_d, id) => invalidateResource(qc, id),
  });
}

// ── Topology: map (clusters) and focus (neighbourhood) views ──────

export function useTopologyClusters(params: TopologyParams, enabled = true) {
  return useQuery({
    queryKey: ['topology-clusters', params],
    enabled,
    queryFn: async () =>
      (await api.get<TopologyClusterResult>('/api/topology/clusters', { params })).data,
    placeholderData: (prev) => prev,
  });
}

export function useTopologyNeighborhood(
  id: string | null,
  params: { depth: number; direction: 'both' | 'out' | 'in'; relTypes?: string },
) {
  return useQuery({
    queryKey: ['topology-neighborhood', id, params],
    enabled: Boolean(id),
    queryFn: async () =>
      (await api.get<TopologyResult>(`/api/topology/neighborhood/${id}`, { params })).data,
    placeholderData: (prev) => prev,
  });
}

// ── Operations: sync center, drift, jobs ──────────────────────────

/** Inventory sync history for the Sync center (filterable, paged with a cursor). */
export function useSyncRunHistory(query: Partial<SyncRunsQuery>) {
  return useQuery({
    queryKey: ['sync-runs', 'history', query],
    queryFn: async () => (await api.get<SyncRunDto[]>('/api/sync/runs', { params: query })).data,
    placeholderData: (prev) => prev,
    refetchInterval: (q) => runPollInterval(q.state.data),
  });
}

export function useSyncRun(id: string | null) {
  return useQuery({
    queryKey: ['sync-run', id],
    enabled: Boolean(id),
    queryFn: async () => (await api.get<SyncRunDto>(`/api/sync/runs/${id}`)).data,
    refetchInterval: (q) => (q.state.data && LIVE_RUN.has(q.state.data.status) ? 3_000 : false),
  });
}

export function useCancelSync() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) =>
      (await api.post<SyncRunDto>(`/api/sync/runs/${id}/cancel`)).data,
    onSuccess: (run) => {
      qc.setQueryData(['sync-run', run.id], run);
      void qc.invalidateQueries({ queryKey: ['sync-runs'] });
    },
  });
}

export function useDrift(query: Partial<DriftQuery>) {
  return useQuery({
    queryKey: ['drift', query],
    queryFn: async () => (await api.get<DriftListDto>('/api/drift', { params: query })).data,
    placeholderData: (prev) => prev,
  });
}

export function useDriftChange(id: string | null) {
  return useQuery({
    queryKey: ['drift-change', id],
    enabled: Boolean(id),
    queryFn: async () => (await api.get<DriftChangeDto>(`/api/drift/${id}`)).data,
  });
}

/** Who made a change: the provider's activity log around it (asks the provider — on demand). */
export function useDriftActivity(id: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ['drift-activity', id],
    enabled: Boolean(id) && enabled,
    queryFn: async () => (await api.get<DriftActivityDto>(`/api/drift/${id}/activity`)).data,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

export function useQueueJobs(queue: string | null, state: JobState) {
  return useQuery({
    queryKey: ['queue-jobs', queue, state],
    enabled: Boolean(queue),
    queryFn: async () =>
      (await api.get<JobSummaryDto[]>(`/api/system/queues/${queue}/jobs`, { params: { state } }))
        .data,
    refetchInterval: 15_000,
    placeholderData: (prev) => prev,
  });
}

export function useQueueJob(queue: string | null, id: string | null) {
  return useQuery({
    queryKey: ['queue-job', queue, id],
    enabled: Boolean(queue && id),
    queryFn: async () =>
      (await api.get<JobDetailDto>(`/api/system/queues/${queue}/jobs/${id}`)).data,
    retry: false,
  });
}

export function useJobAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      queue,
      id,
      action,
    }: {
      queue: string;
      id: string;
      action: 'retry' | 'remove';
    }) => {
      await api.post(`/api/system/queues/${queue}/jobs/${id}/${action}`);
    },
    onSuccess: () => {
      for (const key of ['queue-jobs', 'queue-job', 'system-status'])
        void qc.invalidateQueries({ queryKey: [key] });
    },
  });
}

// ── Sessions (signed-in devices) ──────────────────────────────────

export function useMySessions(enabled = true) {
  return useQuery({
    queryKey: ['sessions', 'me'],
    enabled,
    queryFn: async () => (await api.get<SessionDto[]>('/api/auth/sessions')).data,
  });
}

export function useRevokeSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await api.post(`/api/auth/sessions/${id}/revoke`);
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['sessions'] }),
  });
}

/** Admin: a user's signed-in devices. */
export function useUserSessions(userId: string | null) {
  return useQuery({
    queryKey: ['sessions', 'user', userId],
    enabled: Boolean(userId),
    queryFn: async () => (await api.get<SessionDto[]>(`/api/users/${userId}/sessions`)).data,
  });
}

/** Admin: sign a user out everywhere, immediately. */
export function useSignOutUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (userId: string) => {
      await api.post(`/api/users/${userId}/sign-out`);
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['sessions'] }),
  });
}

// ── Automation ────────────────────────────────────────────────────

export function useAutomationRules() {
  return useQuery({
    queryKey: ['automation-rules'],
    queryFn: async () => (await api.get<AutomationRuleDto[]>('/api/automation/rules')).data,
  });
}

export function useAutomationRuns(ruleId?: string | null) {
  return useQuery({
    queryKey: ['automation-runs', ruleId ?? 'all'],
    queryFn: async () =>
      (
        await api.get<AutomationRunDto[]>('/api/automation/runs', {
          params: ruleId ? { ruleId, limit: 50 } : { limit: 50 },
        })
      ).data,
    placeholderData: (prev) => prev,
  });
}

const onAutomationChanged = (qc: ReturnType<typeof useQueryClient>) => {
  for (const key of ['automation-rules', 'automation-runs'])
    void qc.invalidateQueries({ queryKey: [key] });
};

export function useSaveAutomationRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, rule }: { id?: string; rule: AutomationRuleRequest }) =>
      id
        ? (await api.put<AutomationRuleDto>(`/api/automation/rules/${id}`, rule)).data
        : (await api.post<AutomationRuleDto>('/api/automation/rules', rule)).data,
    onSuccess: () => onAutomationChanged(qc),
  });
}

export function useToggleAutomationRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, enabled }: { id: string; enabled: boolean }) =>
      (await api.post<AutomationRuleDto>(`/api/automation/rules/${id}/enabled`, { enabled })).data,
    onSuccess: () => onAutomationChanged(qc),
  });
}

export function useDeleteAutomationRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await api.delete(`/api/automation/rules/${id}`);
    },
    onSuccess: () => onAutomationChanged(qc),
  });
}

export function useRunAutomationRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) =>
      (await api.post<AutomationRunDto>(`/api/automation/rules/${id}/run`)).data,
    onSuccess: () => {
      onAutomationChanged(qc);
      for (const key of ['work-items', 'work-summary', 'notifications', 'notifications-unread'])
        void qc.invalidateQueries({ queryKey: [key] });
    },
  });
}

/** What a (draft) rule would act on with today's data — nothing is done. */
export function useAutomationPreview() {
  return useMutation({
    mutationFn: async (rule: AutomationRuleRequest & { ruleId?: string }) =>
      (await api.post<AutomationPreviewDto>('/api/automation/preview', rule)).data,
  });
}

// ── Document history ──────────────────────────────────────────────

export function useDocumentRevisions(id: string | null) {
  return useQuery({
    queryKey: ['document-revisions', id],
    enabled: Boolean(id),
    queryFn: async () =>
      (await api.get<DocumentRevisionDto[]>(`/api/workspaces/documents/${id}/revisions`)).data,
  });
}

export function useDocumentRevision(id: string | null, revisionId: string | null) {
  return useQuery({
    queryKey: ['document-revision', id, revisionId],
    enabled: Boolean(id && revisionId),
    queryFn: async () =>
      (
        await api.get<DocumentRevisionDto>(
          `/api/workspaces/documents/${id}/revisions/${revisionId}`,
        )
      ).data,
  });
}

export function useRestoreRevision() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, revisionId }: DocScope & { id: string; revisionId: string }) =>
      (
        await api.post<DocumentDto>(
          `/api/workspaces/documents/${id}/revisions/${revisionId}/restore`,
        )
      ).data,
    onSuccess: (_d, v) => {
      invalidateWorkspace(qc, v);
      void qc.invalidateQueries({ queryKey: ['document-revisions', v.id] });
    },
  });
}
