import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { az, AzError } from './az-exec.js';
import { normalizeCostResult, queryCost, toCostQueryError } from './cost.js';

describe('normalizeCostResult', () => {
  it('maps columns/rows to daily per-resource cost regardless of column order', () => {
    const records = normalizeCostResult({
      columns: [
        { name: 'PreTaxCost', type: 'Number' },
        { name: 'ResourceId', type: 'String' },
        { name: 'UsageDate', type: 'Number' },
        { name: 'Currency', type: 'String' },
      ],
      rows: [
        [1.2345, '/subscriptions/s/resourceGroups/RG/providers/Microsoft.Compute/virtualMachines/VM1', 20240115, 'USD'],
        [0.5, '/subscriptions/s/resourceGroups/RG/providers/Microsoft.Storage/storageAccounts/ST1', 20240116, 'USD'],
      ],
    });

    expect(records).toHaveLength(2);
    expect(records[0]).toEqual({
      resourceExternalId: '/subscriptions/s/resourcegroups/rg/providers/microsoft.compute/virtualmachines/vm1',
      date: '2024-01-15',
      cost: 1.2345,
      currency: 'USD',
    });
    expect(records[1]?.date).toBe('2024-01-16');
  });

  it('reads cost from properties-wrapped results and leaves a missing currency unknown (never guesses USD)', () => {
    const records = normalizeCostResult({
      properties: {
        columns: [
          { name: 'Cost', type: 'Number' },
          { name: 'UsageDate', type: 'Number' },
          { name: 'ResourceId', type: 'String' },
        ],
        rows: [[10, 20240201, '/subscriptions/s/rg/x']],
      },
    });
    expect(records).toHaveLength(1);
    expect(records[0]?.currency).toBe('');
    expect(records[0]?.cost).toBe(10);
  });

  it('returns [] for empty or unrecognized results', () => {
    expect(normalizeCostResult({})).toEqual([]);
    expect(normalizeCostResult({ columns: [], rows: [] })).toEqual([]);
    // Missing required columns (no ResourceId).
    expect(
      normalizeCostResult({ columns: [{ name: 'Cost', type: 'Number' }], rows: [[5]] }),
    ).toEqual([]);
  });
});

// ── pagination ────────────────────────────────────────────────────
// Keep the real AzError class — cost.ts branches on `instanceof AzError`.
vi.mock('./az-exec.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./az-exec.js')>()),
  az: vi.fn(),
}));

function page(nextLink: string | null, rows: unknown[][]) {
  return {
    properties: {
      columns: [
        { name: 'Cost', type: 'Number' },
        { name: 'UsageDate', type: 'Number' },
        { name: 'ResourceId', type: 'String' },
        { name: 'Currency', type: 'String' },
      ],
      rows,
      nextLink,
    },
  };
}

