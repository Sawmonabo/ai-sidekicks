// Gate #2: approved-dev-environment allow-list.
//
// Refuses every request unless `env.ENVIRONMENT === 'development'`. The
// allow-list semantics (only one passing value) is deliberate: it cannot be
// satisfied by a typo, omission, or any of `'production'` / `'staging'` /
// `'test'` / `''`. Co-located with the feature flag in `.dev.vars` so neither
// security-load-bearing key reaches a deployable Wrangler surface.
//
// A deny-list here would be weak (any unknown value passes); the allow-list
// closes that exposure path.
//

import type { GateResult } from "./feature-flag-gate.js";

/** The Worker environment key gate #2 reads. */
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
