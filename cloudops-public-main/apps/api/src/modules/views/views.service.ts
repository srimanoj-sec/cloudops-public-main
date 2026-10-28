import type {
  CreateSavedViewRequest,
  SavedViewDto,
  UpdateSavedViewRequest,
} from '@cloudops/core';
import { AppError } from '../../http/errors.js';
import type { ViewsRepository } from './views.repository.js';

type SavedViewRow = {
  id: string;
  name: string;
  scope: string;
  filters: unknown;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
};

function toDto(v: SavedViewRow): SavedViewDto {
  return {
    id: v.id,
    name: v.name,
    scope: v.scope,
    filters: (v.filters as Record<string, unknown>) ?? {},
    createdBy: v.createdBy,
    createdAt: v.createdAt.toISOString(),
    updatedAt: v.updatedAt.toISOString(),
  };
}

/** The caller acting on a saved view. */
export interface ViewCaller {
  userId: string | null;
  /** admin/operator — may manage any team view. */
  canOperate: boolean;
}

/**
 * Views are shared with the whole team, but only their author (or an
 * operator/admin) may change or delete one. Views without a recorded author
 * (legacy) are operator/admin-managed.
 */
function assertCanModify(view: SavedViewRow, caller: ViewCaller): void {
  if (caller.canOperate) return;
  if (view.createdBy && view.createdBy === caller.userId) return;
  throw AppError.forbidden('Only the author of this view, an operator, or an admin can change it');
}

export class ViewsService {
  constructor(private readonly repo: ViewsRepository) {}

  async list(scope: string): Promise<SavedViewDto[]> {
    const rows = await this.repo.list(scope);
    return rows.map(toDto);
  }

  async create(input: CreateSavedViewRequest, createdBy: string | null): Promise<SavedViewDto> {
    const row = await this.repo.create({
      name: input.name,
      scope: input.scope,
      filters: input.filters,
      createdBy,
    });
    return toDto(row);
  }

  async update(id: string, input: UpdateSavedViewRequest, caller: ViewCaller): Promise<SavedViewDto> {
    const existing = await this.repo.get(id);
    if (!existing) throw AppError.notFound('Saved view not found');
    assertCanModify(existing, caller);
    const row = await this.repo.update(id, input);
    return toDto(row);
  }

  async remove(id: string, caller: ViewCaller): Promise<SavedViewDto> {
    const existing = await this.repo.get(id);
    if (!existing) throw AppError.notFound('Saved view not found');
    assertCanModify(existing, caller);
    await this.repo.delete(id);
    return toDto(existing);
  }
}
