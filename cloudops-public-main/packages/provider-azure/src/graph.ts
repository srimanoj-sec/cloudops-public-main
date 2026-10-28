import { az, type AzExecOptions } from './az-exec.js';
import type { AzGraphResource } from './mappers.js';

/**
 * Azure Resource Graph — one fast KQL query for a whole scope, replacing slow
 * per-resource ARM calls. Returns tags, sku, identity, managedBy and the full
 * properties bag (which carries creation time for many resource types).
 *
 * Requires the `resource-graph` CLI extension (installed in the api Dockerfile;
 * on the host: `az extension add --name resource-graph`). Callers fall back to
 * `az resource list` when the extension is unavailable.
 */

/** Build the KQL projecting the columns the mappers consume. */
export function buildResourcesQuery(subscriptionId: string): string {
  // `order by id asc` gives stable pagination across skip-token pages.
  return [
    'Resources',
    `| where subscriptionId =~ '${subscriptionId}'`,
    '| project id, name, type, location, resourceGroup, subscriptionId, tags, sku, identity, managedBy, properties',
    '| order by id asc',
  ].join(' ');
}

interface GraphResponse {
  data?: AzGraphResource[];
  // The CLI returns snake_case; tolerate camelCase too.
  skip_token?: string;
  skipToken?: string;
  count?: number;
  total_records?: number;
}

const PAGE_SIZE = 1000; // Resource Graph max page.

/**
 * Run a Resource Graph query for one subscription, following skip-tokens until
 * the whole result set is retrieved.
 */
export async function queryResources(
  subscriptionId: string,
  options: AzExecOptions = {},
): Promise<AzGraphResource[]> {
  const query = buildResourcesQuery(subscriptionId);
  const rows: AzGraphResource[] = [];
  let skipToken: string | undefined;

  do {
    const args = ['graph', 'query', '-q', query, '--first', String(PAGE_SIZE)];
    if (skipToken) args.push('--skip-token', skipToken);
    const res = await az<GraphResponse>(args, options);
    if (res?.data?.length) rows.push(...res.data);
    skipToken = res?.skip_token ?? res?.skipToken;
  } while (skipToken);

  return rows;
}
