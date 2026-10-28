import { z } from 'zod';

/**
 * Resource-workspace contracts. A `Workspace` is the documentation surface for a
 * single scope (organization / subscription / resource group / resource); it
 * holds markdown `Document`s (docs, runbooks, SOPs, knowledge articles).
 */

export const DOCUMENT_KINDS = ['doc', 'runbook', 'sop', 'knowledge'] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

export const WORKSPACE_SCOPE_TYPES = [
  'organization',
  'subscription',
  'resourceGroup',
  'resource',
] as const;
export type WorkspaceScopeType = (typeof WORKSPACE_SCOPE_TYPES)[number];

export interface DocumentDto {
  id: string;
  workspaceId: string;
  title: string;
  body: string;
  kind: string;
  createdBy?: string | null;
  updatedBy?: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A document as it was before an edit. */
export interface DocumentRevisionDto {
  id: string;
  title: string;
  kind: string;
  /** Who wrote this version. */
  author: string | null;
  /** When it was replaced by the next edit. */
  createdAt: string;
  /** Present when one revision is fetched; lists carry the size only. */
  body?: string;
  length: number;
}

/**
 * Starting points for new documents. Plain Markdown the author fills in —
 * sections, not content.
 */
export const DOCUMENT_TEMPLATES: {
  key: string;
  label: string;
  kind: DocumentKind;
  title: string;
  body: string;
}[] = [
  {
    key: 'runbook',
    label: 'Runbook',
    kind: 'runbook',
    title: 'Runbook: ',
    body: `## Purpose\n\nWhat this runbook handles and when to use it.\n\n## Before you start\n\n- Access needed:\n- Who to tell:\n\n## Steps\n\n1. \n2. \n3. \n\n## Verify\n\nHow to confirm it worked.\n\n## Roll back\n\nHow to undo it if it didn’t.\n\n## Escalation\n\nWho to contact if this runbook doesn’t resolve it.\n`,
  },
  {
    key: 'sop',
    label: 'Standard operating procedure',
    kind: 'sop',
    title: 'SOP: ',
    body: `## Scope\n\nWhich resources and teams this applies to.\n\n## Responsibilities\n\n- Role — responsibility\n\n## Procedure\n\n1. \n2. \n\n## Frequency\n\nHow often, and what triggers it.\n\n## Records\n\nWhat is logged and where.\n`,
  },
  {
    key: 'incident',
    label: 'Incident review',
    kind: 'knowledge',
    title: 'Incident review: ',
    body: `## Summary\n\nWhat happened, in two sentences.\n\n## Impact\n\n- Affected:\n- Duration:\n- Cost:\n\n## Timeline\n\n- HH:MM — event\n\n## Root cause\n\n## What went well\n\n## What we’ll change\n\n- \n`,
  },
  {
    key: 'ownership',
    label: 'Ownership & contacts',
    kind: 'doc',
    title: 'Ownership & contacts',
    body: `## Owner\n\n- Team:\n- Primary contact:\n- Secondary contact:\n\n## Purpose\n\nWhat this is for and who depends on it.\n\n## Environments\n\n- production — notes\n\n## Cost & budget\n\nExpected monthly cost and who approves changes.\n`,
  },
];

export interface WorkspaceDto {
  id: string;
  scopeType: string;
  scopeId: string;
  scopeName: string | null;
  title: string;
  documentCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceDetailDto extends WorkspaceDto {
  documents: DocumentDto[];
}

/** The workspace + docs for a scope; `workspace` is null until the first doc. */
export interface ScopeWorkspaceDto {
  scopeType: string;
  scopeId: string;
  scopeName: string | null;
  workspace: WorkspaceDetailDto | null;
}

// ── request schemas ──────────────────────────────────────────────

export const createDocumentSchema = z.object({
  title: z.string().min(1).max(200),
  kind: z.enum(DOCUMENT_KINDS).default('doc'),
  body: z.string().max(100_000).default(''),
});
export type CreateDocumentRequest = z.infer<typeof createDocumentSchema>;

export const updateDocumentSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  kind: z.enum(DOCUMENT_KINDS).optional(),
  body: z.string().max(100_000).optional(),
});
export type UpdateDocumentRequest = z.infer<typeof updateDocumentSchema>;
