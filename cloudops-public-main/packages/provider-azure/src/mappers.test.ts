import { describe, expect, it } from 'vitest';
import {
  classifyRelationship,
  extractCreatedTime,
  extractRelationships,
  mapGraphResource,
  mapResource,
  ownerFromTags,
  resourceGroupExternalId,
  subscriptionIdFromResourceId,
  topLevelResourceId,
} from './mappers.js';

describe('azure mappers', () => {
  const id =
    '/subscriptions/sub-123/resourceGroups/rg-app/providers/Microsoft.Compute/virtualMachines/vm-1';

  it('extracts subscription id from a resource id', () => {
    expect(subscriptionIdFromResourceId(id)).toBe('sub-123');
  });

  it('builds a normalized resource-group external id', () => {
    expect(resourceGroupExternalId('SUB-123', 'RG-App')).toBe(
      '/subscriptions/sub-123/resourcegroups/rg-app',
    );
  });

  it('maps an az resource to a normalized record with scopes and tags', () => {
    const record = mapResource({
      id,
      name: 'vm-1',
      type: 'Microsoft.Compute/virtualMachines',
      location: 'eastus',
      sku: { name: 'Standard_B2s' },
      tags: { env: 'prod' },
      resourceGroup: 'rg-app',
      identity: { type: 'SystemAssigned' },
    });

    expect(record.externalId).toBe(id);
    expect(record.sku).toBe('Standard_B2s');
    expect(record.tags).toEqual({ env: 'prod' });
    expect(record.subscriptionExternalId).toBe('sub-123');
    expect(record.resourceGroupExternalId).toBe('/subscriptions/sub-123/resourcegroups/rg-app');
    expect(record.properties?.identityType).toBe('SystemAssigned');
  });

  it('reads the owner from tags case-insensitively (via mapResource)', () => {
    const record = mapResource(
      { id, name: 'vm-1', type: 'Microsoft.Compute/virtualMachines', tags: { OWNER: 'platform-team' } },
      'Owner',
    );
    expect(record.owner).toBe('platform-team');
  });
});

describe('owner + created-time extraction', () => {
  it('matches the owner tag regardless of casing and honors a custom tag name', () => {
    expect(ownerFromTags({ owner: 'a' })).toBe('a');
    expect(ownerFromTags({ Owner: 'b' })).toBe('b');
    expect(ownerFromTags({ CostCenter: 'c' }, 'costcenter')).toBe('c');
    expect(ownerFromTags({}, 'Owner')).toBeUndefined();
    expect(ownerFromTags(null)).toBeUndefined();
  });

  it('extracts a creation time from known property paths → ISO', () => {
    expect(extractCreatedTime({ createdTime: '2023-01-02T03:04:05Z' })).toBe('2023-01-02T03:04:05.000Z');
    expect(extractCreatedTime({ timeCreated: '2022-06-01T00:00:00Z' })).toBe('2022-06-01T00:00:00.000Z');
    expect(extractCreatedTime({ nothing: true })).toBeUndefined();
    expect(extractCreatedTime(null)).toBeUndefined();
  });
});

describe('mapGraphResource', () => {
  it('maps a Resource Graph row with owner tag, created time, and full properties', () => {
    const record = mapGraphResource(
      {
        id: '/subscriptions/sub-9/resourceGroups/RG-Data/providers/Microsoft.Storage/storageAccounts/st1',
        name: 'st1',
        type: 'Microsoft.Storage/storageAccounts',
        location: 'westus',
        resourceGroup: 'RG-Data',
        subscriptionId: 'sub-9',
        sku: { name: 'Standard_LRS' },
        tags: { Owner: 'data-team', env: 'prod' },
        identity: { type: 'SystemAssigned' },
        properties: { creationTime: '2021-12-31T23:59:59Z', provisioningState: 'Succeeded' },
      },
      'Owner',
    );

    expect(record.externalId).toContain('storageAccounts/st1');
    expect(record.sku).toBe('Standard_LRS');
    expect(record.owner).toBe('data-team');
    expect(record.azureCreatedAt).toBe('2021-12-31T23:59:59.000Z');
    expect(record.subscriptionExternalId).toBe('sub-9');
    expect(record.resourceGroupExternalId).toBe('/subscriptions/sub-9/resourcegroups/rg-data');
    // Original properties are preserved alongside the normalized extras.
    expect(record.properties?.provisioningState).toBe('Succeeded');
    expect(record.properties?.identityType).toBe('SystemAssigned');
  });

  it('accepts a plain-string sku', () => {
    const record = mapGraphResource({
      id: '/subscriptions/s/resourceGroups/rg/providers/Microsoft.Foo/bar/x',
      name: 'x',
      type: 'Microsoft.Foo/bar',
      sku: 'Basic',
    });
    expect(record.sku).toBe('Basic');
  });
});

