/**
 * Reads the account state Codex reports and turns it into an auth probe result or a resume
 * recovery condition.
 */

import { type RecoveryCondition } from "@ai-sidekicks/contracts";
import { isPlainObject } from "./record-readers.js";
import type { CodexAppServerConnection } from "./app-server-connection.js";
import { CodexProviderRequestError } from "./session-errors.js";
import {
  DRIVER_AUTH_DETAIL_MAX_LEN,
  DriverAuthProbeResultSchema,
  type DriverAuthProbeResult,
} from "../../provider-driver.js";

/**
 * Zero-turn auth probe; answerable with `experimentalApi: false`. Preferred over the `codex login
 * status` and `codex doctor --json` CLIs, which spawn a second process and parse human-shaped
 * output.
 */
const CODEX_AUTH_STATUS_METHOD = "getAuthStatus";

/** Deadline for the auth probe, which reads local credential state and gates admission. */
export const CODEX_AUTH_PROBE_TIMEOUT_MS = 10_000;

/** Deadline for the resume-failure auth classification; short so it never delays the failure. */
const CODEX_RESUME_AUTH_CLASSIFICATION_TIMEOUT_MS = 2_000;

/**
 * Builds a probe result without throwing. `detail` is bounded tighter than failure detail and
 * dropped if the envelope still refuses it; `status` carries the decision.
 */
export function buildAuthProbeResult(
  status: DriverAuthProbeResult["status"],
  detail: string,
): DriverAuthProbeResult {
  const bounded =
    detail.length > DRIVER_AUTH_DETAIL_MAX_LEN
      ? detail.slice(0, DRIVER_AUTH_DETAIL_MAX_LEN)
      : detail;
  const parsed = DriverAuthProbeResultSchema.safeParse({ status, detail: bounded });
  return parsed.success ? parsed.data : DriverAuthProbeResultSchema.parse({ status });
}

/**
 * Maps a `getAuthStatus` answer onto the probe result. Only `authMethod` is read, never
 * `authToken`; it is a closed mechanism enum, safe as `detail` (unlike `account/read`, which
 * carries a plan name and account email). A `null` method is `unauthenticated` even if no OpenAI
 * sign-in is required.
 */
export function classifyCodexAuthStatus(response: unknown): DriverAuthProbeResult {
  if (!isPlainObject(response)) {
    return buildAuthProbeResult(
      "indeterminate",
      `the Codex app-server "${CODEX_AUTH_STATUS_METHOD}" response was not an object`,
    );
  }
  const authMethod = response["authMethod"];
  if (typeof authMethod === "string" && authMethod.length > 0) {
    return buildAuthProbeResult("authenticated", `auth method: ${authMethod}`);
  }
  if (authMethod !== null && authMethod !== undefined) {
    // Present but not a string: an unreadable shape is probe ill-health, not a credential verdict.
    return buildAuthProbeResult(
      "indeterminate",
      `the Codex app-server "${CODEX_AUTH_STATUS_METHOD}" response carried an unreadable authMethod`,
    );
  }
  return buildAuthProbeResult(
    "unauthenticated",
    response["requiresOpenaiAuth"] === false
      ? "no auth method is resolved; the configured provider reports it requires no OpenAI sign-in"
      : "no auth method is resolved for this credential home",
  );
}

/**
 * Asks one connection the auth question without token material (`includeToken: false`) and
 * without a refresh (`refreshToken: false`): the pinned providers rotate refresh tokens
 * single-use, so a refresh would end the login being checked. Both are sent because
 * `GetAuthStatusParams` types them required-but-nullable.
 */
export async function requestCodexAuthStatus(
  connection: CodexAppServerConnection,
  timeoutMs: number,
): Promise<unknown> {
  return await connection.request(
    CODEX_AUTH_STATUS_METHOD,
    { includeToken: false, refreshToken: false },
    timeoutMs,
  );
}

/**
 * Classifies a failed resume as `reauth-required` or `recovery-needed`. The still-open
 * connection is asked the credential question directly (the provider has no typed auth error),
 * and only after a `CodexProviderRequestError`, which proves the child is alive; asking a
 * wedged connection would wait out a second deadline. Anything short of a determinate
 * logged-out reading, an `indeterminate` probe included, is `recovery-needed`.
 */
export async function classifyResumeRecoveryCondition(
  connection: CodexAppServerConnection,
  cause: unknown,
): Promise<RecoveryCondition> {
  if (!(cause instanceof CodexProviderRequestError) || connection.isClosed) {
    return "recovery-needed";
  }
  try {
    const reading = classifyCodexAuthStatus(
      await requestCodexAuthStatus(connection, CODEX_RESUME_AUTH_CLASSIFICATION_TIMEOUT_MS),
    );
    return reading.status === "unauthenticated" ? "reauth-required" : "recovery-needed";
  } catch {
    // Contained: a failed probe must not replace the typed `failed` result the resume path returns.
    return "recovery-needed";
  }
}
