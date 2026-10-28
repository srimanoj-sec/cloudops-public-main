import { createHash, createSign } from 'node:crypto';
import type {
  AccountCredentials,
  CloudProvider,
  ConnResult,
  ProviderAction,
  ProviderContext,
  ProviderHealthEvent,
  ProviderMetricSeries,
  ProviderRecommendation,
  ProviderRoleAssignment,
  ProviderSecurityFinding,
  ResourceDetail,
  ResourceRecord,
  Scope,
} from '@cloudops/provider-sdk';
import type { AccountConnResult, ProviderCapability } from '@cloudops/core';

const CLOUD_ASSET_API = 'https://cloudasset.googleapis.com/v1';
const RESOURCE_MANAGER_API = 'https://cloudresourcemanager.googleapis.com/v3';
const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SECURITY_CENTER_API = 'https://securitycenter.googleapis.com/v1';
const MONITORING_API = 'https://monitoring.googleapis.com/v3';
const SERVICE_HEALTH_API = 'https://servicehealth.googleapis.com/v1';
const RECOMMENDER_API = 'https://recommender.googleapis.com/v1';
const COMPUTE_API = 'https://compute.googleapis.com/compute/v1';
const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform.read-only';
const CLOUD_PLATFORM_FULL_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const PAGE_SIZE = 500;
const HEALTH_PAGE_SIZE = 100;
const RECOMMENDERS = [
  'google.compute.instance.MachineTypeRecommender',
  'google.compute.instance.IdleResourceRecommender',
  'google.compute.disk.IdleResourceRecommender',
];

export interface GcpAccount {
  name: string;
  /** The project to inventory. One configured account maps to one GCP project. */
  tenantId: string;
  /** The service account email. */
  clientId: string;
  /** JSON service-account key; it remains in the encrypted local credential store. */
  clientSecret: string;
}

interface ServiceAccountKey {
  type: 'service_account';
  project_id: string;
  private_key_id: string;
  private_key: string;
  client_email: string;
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
}

interface ProjectResponse {
  projectId?: string;
  displayName?: string;
  state?: string;
  name?: string;
}

interface AssetSearchResponse {
  results?: Asset[];
  nextPageToken?: string;
}

interface PagedResponse {
  nextPageToken?: string;
}

interface SecurityFindingsResponse extends PagedResponse {
  listFindingsResults?: {
    finding?: Record<string, unknown>;
    resource?: { name?: string };
  }[];
}

interface MonitoringResponse extends PagedResponse {
  timeSeries?: {
    metric?: { type?: string };
    resource?: { labels?: Record<string, string> };
    points?: {
      interval?: { endTime?: string };
      value?: { doubleValue?: number; int64Value?: string };
    }[];
  }[];
}

interface IamPolicyResponse {
  bindings?: {
    role?: string;
    members?: string[];
    condition?: { expression?: string };
  }[];
}

interface ServiceHealthResponse extends PagedResponse {
  events?: Record<string, unknown>[];
}

interface RecommendationsResponse extends PagedResponse {
  recommendations?: Record<string, unknown>[];
}

interface Asset {
  name?: string;
  assetType?: string;
  displayName?: string;
  location?: string;
  project?: string;
  folders?: string[];
  organization?: string;
  labels?: Record<string, string>;
  tags?: Record<string, string>;
  parentFullResourceName?: string;
  additionalAttributes?: Record<string, unknown>;
  versionedResources?: { version?: string; resource?: Record<string, unknown> }[];
}

interface TokenCacheEntry {
  token: string;
  expiresAt: number;
}

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url');
}