describe('relationship (topology) extraction', () => {
  const vnet = '/subscriptions/s/resourceGroups/rg-net/providers/Microsoft.Network/virtualNetworks/vnet1';
  const subnet = `${vnet}/subnets/default`;
  const nsg = '/subscriptions/s/resourceGroups/rg-net/providers/Microsoft.Network/networkSecurityGroups/nsg1';
  const nic = '/subscriptions/s/resourceGroups/rg-app/providers/Microsoft.Network/networkInterfaces/nic1';
  const uami =
    '/subscriptions/s/resourceGroups/rg-id/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id1';

  it('truncates a nested (sub-resource) id to its top-level resource', () => {
    expect(topLevelResourceId(subnet)).toBe(vnet);
    expect(topLevelResourceId(vnet)).toBe(vnet);
  });

  it('classifies edges by the referenced provider namespace', () => {
    expect(classifyRelationship(nsg.toLowerCase())).toBe('network');
    expect(classifyRelationship(uami.toLowerCase())).toBe('identity');
    expect(
      classifyRelationship(
        '/subscriptions/s/resourceGroups/rg/providers/Microsoft.Authorization/roleAssignments/x'.toLowerCase(),
      ),
    ).toBe('rbac');
    expect(
      classifyRelationship(
        '/subscriptions/s/resourceGroups/rg/providers/Microsoft.Compute/disks/d1'.toLowerCase(),
      ),
    ).toBe('depends-on');
  });

  it('extracts deduped, self-excluded edges from properties/identity/managedBy', () => {
    const rels = extractRelationships({
      id: nic,
      properties: {
        // A NIC references its subnet (nested → VNet), NSG, and — via a duplicate
        // reference to the same VNet — should dedupe to a single VNet edge.
        ipConfigurations: [{ properties: { subnet: { id: subnet } } }],
        networkSecurityGroup: { id: nsg },
        alsoVnet: vnet,
        self: nic, // self-reference must be dropped
      },
      identity: { type: 'UserAssigned', userAssignedIdentities: { [uami]: {} } },
    });

    const targets = rels.map((r) => r.targetExternalId).sort();
    expect(targets).toEqual([nsg.toLowerCase(), uami.toLowerCase(), vnet.toLowerCase()].sort());
    // Types are classified per target namespace.
    const byTarget = new Map(rels.map((r) => [r.targetExternalId, r.type]));
    expect(byTarget.get(vnet.toLowerCase())).toBe('network');
    expect(byTarget.get(uami.toLowerCase())).toBe('identity');
  });

  it('mapGraphResource surfaces a managed-by edge as a relationship', () => {
    const record = mapGraphResource({
      id: '/subscriptions/s/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/vm1',
      name: 'vm1',
      type: 'Microsoft.Compute/virtualMachines',
      managedBy: '/subscriptions/s/resourceGroups/rg/providers/Microsoft.Compute/virtualMachineScaleSets/vmss1',
    });
    expect(record.relationships).toEqual([
      {
        type: 'depends-on',
        targetExternalId:
          '/subscriptions/s/resourcegroups/rg/providers/microsoft.compute/virtualmachinescalesets/vmss1',
      },
    ]);
  });

  it('ignores bare subscription / resource-group ids (no /providers/)', () => {
    const rels = extractRelationships({
      id: nic,
      properties: { scope: '/subscriptions/s/resourceGroups/rg-net' },
    });
    expect(rels).toEqual([]);
  });
});
