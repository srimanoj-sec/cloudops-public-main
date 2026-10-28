import type { Prisma } from '../../infra/prisma.js';

/** Data-access for saved views. */
export class ViewsRepository {
  constructor(private readonly prisma: Prisma) {}

  list(scope: string) {
    return this.prisma.savedView.findMany({ where: { scope }, orderBy: { name: 'asc' } });
  }

  get(id: string) {
    return this.prisma.savedView.findUnique({ where: { id } });
  }

  create(data: { name: string; scope: string; filters: unknown; createdBy: string | null }) {
    return this.prisma.savedView.create({
      data: { name: data.name, scope: data.scope, filters: data.filters as object, createdBy: data.createdBy },
    });
  }

  update(id: string, data: { name?: string; filters?: unknown }) {
    return this.prisma.savedView.update({
      where: { id },
      data: {
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.filters !== undefined ? { filters: data.filters as object } : {}),
      },
    });
  }

  delete(id: string) {
    return this.prisma.savedView.delete({ where: { id } });
  }
}
