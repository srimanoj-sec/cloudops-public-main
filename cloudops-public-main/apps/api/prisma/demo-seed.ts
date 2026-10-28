import '../src/infra/load-env.js';
import { PrismaClient } from '@prisma/client';
import { prisma as appPrisma } from '../src/infra/prisma.js';
import { StandardsRepository } from '../src/modules/standards/standards.repository.js';
import { StandardsService } from '../src/modules/standards/standards.service.js';

const prisma = new PrismaClient();
const DEMO_TENANTS = [
  { externalId: '00000000-0000-4000-8000-000000000001', name: 'Fabrikam Demo (synthetic data)' },
  {
    externalId: '00000000-0000-4000-8000-000000000002',
    name: 'Northwind Analytics (synthetic data)',
  },
] as const;
const DEMO_SUBSCRIPTIONS = [
  {
    externalId: '00000000-0000-4000-8000-000000000011',
    name: 'Demo Production Subscription',
    tenant: 0,
  },
  {
    externalId: '00000000-0000-4000-8000-000000000012',
    name: 'Demo Engineering Subscription',
    tenant: 0,
  },
  {
    externalId: '00000000-0000-4000-8000-000000000013',
    name: 'Northwind Data Platform Subscription',
    tenant: 1,
  },
] as const;

const DEMO_GROUPS = [
  { name: 'demo-production', subscription: 0, location: 'eastus', environment: 'Production' },
  { name: 'demo-engineering', subscription: 1, location: 'westus2', environment: 'Dev' },
  { name: 'demo-analytics', subscription: 2, location: 'centralus', environment: 'Production' },
] as const;

