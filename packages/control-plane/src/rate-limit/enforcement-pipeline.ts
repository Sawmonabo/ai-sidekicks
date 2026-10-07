// The one admission stage every counted transport calls, tRPC procedures and raw routes alike: the
// endpoint group's sliding-window counter decides, and nothing else does.

import type {
  RateLimitCheckRequest,
  RateLimitCheckResponse,
  RateLimitEndpointGroup,
  RateLimiter,
} from "./limiter.js";

// Whether a request may proceed, with the window state a refusal's 429 is built from.
interface AdmissionResult {
  readonly admitted: boolean;
  readonly check: RateLimitCheckResponse;
}

/**
 * Counts one request against its endpoint group's limit. Rejects with the counter's own error when
 * the counter fails, so the caller fails that one request.
 */
export type AdmissionCheck = (request: RateLimitCheckRequest) => Promise<AdmissionResult>;

/** Builds the admission check over the counter each endpoint group is counted by. */
export function createAdmissionCheck(dependencies: {
  readonly limiterFor: (endpoint: RateLimitEndpointGroup) => RateLimiter;
}): AdmissionCheck {
  return async function checkAdmission(request) {
    const check = await dependencies.limiterFor(request.endpoint).check(request);
    return { admitted: check.allowed, check };
  };
}
