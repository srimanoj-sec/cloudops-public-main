import { describe, expect, it } from 'vitest';
import { paginate, paginationQuerySchema } from './pagination.js';

describe('pagination', () => {
  it('applies defaults', () => {
    expect(paginationQuerySchema.parse({})).toEqual({ page: 1, pageSize: 50 });
  });

  it('coerces string query params', () => {
    expect(paginationQuerySchema.parse({ page: '2', pageSize: '10' })).toEqual({ page: 2, pageSize: 10 });
  });

  it('computes total pages', () => {
    const result = paginate([1, 2, 3], 105, 1, 50);
    expect(result.totalPages).toBe(3);
    expect(result.total).toBe(105);
  });
});
