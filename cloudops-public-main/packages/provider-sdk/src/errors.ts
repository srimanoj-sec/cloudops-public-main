/**
 * Why a cost query failed. The FinOps engine keeps a subscription's existing
 * cost data whenever its query fails; the kind decides what happens next:
 * `throttled` and `network` are retried automatically, the rest are shown to
 * the operator with the reason.
 */
export type CostFailureKind = 'throttled' | 'network' | 'no-access' | 'unsupported' | 'error';

/** A failed cost query, with an operator-readable message and its {@link CostFailureKind}. */
export class CostQueryError extends Error {
  override readonly name = 'CostQueryError';

  constructor(
    message: string,
    readonly kind: CostFailureKind,
  ) {
    super(message);
  }
}
