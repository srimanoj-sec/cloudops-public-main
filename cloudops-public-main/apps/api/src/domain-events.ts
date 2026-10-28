import type { CostSyncSubscriptionResultDto } from '@cloudops/core';

/**
 * Typed payloads for the API's domain events (the kernel event map is open for
 * augmentation). Emitters and reactors (notifier, automation engine) share
 * these shapes, so a renamed field is a compile error rather than a silent miss.
 * `sync.*` and `resource.*` are declared by the kernel itself.
 */
declare module '@cloudops/kernel' {
  interface KernelEventMap {
    'finops.synced': {
      providerKey: string;
      records: number;
      results?: CostSyncSubscriptionResultDto[];
      /** Subscriptions queued for an automatic retry (transient failures). */
      retrying?: string[];
    };
    'compliance.evaluated': {
      score: number;
      failed: number;
      /** Rules with resources failing now that weren't failing before this evaluation. */
      newFailures: { ruleId: string; ruleName: string; severity: string; resourceIds: string[] }[];
    };
    'remediation.requested': {
      runId: string;
      title: string;
      risk: string;
      requestedBy: string | null;
      requestedById: string | null;
      needsApproval: boolean;
      targets: number;
    };
    'remediation.decided': { runId: string; title: string; approved: boolean; decidedBy: string | null; requestedById: string | null };
    'remediation.finished': {
      runId: string;
      title: string;
      status: string;
      requestedById: string | null;
      summary: { total: number; succeeded: number; failed: number; skipped: number; verified: number };
    };
    'work.assigned': { itemId: string; title: string; assignee: string; actor: string | null; actorId: string | null };
    /** A comment that may @mention people (`@Full Name` or `@email`). */
    'work.mentioned': { itemId: string; title: string; body: string; actor: string | null; actorId: string | null };
    'job.failed': { queue: string; jobId: string; name: string; error: string; attemptsMade: number };
  }
}

export {};
