// The environment gate is an allow-list, not a deny-list: only `'development'` passes, so a typo,
// an omission or any other value (`'production'`, `'staging'`, `''`) is refused, where a deny-list
// would let an unknown value through. The value lives in `.dev.vars` beside the feature flag so
// neither security-relevant key reaches a deployable Wrangler surface.

import type { GateResult } from "./feature-flag-gate.js";

/** The Worker environment key the environment gate reads. */
export interface DevEnvironmentEnv {
  readonly ENVIRONMENT?: string;
}

const ENVIRONMENT_KEY = "ENVIRONMENT";
const DEV_ENVIRONMENT_VALUE = "development";

/** Passes only when `ENVIRONMENT` is exactly `'development'`; a refusal names the value seen. */
export function checkDevEnvironment(env: DevEnvironmentEnv): GateResult {
  if (env.ENVIRONMENT === DEV_ENVIRONMENT_VALUE) {
    return { ok: true };
  }
  const observed = env.ENVIRONMENT === undefined ? "undefined" : `'${env.ENVIRONMENT}'`;
  return {
    ok: false,
    reason: `${ENVIRONMENT_KEY} allow-list rejected ${observed} (only '${DEV_ENVIRONMENT_VALUE}' passes)`,
  };
}