const DEMO_RESOURCES = [
  {
    name: 'demo-api-vm-01',
    type: 'Microsoft.Compute/virtualMachines',
    location: 'eastus',
    sku: 'Standard_D2s_v5',
    daily: 18.4,
    owner: 'Alex Morgan',
    subscription: 0,
    group: 'demo-production',
    inUse: true,
    tags: { Environment: 'Production', Owner: 'Alex Morgan', CostCenter: 'CC-100' },
  },
  {
    name: 'demo-api-vm-02',
    type: 'Microsoft.Compute/virtualMachines',
    location: 'eastus',
    sku: 'Standard_D2s_v5',
    daily: 18.4,
    owner: 'Alex Morgan',
    subscription: 0,
    group: 'demo-production',
    inUse: true,
    tags: { Environment: 'Production', Owner: 'Alex Morgan', CostCenter: 'CC-100' },
  },
  {
    name: 'demo-storage-prod',
    type: 'Microsoft.Storage/storageAccounts',
    location: 'eastus',
    sku: 'Standard_GRS',
    daily: 7.2,
    owner: null,
    subscription: 0,
    group: 'demo-production',
    inUse: true,
    tags: { Environment: 'Production' },
  },
  {
    name: 'demo-sql-prod',
    type: 'Microsoft.Sql/servers/databases',
    location: 'eastus',
    sku: 'GP_Gen5_2',
    daily: 31.5,
    owner: 'Priya Shah',
    subscription: 0,
    group: 'demo-production',
    inUse: true,
    tags: { Environment: 'Production', Owner: 'Priya Shah' },
  },
  {
    name: 'demo-web-prod',
    type: 'Microsoft.Web/sites',
    location: 'eastus',
    sku: 'P1v3',
    daily: 14.8,
    owner: 'Jordan Lee',
    subscription: 0,
    group: 'demo-production',
    inUse: true,
    tags: { Environment: 'Production', Owner: 'Jordan Lee' },
  },
  {
    name: 'demo-web-plan',
    type: 'Microsoft.Web/serverfarms',
    location: 'eastus',
    sku: 'P1v3',
    daily: 14.8,
    owner: 'Jordan Lee',
    subscription: 0,
    group: 'demo-production',
    inUse: true,
    tags: { Environment: 'Production', Owner: 'Jordan Lee' },
  },
  {
    name: 'demo-vnet-prod',
    type: 'Microsoft.Network/virtualNetworks',
    location: 'eastus',
    sku: null,
    daily: 0,
    owner: 'Alex Morgan',
    subscription: 0,
    group: 'demo-production',
    inUse: true,
    tags: { Environment: 'Production', Owner: 'Alex Morgan' },
  },
  {
    name: 'demo-vm-dev-01',
    type: 'Microsoft.Compute/virtualMachines',
    location: 'westus2',
    sku: 'Standard_B2s',
    daily: 5.1,
    owner: 'Sam Taylor',
    subscription: 1,
    group: 'demo-engineering',
    inUse: true,
    tags: { Environment: 'Dev', Owner: 'Sam Taylor', CostCenter: 'CC-220' },
  },
  {
    name: 'demo-vm-idle-01',
    type: 'Microsoft.Compute/virtualMachines',
    location: 'westus2',
    sku: 'Standard_D4s_v5',
    daily: 36.8,
    owner: 'Sam Taylor',
    subscription: 1,
    group: 'demo-engineering',
    inUse: false,
    tags: { Environment: 'Dev', Owner: 'Sam Taylor' },
  },
  {
    name: 'demo-keyvault-dev',
    type: 'Microsoft.KeyVault/vaults',
    location: 'westus2',
    sku: 'standard',
    daily: 0.4,
    owner: 'Priya Shah',
    subscription: 1,
    group: 'demo-engineering',
    inUse: true,
    tags: { Environment: 'Dev', Owner: 'Priya Shah' },
  },
  {
    name: 'demo-appinsights-dev',
    type: 'Microsoft.Insights/components',
    location: 'westus2',
    sku: null,
    daily: 2.3,
    owner: 'Jordan Lee',
    subscription: 1,
    group: 'demo-engineering',
    inUse: true,
    tags: { Environment: 'Dev', Owner: 'Jordan Lee' },
  },
  {
    name: 'demo-public-ip-dev',
    type: 'Microsoft.Network/publicIPAddresses',
    location: 'westus2',
    sku: 'Standard',
    daily: 1.2,
    owner: null,
    subscription: 1,
    group: 'demo-engineering',
    inUse: false,
    tags: { Environment: 'Dev' },
  },
  {
    name: 'demo-aks-analytics',
    type: 'Microsoft.ContainerService/managedClusters',
    location: 'centralus',
    sku: 'Standard',
    daily: 28.6,
    owner: 'Morgan Chen',
    subscription: 2,
    group: 'demo-analytics',
    inUse: true,
    tags: { Environment: 'Production', Owner: 'Morgan Chen', CostCenter: 'CC-310' },
  },
  {
    name: 'demo-acr-analytics',
    type: 'Microsoft.ContainerRegistry/registries',
    location: 'centralus',
    sku: 'Premium',
    daily: 4.7,
    owner: 'Morgan Chen',
    subscription: 2,
    group: 'demo-analytics',
    inUse: true,
    tags: { Environment: 'Production', Owner: 'Morgan Chen', CostCenter: 'CC-310' },
  },
  {
    name: 'demo-redis-analytics',
    type: 'Microsoft.Cache/Redis',
    location: 'centralus',
    sku: 'Standard_C2',
    daily: 19.2,
    owner: 'Riley Park',
    subscription: 2,
    group: 'demo-analytics',
    inUse: true,
    tags: { Environment: 'Production', Owner: 'Riley Park' },
  },
  {
    name: 'demo-log-analytics',
    type: 'Microsoft.OperationalInsights/workspaces',
    location: 'centralus',
    sku: 'PerGB2018',
    daily: 11.3,
    owner: 'Riley Park',
    subscription: 2,
    group: 'demo-analytics',
    inUse: true,
    tags: { Environment: 'Production', Owner: 'Riley Park' },
  },
  {
    name: 'demo-data-lake',
    type: 'Microsoft.Storage/storageAccounts',
    location: 'centralus',
    sku: 'Standard_LRS',
    daily: 12.5,
    owner: 'Morgan Chen',
    subscription: 2,
    group: 'demo-analytics',
    inUse: true,
    tags: { Environment: 'Production', Owner: 'Morgan Chen' },
  },
  {
    name: 'demo-function-etl',
    type: 'Microsoft.Web/sites',
    location: 'centralus',
    sku: 'EP1',
    daily: 8.6,
    owner: 'Riley Park',
    subscription: 2,
    group: 'demo-analytics',
    inUse: true,
    tags: { Environment: 'Production', Owner: 'Riley Park' },
  },
  {
    name: 'demo-function-plan',
    type: 'Microsoft.Web/serverfarms',
    location: 'centralus',
    sku: 'EP1',
    daily: 8.6,
    owner: 'Riley Park',
    subscription: 2,
    group: 'demo-analytics',
    inUse: true,
    tags: { Environment: 'Production', Owner: 'Riley Park' },
  },
  {
    name: 'demo-nsg-analytics',
    type: 'Microsoft.Network/networkSecurityGroups',
    location: 'centralus',
    sku: null,
    daily: 0,
    owner: 'Morgan Chen',
    subscription: 2,
    group: 'demo-analytics',
    inUse: true,
    tags: { Environment: 'Production', Owner: 'Morgan Chen' },
  },
] as const;

