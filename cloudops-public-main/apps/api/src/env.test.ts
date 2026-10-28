import { describe, expect, it } from 'vitest';
import { configSecurityIssues } from './env.js';

const strong = 'x'.repeat(40);

describe('configSecurityIssues', () => {
  it('accepts long, distinct, non-default secrets', () => {
    const r = configSecurityIssues({ JWT_ACCESS_SECRET: strong, JWT_REFRESH_SECRET: `${strong}y`, SEED_ADMIN_PASSWORD: 'Something-Unique-1' });
    expect(r).toEqual({ fatal: [], warnings: [] });
  });

  it('flags the shipped defaults as fatal (production refuses to boot)', () => {
    const r = configSecurityIssues({
      JWT_ACCESS_SECRET: 'dev-access-secret-change-me',
      JWT_REFRESH_SECRET: 'dev-refresh',
      SEED_ADMIN_PASSWORD: 'x',
    });
    expect(r.fatal).toHaveLength(2);
    expect(r.fatal.join()).toMatch(/well-known default/);
  });

  it('flags short and identical secrets', () => {
    const r = configSecurityIssues({ JWT_ACCESS_SECRET: 'short', JWT_REFRESH_SECRET: 'short', SEED_ADMIN_PASSWORD: 'x' });
    expect(r.fatal.join()).toMatch(/shorter than 32/);
    expect(r.fatal.join()).toMatch(/must differ/);
  });

  it('only warns about the default seed password (it applies to first boot only)', () => {
    const r = configSecurityIssues({ JWT_ACCESS_SECRET: strong, JWT_REFRESH_SECRET: `${strong}y`, SEED_ADMIN_PASSWORD: 'ChangeMe123!' });
    expect(r.fatal).toEqual([]);
    expect(r.warnings).toHaveLength(1);
  });

  it('warns that TRUST_PROXY=true lets clients spoof their IP (a hop count does not)', () => {
    const base = { JWT_ACCESS_SECRET: strong, JWT_REFRESH_SECRET: `${strong}y`, SEED_ADMIN_PASSWORD: 'Something-Unique-1' };
    expect(configSecurityIssues({ ...base, TRUST_PROXY: true }).warnings.join()).toMatch(/spoof/);
    expect(configSecurityIssues({ ...base, TRUST_PROXY: 1 }).warnings).toEqual([]);
    expect(configSecurityIssues({ ...base, TRUST_PROXY: false }).warnings).toEqual([]);
  });
});