function parseServiceAccountKey(
  account: Pick<GcpAccount, 'tenantId' | 'clientId' | 'clientSecret'>,
): ServiceAccountKey {
  const tenantId = account.tenantId;
  const clientId = account.clientId;
  const clientSecret = account.clientSecret;
  if (!tenantId || !clientId || !clientSecret) {
    throw new Error(
      'Project ID, service account email, and service account JSON key are required.',
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(clientSecret);
  } catch {
    throw new Error('The service account key must be the original JSON key file contents.');
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    (parsed as Partial<ServiceAccountKey>).type !== 'service_account' ||
    typeof (parsed as Partial<ServiceAccountKey>).client_email !== 'string' ||
    typeof (parsed as Partial<ServiceAccountKey>).private_key !== 'string' ||
    typeof (parsed as Partial<ServiceAccountKey>).project_id !== 'string'
  ) {
    throw new Error('The key is not a valid Google Cloud service account JSON file.');
  }
  const key = parsed as ServiceAccountKey;
  if (key.client_email.toLowerCase() !== clientId.trim().toLowerCase()) {
    throw new Error('The service account email does not match the email in the JSON key.');
  }
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(tenantId.trim())) {
    throw new Error(
      'Project ID must be 6–30 lowercase letters, digits, or hyphens; it must start with a letter.',
    );
  }
  return key;
}

function resourceGroupId(projectId: string): string {
  return `projects/${projectId}/resourceGroups/all-resources`;
}

function errorText(body: unknown, status: number): string {
  if (body && typeof body === 'object') {
    const error = (body as { error?: { message?: unknown } }).error;
    if (typeof error?.message === 'string' && error.message.length > 0) {
      return `Google Cloud API returned HTTP ${status}: ${error.message}`;
    }
  }
  return `Google Cloud API returned HTTP ${status}.`;
}

export class GcpProvider implements CloudProvider {
  readonly key = 'gcp';
  readonly displayName = 'Google Cloud';
  readonly capabilities: ProviderCapability[] = [
    'inventory',
    'security',
    'metrics',
    'rbac',
    'health',
    'recommendations',
    'execution',
  ];
  private readonly tokens = new Map<string, TokenCacheEntry>();

  constructor(
    private readonly getAccounts: () => GcpAccount[],
    private readonly request: typeof fetch = fetch,
  ) {}

  private accountForProject(projectId: string): GcpAccount {
    const account = this.getAccounts().find((candidate) => candidate.tenantId === projectId);
    if (!account)
      throw new Error(`No enabled Google Cloud account is configured for project "${projectId}".`);
    return account;
  }

