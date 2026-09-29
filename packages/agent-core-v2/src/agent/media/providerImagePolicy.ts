/**
 * `media` domain — provider-declared inline image acceptance limits.
 *
 * Providers declare image capabilities in the `kosong/provider` registry. The
 * media layer supplies the baseline for unspecified providers and overlays a
 * declaration when one is present. Callers must always use this policy for
 * both history ingestion and tool delivery so a format accepted at one entry
 * point cannot poison a later request.
 */

import { getProviderImageCapabilities } from '#/kosong/provider/providerDefinition';

export interface ProviderImagePolicy {
  readonly acceptedMimes: ReadonlySet<string>;
  readonly inlineByteBudget: number;
}

export const DEFAULT_INLINE_IMAGE_BYTE_BUDGET = 3.75 * 1024 * 1024;

const BASELINE_IMAGE_POLICY: ProviderImagePolicy = {
  acceptedMimes: new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']),
  inlineByteBudget: DEFAULT_INLINE_IMAGE_BYTE_BUDGET,
};

export function providerImagePolicy(providerType?: string): ProviderImagePolicy {
  const capabilities = getProviderImageCapabilities(providerType);
  if (capabilities === undefined) return BASELINE_IMAGE_POLICY;
  return {
    acceptedMimes: new Set([...BASELINE_IMAGE_POLICY.acceptedMimes, ...capabilities.acceptedMimes]),
    inlineByteBudget: capabilities.inlineByteBudget,
  };
}
