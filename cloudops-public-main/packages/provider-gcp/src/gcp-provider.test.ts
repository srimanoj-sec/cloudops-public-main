import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { ProviderContext } from '@cloudops/provider-sdk';
import { GcpProvider, type GcpAccount } from './gcp-provider.js';

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

function account(overrides: Partial<GcpAccount> = {}): GcpAccount {
  const clientId = 'cloudops-reader@demo-project-1.iam.gserviceaccount.com';
  return {
    name: 'Demo project',
    tenantId: 'demo-project-1',
    clientId,
    clientSecret: JSON.stringify({
      type: 'service_account',
      project_id: 'demo-project-1',
      private_key_id: 'demo-key-id',
      private_key: privateKey,
      client_email: clientId,
    }),
    ...overrides,
  };
}

const context: ProviderContext = {
  credential: { source: 'env', metadata: { providerKey: 'gcp' } },
  log: () => {},
};

function mockFetch(assetResults: Record<string, unknown> = {}) {
  return vi.fn<typeof fetch>(async (input: string | URL | Request, _init?: RequestInit) => {
    const url = String(input);
    if (url === 'https://oauth2.googleapis.com/token') {
      return new Response(
        JSON.stringify({ access_token: 'test-token', expires_in: 3600, token_type: 'Bearer' }),
        {
          status: 200,
        },
      );
    }
    if (url.includes(':getIamPolicy')) {
      return new Response(
        JSON.stringify({
          bindings: [
            {
              role: 'roles/viewer',
              members: ['user:alice@example.com'],
              condition: { expression: 'request.time < timestamp("2027-01-01T00:00:00Z")' },
            },
          ],
        }),
        { status: 200 },
      );
    }
    if (url.includes('cloudresourcemanager.googleapis.com/v3/projects/')) {
      return new Response(
        JSON.stringify({
          projectId: 'demo-project-1',
          displayName: 'Demo Project',
          state: 'ACTIVE',
        }),
        {
          status: 200,
        },
      );
    }
    if (url.includes('cloudasset.googleapis.com')) {
      const query = new URL(url).searchParams.get('query');
      const body = query
        ? { results: [assetResults.detail].filter(Boolean) }
        : (assetResults.page ?? { results: [] });
      return new Response(JSON.stringify(body), { status: 200 });
    }
    if (url.includes('/sources/-/findings')) {
      return new Response(
        JSON.stringify({
          listFindingsResults: [
            {
              finding: {
                name: 'projects/demo-project-1/sources/scc/findings/f-1',
                category: 'PUBLIC_BUCKET',
                severity: 'HIGH',
                state: 'ACTIVE',
                description: 'A bucket is public.',
                eventTime: '2026-01-01T00:00:00Z',
              },
              resource: { name: '//storage.googleapis.com/demo-bucket' },
            },
          ],
        }),
        { status: 200 },
      );
    }
    if (url.includes('/timeSeries?')) {
      return new Response(
        JSON.stringify({
          timeSeries: [
            {
              metric: { type: 'compute.googleapis.com/instance/cpu/utilization' },
              resource: { labels: { instance_id: '12345', zone: 'us-central1-a' } },
              points: [
                {
                  interval: { endTime: '2026-01-01T01:00:00Z' },
                  value: { doubleValue: 0.42 },
                },
              ],
            },
          ],
        }),
        { status: 200 },
      );
    }
    if (url.includes('servicehealth.googleapis.com')) {
      return new Response(
        JSON.stringify({
          events: [
            {
              name: 'projects/demo-project-1/locations/global/events/event-1',
              title: 'Regional service event',
              description: 'A service event.',
              state: { state: 'ACTIVE' },
              severity: 'HIGH',
              startTime: '2026-01-01T00:00:00Z',
            },
          ],
        }),
        { status: 200 },
      );
    }
    if (url.includes('recommender.googleapis.com')) {
      return new Response(
        JSON.stringify({
          recommendations: [
            {
              name: `${new URL(url).pathname}/recommendations/r-1`,
              description: 'Resize an instance.',
              stateInfo: { state: 'ACTIVE' },
              primaryImpact: { category: 'COST' },
              targetResources: [
                '//compute.googleapis.com/projects/demo-project-1/zones/us-central1-a/instances/demo-vm',
              ],
            },
          ],
        }),
        { status: 200 },
      );
    }
    if (url.includes('compute.googleapis.com/compute/v1') && _init?.method === 'POST') {
      return new Response(JSON.stringify({ name: 'operation-1' }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: { message: `Unexpected URL ${url}` } }), {
      status: 404,
    });
  });
}

