import type { QuotaSnapshot } from '../../shared/quota.js';
import type { RuntimeType } from '../../shared/types.js';

/**
 * Reads one runtime's subscription quota.
 *
 * Implementations must be free: no model turn, no login prompt, no writes. They
 * must honour `signal` and clean up every process and handle they open, on
 * success and on failure alike.
 */
export interface QuotaSource {
  readonly runtimeType: RuntimeType;
  read(signal: AbortSignal): Promise<QuotaSnapshot>;
}
