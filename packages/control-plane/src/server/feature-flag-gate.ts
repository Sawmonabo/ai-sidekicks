// The feature-flag gate is a kill-switch that defaults to off, so the bootstrap stays unreachable
// on any deploy that does not set the flag explicitly.

/** The Worker environment key the feature-flag gate reads. */
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