describe('GcpProvider', () => {
  it('advertises implemented GCP capabilities', () => {
    expect(new GcpProvider(() => []).capabilities).toEqual([
      'inventory',
      'security',
      'metrics',
      'rbac',
      'health',
      'recommendations',
      'execution',
    ]);
  });

  it('tests service-account credentials against the project and Cloud Asset API', async () => {
    const request = mockFetch();
    const provider = new GcpProvider(() => [], request);
    const result = await provider.testAccountCredentials(
      {
        name: 'Demo project',
        tenantId: 'demo-project-1',
        clientId: account().clientId,
        clientSecret: account().clientSecret,
      },
      context,
    );

    expect(result).toMatchObject({ ok: true, account: 'Demo project' });
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('rejects malformed service-account keys without making network requests', async () => {
    const request = mockFetch();
    const provider = new GcpProvider(() => [], request);
    const result = await provider.testAccountCredentials(
      {
        name: 'Bad project',
        tenantId: 'demo-project-1',
        clientId: account().clientId,
        clientSecret: '{}',
      },
      context,
    );

    expect(result.ok).toBe(false);
    expect(result.message).toContain('not a valid Google Cloud service account JSON');
    expect(request).not.toHaveBeenCalled();
  });

  it('discovers the project scope and maps Cloud Asset resources into the shared inventory model', async () => {
    const asset = {
      name: '//compute.googleapis.com/projects/demo-project-1/zones/us-central1-a/instances/demo-vm',
      assetType: 'compute.googleapis.com/Instance',
      displayName: 'demo-vm',
      location: 'us-central1-a',
      labels: { owner: 'cloud-team', environment: 'demo' },
      additionalAttributes: { machineType: 'e2-medium' },
    };
    const request = mockFetch({ page: { results: [asset] } });
    const provider = new GcpProvider(() => [account()], request);
    const scopes = [];
    for await (const scope of provider.discoverScopes(context)) scopes.push(scope);

    expect(scopes.map((scope) => scope.kind)).toEqual(['subscription', 'resourceGroup']);
    expect(scopes[0]).toMatchObject({
      externalId: 'projects/demo-project-1',
      metadata: { tenantId: 'demo-project-1', orgName: 'Demo project' },
    });

    const resources = [];
    for await (const resource of provider.discoverResources(scopes[0]!, context))
      resources.push(resource);
    expect(resources).toHaveLength(1);
    expect(resources[0]).toMatchObject({
      externalId: asset.name,
      name: 'demo-vm',
      type: 'compute.googleapis.com/Instance',
      owner: 'cloud-team',
      subscriptionExternalId: 'projects/demo-project-1',
      resourceGroupExternalId: 'projects/demo-project-1/resourceGroups/all-resources',
      properties: { machineType: 'e2-medium', projectId: 'demo-project-1' },
    });
  });

  it('loads resource details by Cloud Asset full resource name', async () => {
    const asset = {
      name: '//compute.googleapis.com/projects/demo-project-1/zones/us-central1-a/instances/demo-vm',
      assetType: 'compute.googleapis.com/Instance',
      displayName: 'demo-vm',
      location: 'us-central1-a',
    };
    const request = mockFetch({ detail: asset });
    const provider = new GcpProvider(() => [account()], request);
    const detail = await provider.getResourceDetail(asset.name, context);
    expect(detail.name).toBe('demo-vm');
    expect(detail.raw).toEqual(asset);
  });

  it('normalizes security findings, metrics, IAM, health events, and recommendations', async () => {
    const provider = new GcpProvider(() => [account()], mockFetch());
    const project = 'projects/demo-project-1';
    const [findings, metrics, roles, health, recommendations] = await Promise.all([
      provider.getSecurityFindings(project, context),
      provider.getMetrics(project, '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z', context),
      provider.getRoleAssignments(project, context),
      provider.getHealthEvents(project, context),
      provider.getRecommendations(project, context),
    ]);

    expect(findings[0]).toMatchObject({
      category: 'PUBLIC_BUCKET',
      severity: 'HIGH',
      resourceExternalId: '//storage.googleapis.com/demo-bucket',
    });
    expect(metrics[0]?.points[0]).toEqual({ at: '2026-01-01T01:00:00Z', value: 0.42 });
    expect(roles[0]).toMatchObject({ role: 'roles/viewer', member: 'user:alice@example.com' });
    expect(health[0]).toMatchObject({ title: 'Regional service event', state: 'ACTIVE' });
    expect(recommendations.length).toBe(3);
    expect(recommendations[0]).toMatchObject({ state: 'ACTIVE', impact: 'COST' });
  });

  it('executes only Compute Engine VM start/stop actions with write-scoped credentials', async () => {
    const request = mockFetch();
    const provider = new GcpProvider(() => [account()], request);
    const action = {
      kind: 'power' as const,
      operation: 'start' as const,
      externalId:
        '//compute.googleapis.com/projects/demo-project-1/zones/us-central1-a/instances/demo-vm',
    };
    expect(provider.previewAction(action)).toContain('/instances/demo-vm/start');
    await expect(provider.executeAction(action, context)).resolves.toEqual({
      message: 'VM start request accepted.',
    });
    const tokenCalls = request.mock.calls.filter(([url]) => String(url) === 'https://oauth2.googleapis.com/token');
    expect(tokenCalls).toHaveLength(1);
    const actionRequest = request.mock.calls.find(([url]) => String(url).includes('/instances/demo-vm/start'));
    expect(actionRequest?.[1]?.method).toBe('POST');
    await expect(
      provider.executeAction(
        { ...action, externalId: '//compute.googleapis.com/projects/other-project/zones/us-central1-a/instances/demo-vm' },
        context,
      ),
    ).rejects.toThrow('No enabled Google Cloud account is configured');
  });

  it('rejects invalid metric intervals and non-VM execution targets', async () => {
    const provider = new GcpProvider(() => [account()], mockFetch());
    await expect(provider.getMetrics('projects/demo-project-1', 'bad', 'also-bad', context)).rejects.toThrow(
      'valid start time before the end time',
    );
    expect(() =>
      provider.previewAction({
        kind: 'power',
        operation: 'stop',
        externalId: '//storage.googleapis.com/demo-bucket',
      }),
    ).toThrow('limited to Compute Engine VM');
  });
});