async function main() {
  await prisma.provider.upsert({
    where: { key: 'azure' },
    update: {},
    create: {
      key: 'azure',
      displayName: 'Microsoft Azure',
      capabilities: ['inventory'],
      status: 'registered',
    },
  });

  const tenants: { id: string; externalId: string; name: string }[] = [];
  for (const demoTenant of DEMO_TENANTS) {
    tenants.push(
      await prisma.tenant.upsert({
        where: { externalId: demoTenant.externalId },
        update: { name: demoTenant.name },
        create: { externalId: demoTenant.externalId, name: demoTenant.name },
      }),
    );
  }

  const subscriptions: { id: string; externalId: string; name: string }[] = [];
  for (const demoSubscription of DEMO_SUBSCRIPTIONS) {
    subscriptions.push(
      await prisma.subscription.upsert({
        where: { externalId: demoSubscription.externalId },
        update: {
          name: demoSubscription.name,
          tenantId: tenants[demoSubscription.tenant]!.id,
          state: 'Enabled',
        },
        create: {
          externalId: demoSubscription.externalId,
          name: demoSubscription.name,
          tenantId: tenants[demoSubscription.tenant]!.id,
          state: 'Enabled',
        },
      }),
    );
  }

  const groupIds = new Map<string, string>();
  for (const groupInfo of DEMO_GROUPS) {
    const subscription = subscriptions[groupInfo.subscription]!;
    const { name, location, environment } = groupInfo;
    const externalId = `/subscriptions/${subscription.externalId}/resourcegroups/${name}`;
    const group = await prisma.resourceGroup.upsert({
      where: { externalId },
      update: {
        name,
        location,
        subscriptionId: subscription.id,
      },
      create: {
        externalId,
        name,
        location,
        subscriptionId: subscription.id,
        tags: { Environment: environment, Demo: 'true' },
      },
    });
    groupIds.set(name, group.id);
  }

  const resources = [];
  for (const item of DEMO_RESOURCES) {
    const subscription = subscriptions[item.subscription]!;
    const resourceGroupId = groupIds.get(item.group)!;
    const externalId =
      `/subscriptions/${subscription.externalId}/resourceGroups/${item.group}/providers/${item.type}/${item.name}`.toLowerCase();
    resources.push(
      await prisma.resource.upsert({
        where: { externalId },
        update: {
          name: item.name,
          type: item.type,
          location: item.location,
          sku: item.sku,
          tags: { ...item.tags, Demo: 'true' },
          owner: item.owner,
          inUse: item.inUse,
          costDaily: item.daily,
          costMonthly: Math.round(item.daily * 30 * 100) / 100,
          subscriptionId: subscription.id,
          resourceGroupId,
          lastSyncedAt: new Date(),
        },
        create: {
          externalId,
          name: item.name,
          type: item.type,
          location: item.location,
          sku: item.sku,
          tags: { ...item.tags, Demo: 'true' },
          owner: item.owner,
          inUse: item.inUse,
          costDaily: item.daily,
          costMonthly: Math.round(item.daily * 30 * 100) / 100,
          subscriptionId: subscription.id,
          resourceGroupId,
          properties: {
            demo: true,
            provisioningState: 'Succeeded',
            ...(item.type === 'Microsoft.Web/sites'
              ? {
                  serverFarmId: `/subscriptions/${subscription.externalId}/resourceGroups/${item.group}/providers/Microsoft.Web/serverfarms/${item.name === 'demo-web-prod' ? 'demo-web-plan' : 'demo-function-plan'}`,
                }
              : {}),
          },
          lastSyncedAt: new Date(),
        },
      }),
    );
  }

  const demoResources = new Map(resources.map((resource) => [resource.name, resource]));
  const webApp = demoResources.get('demo-web-prod')!;
  const appPlan = demoResources.get('demo-web-plan')!;
  await prisma.resourceRelationship.upsert({
    where: {
      sourceId_targetId_type: { sourceId: webApp.id, targetId: appPlan.id, type: 'depends-on' },
    },
    update: {},
    create: { sourceId: webApp.id, targetId: appPlan.id, type: 'depends-on' },
  });
  const analyticsAks = demoResources.get('demo-aks-analytics')!;
  const analyticsRedis = demoResources.get('demo-redis-analytics')!;
  await prisma.resourceRelationship.upsert({
    where: {
      sourceId_targetId_type: {
        sourceId: analyticsAks.id,
        targetId: analyticsRedis.id,
        type: 'depends-on',
      },
    },
    update: {},
    create: { sourceId: analyticsAks.id, targetId: analyticsRedis.id, type: 'depends-on' },
  });
  await prisma.resourceRelationship.upsert({
    where: {
      sourceId_targetId_type: {
        sourceId: demoResources.get('demo-function-etl')!.id,
        targetId: demoResources.get('demo-function-plan')!.id,
        type: 'depends-on',
      },
    },
    update: {},
    create: {
      sourceId: demoResources.get('demo-function-etl')!.id,
      targetId: demoResources.get('demo-function-plan')!.id,
      type: 'depends-on',
    },
  });

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const costRows = [];
  for (const [index, item] of DEMO_RESOURCES.entries()) {
    if (item.daily <= 0) continue;
    const resource = resources[index]!;
    for (let dayOffset = 30; dayOffset >= 0; dayOffset--) {
      const date = new Date(today);
      date.setUTCDate(today.getUTCDate() - dayOffset);
      const isStorageSpike = item.name === 'demo-storage-prod' && dayOffset === 0;
      costRows.push({
        providerKey: 'azure',
        resourceExternalId: resource.externalId,
        subscriptionExternalId: DEMO_SUBSCRIPTIONS[item.subscription]!.externalId,
        resourceGroupExternalId: resourceGroupExternalId(
          item.group,
          subscriptions[item.subscription]!.externalId,
        ),
        resourceId: resource.id,
        date,
        cost: Math.round(item.daily * (isStorageSpike ? 4.5 : 1) * 100) / 100,
        currency: 'INR',
      });
    }
  }
  await prisma.costRecord.createMany({ data: costRows, skipDuplicates: true });

  for (const environment of [
    { name: 'Production', type: 'Production' as const },
    { name: 'Stage', type: 'Stage' as const },
    { name: 'QA', type: 'QA' as const },
    { name: 'Dev', type: 'Dev' as const },
    { name: 'Sandbox', type: 'Sandbox' as const },
  ]) {
    await prisma.environment.upsert({
      where: { name: environment.name },
      update: { type: environment.type },
      create: environment,
    });
  }

  const services = [];
  for (const serviceInfo of [
    {
      name: 'Customer API',
      description: 'Fictional production API and its supporting data tier.',
      owner: 'Alex Morgan',
    },
    {
      name: 'Analytics Pipeline',
      description: 'Fictional data ingestion and reporting platform.',
      owner: 'Morgan Chen',
    },
    {
      name: 'Engineering Sandbox',
      description: 'Fictional development and test resources.',
      owner: 'Sam Taylor',
    },
  ]) {
    services.push(
      await prisma.businessService.upsert({
        where: { name: serviceInfo.name },
        update: serviceInfo,
        create: serviceInfo,
      }),
    );
  }

  const [productionEnvironment, devEnvironment] = await Promise.all([
    prisma.environment.findUniqueOrThrow({ where: { name: 'Production' } }),
    prisma.environment.findUniqueOrThrow({ where: { name: 'Dev' } }),
  ]);
  const environmentIds = new Map([
    ['Production', productionEnvironment.id],
    ['Dev', devEnvironment.id],
  ]);
  const serviceIds = new Map(services.map((service) => [service.name, service.id]));
  const demoAssignments = [
    ...[
      'demo-api-vm-01',
      'demo-api-vm-02',
      'demo-storage-prod',
      'demo-sql-prod',
      'demo-web-prod',
      'demo-web-plan',
    ].map((name) => ({ name, service: 'Customer API', environment: 'Production' })),
    ...[
      'demo-aks-analytics',
      'demo-acr-analytics',
      'demo-redis-analytics',
      'demo-log-analytics',
      'demo-data-lake',
      'demo-function-etl',
      'demo-function-plan',
      'demo-nsg-analytics',
    ].map((name) => ({ name, service: 'Analytics Pipeline', environment: 'Production' })),
    ...[
      'demo-vm-dev-01',
      'demo-vm-idle-01',
      'demo-keyvault-dev',
      'demo-appinsights-dev',
      'demo-public-ip-dev',
    ].map((name) => ({ name, service: 'Engineering Sandbox', environment: 'Dev' })),
  ];
  for (const assignment of demoAssignments) {
    const resource = demoResources.get(assignment.name)!;
    const serviceId = serviceIds.get(assignment.service)!;
    const environmentId = environmentIds.get(assignment.environment)!;
    await prisma.resourceServiceMap.upsert({
      where: { resourceId_serviceId: { resourceId: resource.id, serviceId } },
      update: {},
      create: { resourceId: resource.id, serviceId },
    });
    await prisma.resourceEnvironmentMap.upsert({
      where: { resourceId_environmentId: { resourceId: resource.id, environmentId } },
      update: {},
      create: { resourceId: resource.id, environmentId },
    });
  }

  for (const budget of [
    {
      name: '[DEMO] Cloud estate monthly budget',
      scopeType: 'all',
      scopeId: null,
      amount: 4300,
      alertPercent: 80,
    },
    {
      name: '[DEMO] Analytics subscription budget',
      scopeType: 'subscription',
      scopeId: subscriptions[2]!.id,
      amount: 2600,
      alertPercent: 75,
    },
  ]) {
    const existing = await prisma.budget.findFirst({ where: { name: budget.name } });
    if (existing) {
      await prisma.budget.update({ where: { id: existing.id }, data: budget });
    } else {
      await prisma.budget.create({ data: budget });
    }
  }

  const board = await prisma.board.findFirst({
    where: { name: 'Operations' },
    include: { columns: true },
  });
  const workColumn = board?.columns.find((column) => column.name === 'To Do') ?? null;
  const inProgressColumn = board?.columns.find((column) => column.name === 'In Progress') ?? null;
  const now = new Date();
  const workItems = [
    {
      id: 'demo-work-review-idle-vm',
      title: '[DEMO] Review idle development VM spend',
      description:
        'Synthetic demo task: confirm whether demo-vm-idle-01 can be stopped or resized.',
      type: 'cost',
      state: 'todo' as const,
      priority: 1,
      dueDate: new Date(now.getTime() - 2 * 86_400_000),
      assignee: 'Sam Taylor',
      columnId: workColumn?.id,
      sourceLabel: 'Fabrikam Demo (synthetic data)',
    },
    {
      id: 'demo-work-owner-tags',
      title: '[DEMO] Add owner tags to unassigned resources',
      description:
        'Synthetic demo task: identify owners for the demo storage account and public IP.',
      type: 'security',
      state: 'in_progress' as const,
      priority: 2,
      dueDate: new Date(now.getTime() + 3 * 86_400_000),
      assignee: 'Priya Shah',
      columnId: inProgressColumn?.id,
      sourceLabel: 'Fabrikam Demo (synthetic data)',
    },
  ];
  for (const item of workItems) {
    await prisma.workItem.upsert({
      where: { id: item.id },
      update: item,
      create: item,
    });
  }

  const automationRule = await prisma.automationRule.upsert({
    where: { id: 'demo-automation-compliance' },
    update: {
      name: '[DEMO] Route critical compliance findings',
      description:
        'Synthetic example: notify the security team and create a high-priority task for high-severity findings.',
      enabled: true,
      trigger: 'compliance.new-failures',
      conditions: { minSeverity: 'high' },
      actions: [
        { type: 'notify', audience: 'security', severity: 'high' },
        { type: 'create-work-item', workType: 'security', priority: 1 },
      ],
      lastRunAt: now,
      runCount: 1,
    },
    create: {
      id: 'demo-automation-compliance',
      name: '[DEMO] Route critical compliance findings',
      description:
        'Synthetic example: notify the security team and create a high-priority task for high-severity findings.',
      enabled: true,
      trigger: 'compliance.new-failures',
      conditions: { minSeverity: 'high' },
      actions: [
        { type: 'notify', audience: 'security', severity: 'high' },
        { type: 'create-work-item', workType: 'security', priority: 1 },
      ],
      lastRunAt: now,
      runCount: 1,
    },
  });
  await prisma.automationRun.upsert({
    where: { id: 'demo-automation-run' },
    update: {
      ruleId: automationRule.id,
      trigger: automationRule.trigger,
      status: 'succeeded',
      detail: { demo: true, matched: 3, createdWorkItems: 1, sentNotifications: 1 },
      createdAt: now,
    },
    create: {
      id: 'demo-automation-run',
      ruleId: automationRule.id,
      trigger: automationRule.trigger,
      status: 'succeeded',
      detail: { demo: true, matched: 3, createdWorkItems: 1, sentNotifications: 1 },
      createdAt: now,
    },
  });

  await prisma.notification.upsert({
    where: { dedupeKey: 'demo-cost-spike-storage' },
    update: {
      category: 'cost',
      severity: 'high',
      title: '[DEMO] Storage cost spike detected',
      body: 'Synthetic alert: demo-storage-prod is above its expected daily spend. Review the cost anomaly before taking action.',
      link: '/finops',
      entityType: 'resource',
      entityId: demoResources.get('demo-storage-prod')!.id,
      createdAt: now,
    },
    create: {
      category: 'cost',
      severity: 'high',
      title: '[DEMO] Storage cost spike detected',
      body: 'Synthetic alert: demo-storage-prod is above its expected daily spend. Review the cost anomaly before taking action.',
      link: '/finops',
      entityType: 'resource',
      entityId: demoResources.get('demo-storage-prod')!.id,
      dedupeKey: 'demo-cost-spike-storage',
      createdAt: now,
    },
  });

  const workspace = await prisma.workspace.upsert({
    where: { scopeType_scopeId: { scopeType: 'organization', scopeId: tenants[0]!.id } },
    update: { title: 'Fabrikam Demo Runbooks' },
    create: {
      scopeType: 'organization',
      scopeId: tenants[0]!.id,
      title: 'Fabrikam Demo Runbooks',
    },
  });
  await prisma.document.upsert({
    where: { id: 'demo-runbook-cost-spike' },
    update: {
      workspaceId: workspace.id,
      title: '[DEMO] Investigating a cost spike',
      kind: 'runbook',
      body: '# Cost spike response\n\n1. Confirm the subscription and resource are in scope.\n2. Compare the daily charge with the 30-day baseline.\n3. Check recent deployments and configuration drift.\n4. Assign an owner and record the decision in the linked work item.\n5. Preview any remediation and obtain required approval before execution.\n\nThis runbook and all linked estate data are synthetic demo content.',
      updatedBy: 'Demo data seeder',
    },
    create: {
      id: 'demo-runbook-cost-spike',
      workspaceId: workspace.id,
      title: '[DEMO] Investigating a cost spike',
      kind: 'runbook',
      body: '# Cost spike response\n\n1. Confirm the subscription and resource are in scope.\n2. Compare the daily charge with the 30-day baseline.\n3. Check recent deployments and configuration drift.\n4. Assign an owner and record the decision in the linked work item.\n5. Preview any remediation and obtain required approval before execution.\n\nThis runbook and all linked estate data are synthetic demo content.',
      createdBy: 'Demo data seeder',
      updatedBy: 'Demo data seeder',
    },
  });

  const changedResource = demoResources.get('demo-storage-prod')!;
  await prisma.changeEvent.upsert({
    where: { id: 'demo-change-storage-tags' },
    update: {
      resourceId: changedResource.id,
      field: 'tags',
      oldValue: { Environment: 'Production' },
      newValue: { Environment: 'Production', Demo: 'true' },
      detectedAt: new Date(),
    },
    create: {
      id: 'demo-change-storage-tags',
      resourceId: changedResource.id,
      field: 'tags',
      oldValue: { Environment: 'Production' },
      newValue: { Environment: 'Production', Demo: 'true' },
      detectedAt: new Date(),
    },
  });

  const syncTime = new Date();
  const syncSummary = {
    orgs: DEMO_TENANTS.map((demoTenant, index) => ({
      organization: demoTenant.name,
      tenantId: tenants[index]!.id,
      subscriptions: DEMO_SUBSCRIPTIONS.filter((subscription) => subscription.tenant === index)
        .length,
      resources: DEMO_RESOURCES.filter(
        (resource) => DEMO_SUBSCRIPTIONS[resource.subscription]!.tenant === index,
      ).length,
      skipped: [],
    })),
    totalSubscriptions: subscriptions.length,
    skipped: [],
    deleted: 0,
  };
  await prisma.syncRun.upsert({
    where: { id: 'demo-sync-run' },
    update: {
      providerKey: 'azure',
      scope: 'demo',
      status: 'completed',
      created: resources.length,
      updated: 0,
      changes: 0,
      deleted: 0,
      triggeredBy: 'Demo data seeder',
      summary: syncSummary,
      startedAt: new Date(syncTime.getTime() - 30_000),
      finishedAt: syncTime,
      createdAt: syncTime,
    },
    create: {
      id: 'demo-sync-run',
      providerKey: 'azure',
      scope: 'demo',
      status: 'completed',
      created: resources.length,
      updated: 0,
      changes: 0,
      deleted: 0,
      triggeredBy: 'Demo data seeder',
      summary: syncSummary,
      startedAt: new Date(syncTime.getTime() - 30_000),
      finishedAt: syncTime,
      createdAt: syncTime,
    },
  });

  const standards = new StandardsService(new StandardsRepository(appPrisma));
  const compliance = await standards.evaluate();
  console.log(
    `Advanced demo data ready: ${tenants.length} organizations, ${subscriptions.length} subscriptions, ${resources.length} resources, ${costRows.length} daily cost records, ${workItems.length} work items, ${demoAssignments.length} service/environment mappings, 2 budgets, 1 automation rule, 1 runbook and 1 notification; compliance ${compliance.score}% (${compliance.failed} failures).`,
  );
}

function resourceGroupExternalId(name: string, subscriptionId: string): string {
  return `/subscriptions/${subscriptionId}/resourcegroups/${name}`;
}

main()
  .catch((error: unknown) => {
    console.error('Demo data seeding failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    await appPrisma.$disconnect();
  });