describe('queryCost pagination', () => {
  beforeEach(() => {
    vi.mocked(az).mockReset();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it('follows nextLink so the most recent days are not truncated', async () => {
    vi.mocked(az)
      .mockResolvedValueOnce(page('https://management.azure.com/next?$skiptoken=abc', [[10, 20260810, '/subscriptions/s/resourceGroups/rg/x', 'INR']]))
      .mockResolvedValueOnce(page(null, [[20, 20260820, '/subscriptions/s/resourceGroups/rg/x', 'INR']]));

    const promise = queryCost('sub-1', '2026-05-22', '2026-08-20');
    await vi.runAllTimersAsync();
    const records = await promise;

    expect(vi.mocked(az)).toHaveBeenCalledTimes(2);
    expect(records.map((r) => r.date)).toEqual(['2026-08-10', '2026-08-20']);
    // The follow-up page must POST the SAME body to the nextLink URL.
    const [, second] = vi.mocked(az).mock.calls;
    expect(second?.[0]).toContain('https://management.azure.com/next?$skiptoken=abc');
    expect(second?.[0]?.at(-2)).toBe(vi.mocked(az).mock.calls[0]?.[0]?.at(-2));
  });

  it('stops when nextLink repeats itself', async () => {
    const self = 'https://management.azure.com/subscriptions/sub-1/providers/Microsoft.CostManagement/query?api-version=2023-11-01';
    vi.mocked(az).mockResolvedValue(page(self, [[1, 20260820, '/subscriptions/s/resourceGroups/rg/x', 'INR']]));

    const records = await queryCost('sub-1', '2026-05-22', '2026-08-20');

    expect(vi.mocked(az)).toHaveBeenCalledTimes(1);
    expect(records).toHaveLength(1);
  });
});

describe('queryCost throttling', () => {
  beforeEach(() => {
    vi.mocked(az).mockReset();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  const throttle = () => new AzError('az failed: Too Many Requests', 'THROTTLED');

  it('retries the same call on 429 instead of falling through to the next metric', async () => {
    vi.mocked(az)
      .mockRejectedValueOnce(throttle())
      .mockResolvedValueOnce(page(null, [[5, 20260820, '/subscriptions/s/resourceGroups/rg/x', 'INR']]));

    const promise = queryCost('sub-1', '2026-05-22', '2026-08-20');
    await vi.runAllTimersAsync();
    const records = await promise;

    expect(records).toHaveLength(1);
    // Both calls used the SAME metric — a 429 must not be read as "wrong metric".
    const bodies = vi.mocked(az).mock.calls.map((c) => c[0]?.at(-2));
    expect(bodies[0]).toBe(bodies[1]);
    expect(bodies[0]).toContain('"name":"Cost"');
  });

  it('gives up with a throttle error once the backoff schedule is exhausted', async () => {
    vi.mocked(az).mockRejectedValue(throttle());

    const promise = queryCost('sub-1', '2026-05-22', '2026-08-20');
    const assertion = expect(promise).rejects.toMatchObject({ code: 'THROTTLED' });
    await vi.runAllTimersAsync();
    await assertion;

    // 1 initial + 3 backoff retries, and NO second-metric attempt.
    expect(vi.mocked(az)).toHaveBeenCalledTimes(4);
  });
});

describe('queryCost network failures', () => {
  beforeEach(() => {
    vi.mocked(az).mockReset();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  const unreachable = () =>
    new AzError(
      "az failed: ERROR: HTTPSConnectionPool(host='management.azure.com', port=443): Max retries exceeded (Caused by NewConnectionError(\"Failed to establish a new connection: [Errno 101] Network is unreachable\"))",
      'CLI_ERROR',
    );

  it('re-sends the request after a network blip', async () => {
    vi.mocked(az)
      .mockRejectedValueOnce(unreachable())
      .mockResolvedValueOnce(page(null, [[5, 20260820, '/subscriptions/s/resourceGroups/rg/x', 'INR']]));

    const promise = queryCost('sub-1', '2026-05-22', '2026-08-20');
    await vi.runAllTimersAsync();
    expect(await promise).toHaveLength(1);
  });

  it('gives up after two quick retries without trying the next metric', async () => {
    vi.mocked(az).mockRejectedValue(unreachable());

    const promise = queryCost('sub-1', '2026-05-22', '2026-08-20');
    const assertion = expect(promise).rejects.toMatchObject({ code: 'CLI_ERROR' });
    await vi.runAllTimersAsync();
    await assertion;
    expect(vi.mocked(az)).toHaveBeenCalledTimes(3);
  });
});

describe('toCostQueryError', () => {
  it('says why a cost query failed, and whether it is worth retrying', () => {
    const network = toCostQueryError(
      new AzError('az failed: ERROR: ... Failed to establish a new connection: [Errno 101] Network is unreachable"))', 'CLI_ERROR'),
    );
    expect(network).toMatchObject({ kind: 'network', message: "Couldn't reach Azure (Network is unreachable)." });

    expect(toCostQueryError(new AzError('Azure CLI command timed out.', 'TIMEOUT')).kind).toBe('network');
    expect(toCostQueryError(new AzError('az failed: Too Many Requests', 'THROTTLED')).kind).toBe('throttled');

    const rbac = toCostQueryError(
      new AzError(
        "az failed: ERROR: (RBACAccessDenied) The client does not have authorization to perform action 'Microsoft.CostManagement/query/action'.",
        'CLI_ERROR',
      ),
    );
    expect(rbac.kind).toBe('no-access');
    expect(rbac.message).toContain('Cost Management Reader');
    expect(rbac.message).toContain('RBACAccessDenied');

    const invisible = toCostQueryError(new AzError('Subscription abc is not visible to any configured organization.', 'FORBIDDEN'));
    expect(invisible.kind).toBe('no-access');

    const offer = toCostQueryError(new AzError('az failed: ERROR: (BadRequest) Offer MS-AZR-0144P is not supported.', 'CLI_ERROR'));
    expect(offer.kind).toBe('unsupported');

    const other = toCostQueryError(new AzError('az failed: ERROR: (InternalServerError) Something broke.', 'CLI_ERROR'));
    expect(other).toMatchObject({ kind: 'error', message: '(InternalServerError) Something broke.' });

    // A command-group guard is a bug, not a permission problem.
    expect(toCostQueryError(new AzError('az command group not allowed: "vm"', 'FORBIDDEN')).kind).toBe('error');
  });
});
