// Plan-008 §I-008-1 dual-gate, gate #2: approved-dev-environment allow-list.
//
// Refuses every request unless `env.ENVIRONMENT === 'development'`. The
// allow-list semantics (only one passing value) is deliberate: it cannot be
// satisfied by a typo, omission, or any of `'production'` / `'staging'` /
// `'test'` / `''`. Co-located with the feature flag in `.dev.vars` so neither
// security-load-bearing key reaches a deployable Wrangler surface.
//
// The Codex PR #20 round-4 review surfaced a deny-list weakness (any unknown
// value passed); the allow-list pivot here closes that exposure path.
//
// Refs: docs/plans/008-control-plane-relay-and-session-join.md §I-008-1,
//       Plan-008 §Decision Log Codex PR #20 round-4 allow-list pivot.

import type { GateResult } from "./feature-flag-gate.js";

export interface DevEnvironmentEnv {
  readonly ENVIRONMENT?: string;
}

export const ENVIRONMENT_KEY = "ENVIRONMENT";
export const DEV_ENVIRONMENT_VALUE = "development";

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
