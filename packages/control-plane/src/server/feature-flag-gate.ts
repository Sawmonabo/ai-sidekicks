// Gate #1: bootstrap feature-flag check.
//
// Refuses every request unless `env.CONTROL_PLANE_BOOTSTRAP_ENABLED === '1'`.
// This is the operator-development-only kill-switch — defaulting to off keeps
// the bootstrap unreachable on any deploy that doesn't explicitly set it.
//

/** The Worker environment key gate #1 reads. */
export interface FeatureFlagEnv {
  readonly CONTROL_PLANE_BOOTSTRAP_ENABLED?: string;
}

/** A gate's verdict; a refusal carries the operator-facing reason. */
export type GateResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

const FEATURE_FLAG_KEY = "CONTROL_PLANE_BOOTSTRAP_ENABLED";
const FEATURE_FLAG_PASS_VALUE = "1";

/** Passes only when `CONTROL_PLANE_BOOTSTRAP_ENABLED` is exactly `'1'`. */
export function checkFeatureFlag(env: FeatureFlagEnv): GateResult {
  if (env.CONTROL_PLANE_BOOTSTRAP_ENABLED === FEATURE_FLAG_PASS_VALUE) {
    return { ok: true };
  }
  return {
    ok: false,
    reason: `feature flag ${FEATURE_FLAG_KEY} not set to '${FEATURE_FLAG_PASS_VALUE}'`,
  };
}