  private async accessToken(
    account: GcpAccount,
    signal?: AbortSignal,
    scope = CLOUD_PLATFORM_SCOPE,
  ): Promise<string> {
    const key = parseServiceAccountKey(account);
    const keyFingerprint = createHash('sha256').update(account.clientSecret).digest('hex');
    const cacheKey = `${account.tenantId}:${key.client_email}:${scope}:${keyFingerprint}`;
    const cached = this.tokens.get(cacheKey);
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

    const now = Math.floor(Date.now() / 1000);
    const unsigned = `${base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: key.private_key_id }))}.${base64url(
      JSON.stringify({
        iss: key.client_email,
        scope,
        aud: OAUTH_TOKEN_URL,
        iat: now,
        exp: now + 3600,
      }),
    )}`;
    const signer = createSign('RSA-SHA256');
    signer.update(unsigned);
    signer.end();
    const assertion = `${unsigned}.${signer.sign(key.private_key).toString('base64url')}`;
    const response = await this.request(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }),
      signal,
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) throw new Error(errorText(body, response.status));
    const token = body as Partial<TokenResponse> | null;
    if (!token || typeof token.access_token !== 'string' || typeof token.expires_in !== 'number') {
      throw new Error('Google OAuth returned an invalid access-token response.');
    }
    this.tokens.set(cacheKey, {
      token: token.access_token,
      expiresAt: Date.now() + token.expires_in * 1000,
    });
    return token.access_token;
  }

  private async getJson<T>(url: string, account: GcpAccount, ctx: ProviderContext): Promise<T> {
    const token = await this.accessToken(account, ctx.signal);
    const response = await this.request(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: ctx.signal,
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) throw new Error(errorText(body, response.status));
    return body as T;
  }

  private async requestJson<T>(
    url: string,
    account: GcpAccount,
    ctx: ProviderContext,
    init: RequestInit = {},
    scope = CLOUD_PLATFORM_SCOPE,
  ): Promise<T> {
    const token = await this.accessToken(account, ctx.signal, scope);
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${token}`);
    headers.set('Accept', 'application/json');
    const response = await this.request(url, {
      ...init,
      headers,
      signal: ctx.signal,
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) throw new Error(errorText(body, response.status));
    return body as T;
  }

  async testConnection(ctx: ProviderContext): Promise<ConnResult> {
    const accounts = this.getAccounts();
    if (accounts.length === 0) {
      return {
        ok: false,
        message: 'Add a Google Cloud project and service account in Providers to test access.',
      };
    }
    const results = await this.testConnections(ctx);
    const failed = results.filter((result) => !result.ok);
    return {
      ok: failed.length === 0,
      message:
        failed.length === 0
          ? `Connected to ${results.length} Google Cloud project${results.length === 1 ? '' : 's'}.`
          : failed.map((result) => `${result.account}: ${result.message}`).join('; '),
    };
  }

  async testConnections(ctx: ProviderContext): Promise<AccountConnResult[]> {
    return Promise.all(
      this.getAccounts().map(async (account) => {
        try {
          const project = await this.getJson<ProjectResponse>(
            `${RESOURCE_MANAGER_API}/projects/${encodeURIComponent(account.tenantId)}`,
            account,
            ctx,
          );
          await this.getJson<AssetSearchResponse>(
            `${CLOUD_ASSET_API}/projects/${encodeURIComponent(account.tenantId)}:searchAllResources?pageSize=1`,
            account,
            ctx,
          );
          return {
            account: account.name,
            ok: true,
            message: `Project ${project.displayName ?? project.projectId ?? account.tenantId} is accessible.`,
          };
        } catch (error) {
          return {
            account: account.name,
            ok: false,
            message: error instanceof Error ? error.message : String(error),
          };
        }
      }),
    );
  }

  async testAccountCredentials(
    account: AccountCredentials,
    ctx: ProviderContext,
  ): Promise<AccountConnResult> {
    try {
      const name = account.name;
      const tenantId = account.tenantId;
      const clientId = account.clientId;
      const clientSecret = account.clientSecret;
      if (!name || !tenantId || !clientId || !clientSecret) {
        throw new Error('Display name, project ID, service account email, and key are required.');
      }
      const key = parseServiceAccountKey({ tenantId, clientId, clientSecret });
      const gcpAccount: GcpAccount = {
        name,
        tenantId: tenantId.trim(),
        clientId: clientId.trim(),
        clientSecret,
      };
      const project = await this.getJson<ProjectResponse>(
        `${RESOURCE_MANAGER_API}/projects/${encodeURIComponent(gcpAccount.tenantId)}`,
        gcpAccount,
        ctx,
      );
      await this.getJson<AssetSearchResponse>(
        `${CLOUD_ASSET_API}/projects/${encodeURIComponent(gcpAccount.tenantId)}:searchAllResources?pageSize=1`,
        gcpAccount,
        ctx,
      );
      return {
        account: name,
        ok: true,
        message: `Connected as ${key.client_email} to ${project.displayName ?? project.projectId ?? gcpAccount.tenantId}.`,
      };
    } catch (error) {
      return {
        account: account.name ?? 'Google Cloud account',
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async *discoverScopes(ctx: ProviderContext): AsyncIterable<Scope> {
    for (const account of this.getAccounts()) {
      const project = await this.getJson<ProjectResponse>(
        `${RESOURCE_MANAGER_API}/projects/${encodeURIComponent(account.tenantId)}`,
        account,
        ctx,
      );
      if (project.state && project.state !== 'ACTIVE') {
        ctx.reportIssue?.({
          account: account.name,
          message: `Project ${account.tenantId} is ${project.state}.`,
        });
        continue;
      }
      yield {
        kind: 'subscription',
        externalId: `projects/${account.tenantId}`,
        name: project.displayName ?? project.projectId ?? account.name,
        state: 'Enabled',
        metadata: { tenantId: account.tenantId, orgName: account.name },
      };
      yield {
        kind: 'resourceGroup',
        externalId: resourceGroupId(account.tenantId),
        name: `${project.displayName ?? account.name} resources`,
        parentExternalId: `projects/${account.tenantId}`,
        location: undefined,
        metadata: { tags: { provider: 'gcp', syntheticGroup: 'project-resources' } },
      };
    }
  }

  async *discoverResources(scope: Scope, ctx: ProviderContext): AsyncIterable<ResourceRecord> {
    const match = /^projects\/([a-z][a-z0-9-]{4,28}[a-z0-9])$/.exec(scope.externalId);
    if (!match) throw new Error(`Unsupported Google Cloud project scope "${scope.externalId}".`);
    const projectId = match[1]!;
    const account = this.accountForProject(projectId);
    let pageToken: string | undefined;
    do {
      const url = new URL(
        `${CLOUD_ASSET_API}/projects/${encodeURIComponent(projectId)}:searchAllResources`,
      );
      url.searchParams.set('pageSize', String(PAGE_SIZE));
      url.searchParams.set(
        'readMask',
        'name,assetType,displayName,location,project,folders,organization,labels,tags,parentFullResourceName,additionalAttributes,versionedResources',
      );
      if (pageToken) url.searchParams.set('pageToken', pageToken);
      const response = await this.getJson<AssetSearchResponse>(url.toString(), account, ctx);
      for (const asset of response.results ?? []) {
        const resource = this.mapAsset(asset, projectId);
        if (resource) yield resource;
      }
      pageToken = response.nextPageToken;
    } while (pageToken);
  }

  async getResourceDetail(externalId: string, ctx: ProviderContext): Promise<ResourceDetail> {
    const projectId = /^\/\/[^/]+\/projects\/([^/]+)\//.exec(externalId)?.[1];
    if (!projectId) throw new Error(`Unsupported Google Cloud resource name "${externalId}".`);
    const account = this.accountForProject(projectId);
    const url = new URL(
      `${CLOUD_ASSET_API}/projects/${encodeURIComponent(projectId)}:searchAllResources`,
    );
    url.searchParams.set('query', `name:${externalId}`);
    url.searchParams.set('pageSize', '10');
    url.searchParams.set(
      'readMask',
      'name,assetType,displayName,location,project,folders,organization,labels,tags,parentFullResourceName,additionalAttributes,versionedResources',
    );
    const response = await this.getJson<AssetSearchResponse>(url.toString(), account, ctx);
    const asset = response.results?.find(
      (result) => result.name?.toLowerCase() === externalId.toLowerCase(),
    );
    if (!asset)
      throw new Error(
        `Google Cloud resource "${externalId}" was not found in project ${projectId}.`,
      );
    const resource = this.mapAsset(asset, projectId);
    if (!resource)
      throw new Error(`Google Cloud returned an incomplete asset for "${externalId}".`);
    return { ...resource, raw: asset };
  }

  async getSecurityFindings(
    projectExternalId: string,
    ctx: ProviderContext,
  ): Promise<ProviderSecurityFinding[]> {
    const projectId = this.projectIdFromScope(projectExternalId);
    const account = this.accountForProject(projectId);
    const out: ProviderSecurityFinding[] = [];
    let pageToken: string | undefined;
    do {
      const url = new URL(
        `${SECURITY_CENTER_API}/projects/${encodeURIComponent(projectId)}/sources/-/findings`,
      );
      url.searchParams.set('pageSize', String(PAGE_SIZE));
      url.searchParams.set('filter', 'state="ACTIVE"');
      if (pageToken) url.searchParams.set('pageToken', pageToken);
      const page = await this.getJson<SecurityFindingsResponse>(url.toString(), account, ctx);
      for (const result of page.listFindingsResults ?? []) {
        const finding = result.finding ?? {};
        out.push({
          id: String(finding.name ?? finding.findingId ?? ''),
          category: String(finding.category ?? 'Uncategorized'),
          severity: String(finding.severity ?? 'UNSPECIFIED'),
          state: String(finding.state ?? 'ACTIVE'),
          description: String(finding.description ?? ''),
          resourceExternalId:
            typeof result.resource?.name === 'string' ? result.resource.name : null,
          detectedAt:
            typeof finding.eventTime === 'string'
              ? finding.eventTime
              : typeof finding.createTime === 'string'
                ? finding.createTime
                : null,
        });
      }
      pageToken = page.nextPageToken;
    } while (pageToken);
    return out;
  }

  async getMetrics(
    projectExternalId: string,
    fromIso: string,
    toIso: string,
    ctx: ProviderContext,
  ): Promise<ProviderMetricSeries[]> {
    const projectId = this.projectIdFromScope(projectExternalId);
    const from = Date.parse(fromIso);
    const to = Date.parse(toIso);
    if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) {
      throw new Error('Metrics query requires a valid start time before the end time.');
    }
    const account = this.accountForProject(projectId);
    const out: ProviderMetricSeries[] = [];
    let pageToken: string | undefined;
    do {
      const url = new URL(`${MONITORING_API}/projects/${encodeURIComponent(projectId)}/timeSeries`);
      url.searchParams.set(
        'filter',
        'metric.type="compute.googleapis.com/instance/cpu/utilization"',
      );
      url.searchParams.set('interval.startTime', new Date(from).toISOString());
      url.searchParams.set('interval.endTime', new Date(to).toISOString());
      url.searchParams.set('aggregation.alignmentPeriod', '300s');
      url.searchParams.set('aggregation.perSeriesAligner', 'ALIGN_MEAN');
      url.searchParams.set('view', 'FULL');
      url.searchParams.set('pageSize', '1000');
      if (pageToken) url.searchParams.set('pageToken', pageToken);
      const page = await this.getJson<MonitoringResponse>(url.toString(), account, ctx);
      for (const series of page.timeSeries ?? []) {
        const labels = series.resource?.labels ?? {};
        const resourceExternalId =
          labels.instance_id && labels.zone
            ? `//compute.googleapis.com/projects/${projectId}/zones/${labels.zone}/instances/${labels.instance_id}`
            : null;
        const points = (series.points ?? [])
          .map((point) => ({
            at: point.interval?.endTime ?? '',
            value:
              point.value?.doubleValue ??
              (point.value?.int64Value ? Number(point.value.int64Value) : Number.NaN),
          }))
          .filter((point) => point.at && Number.isFinite(point.value));
        out.push({
          resourceExternalId,
          metricType: series.metric?.type ?? 'compute.googleapis.com/instance/cpu/utilization',
          points,
        });
      }
      pageToken = page.nextPageToken;
    } while (pageToken);
    return out;
  }

  async getRoleAssignments(
    projectExternalId: string,
    ctx: ProviderContext,
  ): Promise<ProviderRoleAssignment[]> {
    const projectId = this.projectIdFromScope(projectExternalId);
    const account = this.accountForProject(projectId);
    const policy = await this.requestJson<IamPolicyResponse>(
      `${RESOURCE_MANAGER_API}/projects/${encodeURIComponent(projectId)}:getIamPolicy`,
      account,
      ctx,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ options: { requestedPolicyVersion: 3 } }),
      },
    );
    return (policy.bindings ?? []).flatMap((binding) =>
      (binding.members ?? []).map((member) => ({
        role: binding.role ?? 'unknown',
        member,
        scope: projectExternalId,
        ...(binding.condition?.expression ? { condition: binding.condition.expression } : {}),
      })),
    );
  }

  async getHealthEvents(
    projectExternalId: string,
    ctx: ProviderContext,
  ): Promise<ProviderHealthEvent[]> {
    const projectId = this.projectIdFromScope(projectExternalId);
    const account = this.accountForProject(projectId);
    const out: ProviderHealthEvent[] = [];
    let pageToken: string | undefined;
    do {
      const url = new URL(
        `${SERVICE_HEALTH_API}/projects/${encodeURIComponent(projectId)}/locations/global/events`,
      );
      url.searchParams.set('pageSize', String(HEALTH_PAGE_SIZE));
      if (pageToken) url.searchParams.set('pageToken', pageToken);
      const page = await this.getJson<ServiceHealthResponse>(url.toString(), account, ctx);
      for (const event of page.events ?? []) {
        const state = event.state;
        out.push({
          id: String(event.name ?? ''),
          title: String(event.title ?? 'Google Cloud service event'),
          description: String(event.description ?? ''),
          state:
            state && typeof state === 'object' && 'state' in state
              ? String((state as { state: unknown }).state)
              : String(state ?? 'UNKNOWN'),
          category:
            typeof event.detailedCategory === 'string'
              ? event.detailedCategory
              : typeof event.category === 'string'
                ? event.category
                : null,
          relevance: typeof event.relevance === 'string' ? event.relevance : null,
          severity: typeof event.severity === 'string' ? event.severity : null,
          startTime: typeof event.startTime === 'string' ? event.startTime : null,
          endTime: typeof event.endTime === 'string' ? event.endTime : null,
        });
      }
      pageToken = page.nextPageToken;
    } while (pageToken);
    return out;
  }

  async getRecommendations(
    projectExternalId: string,
    ctx: ProviderContext,
  ): Promise<ProviderRecommendation[]> {
    const projectId = this.projectIdFromScope(projectExternalId);
    const account = this.accountForProject(projectId);
    const out: ProviderRecommendation[] = [];
    const locations = new Set(['global']);
    for await (const resource of this.discoverResources(
      { kind: 'subscription', externalId: projectExternalId, name: projectId },
      ctx,
    )) {
      if (!resource.location) continue;
      const region = /^(.+-\d+)-[a-z]$/.exec(resource.location)?.[1] ?? resource.location;
      locations.add(region);
    }

    for (const location of locations) {
      for (const recommender of RECOMMENDERS) {
        let pageToken: string | undefined;
        do {
          const url = new URL(
            `${RECOMMENDER_API}/projects/${encodeURIComponent(projectId)}/locations/${encodeURIComponent(location)}/recommenders/${encodeURIComponent(recommender)}/recommendations`,
          );
          url.searchParams.set('pageSize', String(PAGE_SIZE));
          if (pageToken) url.searchParams.set('pageToken', pageToken);
          let page: RecommendationsResponse;
          try {
            page = await this.requestJson<RecommendationsResponse>(
              url.toString(),
              account,
              ctx,
              {},
              CLOUD_PLATFORM_FULL_SCOPE,
            );
          } catch (error) {
            if (/\b404\b|not found/i.test(error instanceof Error ? error.message : String(error))) {
              ctx.log('debug', 'recommender is not available in this project location', {
                projectId,
                location,
                recommender,
              });
              break;
            }
            throw error;
          }
          for (const recommendation of page.recommendations ?? []) {
            const stateInfo = recommendation.stateInfo;
            const impact = recommendation.primaryImpact;
            const targetResources = recommendation.targetResources;
            const resourceName =
              Array.isArray(targetResources) && typeof targetResources[0] === 'string'
                ? targetResources[0]
                : null;
            out.push({
              id: String(recommendation.name ?? ''),
              recommender,
              description: String(recommendation.description ?? ''),
              state:
                stateInfo && typeof stateInfo === 'object' && 'state' in stateInfo
                  ? String((stateInfo as { state: unknown }).state)
                  : 'UNKNOWN',
              impact:
                impact && typeof impact === 'object' && 'category' in impact
                  ? String((impact as { category: unknown }).category)
                  : null,
              resourceExternalId: typeof resourceName === 'string' ? resourceName : null,
            });
          }
          pageToken = page.nextPageToken;
        } while (pageToken);
      }
    }
    return out;
  }

  previewAction(action: ProviderAction): string {
    if (action.kind !== 'power' || !['start', 'stop'].includes(action.operation)) {
      throw new Error('Google Cloud execution only supports starting and stopping Compute Engine VMs.');
    }
    const target = this.computeInstanceTarget(action.externalId);
    return `POST ${COMPUTE_API}/projects/${target.projectId}/zones/${target.zone}/instances/${target.instance}/${action.operation}`;
  }

  async executeAction(
    action: ProviderAction,
    ctx: ProviderContext,
  ): Promise<{ message?: string }> {
    if (action.kind !== 'power' || !['start', 'stop'].includes(action.operation)) {
      throw new Error('Google Cloud execution only supports starting and stopping Compute Engine VMs.');
    }
    const target = this.computeInstanceTarget(action.externalId);
    const account = this.accountForProject(target.projectId);
    await this.requestJson(
      `${COMPUTE_API}/projects/${encodeURIComponent(target.projectId)}/zones/${encodeURIComponent(target.zone)}/instances/${encodeURIComponent(target.instance)}/${action.operation}`,
      account,
      ctx,
      { method: 'POST' },
      CLOUD_PLATFORM_FULL_SCOPE,
    );
    ctx.log('info', `Compute Engine VM ${action.operation} request accepted`, {
      projectId: target.projectId,
      zone: target.zone,
      instance: target.instance,
    });
    return { message: `VM ${action.operation} request accepted.` };
  }

  private projectIdFromScope(projectExternalId: string): string {
    const match = /^projects\/([a-z][a-z0-9-]{4,28}[a-z0-9])$/.exec(projectExternalId);
    if (!match) throw new Error(`Unsupported Google Cloud project scope "${projectExternalId}".`);
    return match[1]!;
  }

  private computeInstanceTarget(externalId: string): {
    projectId: string;
    zone: string;
    instance: string;
  } {
    const match =
      /^\/\/compute\.googleapis\.com\/projects\/([a-z][a-z0-9-]{4,28}[a-z0-9])\/zones\/([a-z0-9-]+)\/instances\/([a-z][a-z0-9-]{0,61}[a-z0-9])$/i.exec(
        externalId,
      );
    if (!match) throw new Error('Execution is limited to Compute Engine VM instance resources.');
    return { projectId: match[1]!, zone: match[2]!, instance: match[3]! };
  }

  private mapAsset(asset: Asset, projectId: string): ResourceRecord | null {
    if (!asset.name || !asset.assetType) return null;
    const labels = asset.labels ?? asset.tags ?? {};
    const name = asset.displayName || asset.name.split('/').filter(Boolean).at(-1) || asset.name;
    const location =
      asset.location && asset.location !== 'global' && asset.location !== '-'
        ? asset.location
        : undefined;
    const properties: Record<string, unknown> = {
      projectId,
      assetType: asset.assetType,
      labels,
      parentFullResourceName: asset.parentFullResourceName ?? null,
      folders: asset.folders ?? [],
      organization: asset.organization ?? null,
      ...(asset.additionalAttributes ?? {}),
      ...(asset.versionedResources?.[0]?.resource
        ? { resource: asset.versionedResources[0].resource }
        : {}),
    };
    const ownerKey = Object.keys(labels).find((key) => key.toLowerCase() === 'owner');
    return {
      externalId: asset.name,
      name,
      type: asset.assetType,
      ...(location ? { location } : {}),
      tags: labels,
      subscriptionExternalId: `projects/${projectId}`,
      resourceGroupExternalId: resourceGroupId(projectId),
      properties,
      ...(ownerKey && labels[ownerKey] ? { owner: labels[ownerKey] } : {}),
    };
  }
}
