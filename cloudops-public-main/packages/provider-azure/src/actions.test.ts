import { describe, expect, it } from 'vitest';
import { az } from './az-exec.js';
import { actionArgs } from './azure-provider.js';

const VM = '/subscriptions/s/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/vm1';
const APP = '/subscriptions/s/resourceGroups/rg/providers/Microsoft.Web/sites/app1';

describe('actionArgs (remediation → az arguments)', () => {
  it('builds a property update', () => {
    expect(actionArgs({ kind: 'set-property', externalId: APP, path: 'httpsOnly', value: true })).toEqual([
      'resource',
      'update',
      '--ids',
      APP,
      '--set',
      'properties.httpsOnly=true',
      '--only-show-errors',
    ]);
  });

  it('refuses unexpected property paths and values that could smuggle arguments', () => {
    expect(() => actionArgs({ kind: 'set-property', externalId: APP, path: 'a;b', value: 1 })).toThrow(/property path/);
    expect(() => actionArgs({ kind: 'set-property', externalId: APP, path: '__proto__.x', value: 1 })).toThrow(/property path/);
    expect(() => actionArgs({ kind: 'set-property', externalId: APP, path: 'minTls', value: '1.2 --debug' })).toThrow(/spaces or quotes/);
    expect(() => actionArgs({ kind: 'set-property', externalId: APP, path: 'minTls', value: '"x"' })).toThrow(/spaces or quotes/);
  });

  it('only powers virtual machines, and stop means deallocate (stops the charge)', () => {
    expect(actionArgs({ kind: 'power', externalId: VM, operation: 'stop' })).toEqual(['vm', 'deallocate', '--ids', VM, '--only-show-errors']);
    expect(() => actionArgs({ kind: 'power', externalId: APP, operation: 'start' })).toThrow(/virtual machines only/);
  });
});

describe('az write guard', () => {
  it('refuses a mutating verb on a read-only call, before running anything', async () => {
    await expect(az(['resource', 'update', '--ids', APP], { allowGroups: new Set(['resource']) })).rejects.toThrow(/read-only/);
    await expect(az(['vm', 'deallocate', '--ids', VM], { allowGroups: new Set(['vm']) })).rejects.toThrow(/read-only/);
    await expect(az(['tag', 'update'], { allowGroups: new Set(['tag']) })).rejects.toThrow(/read-only/);
  });
});
