/**
 * The errors the Claude session lifecycle raises, and the helpers that turn a failure into the
 * detail text and recovery condition a caller reports.
 */

import type { RecoveryCondition } from "@ai-sidekicks/contracts/provider/driver/recovery";
import type { RunId } from "@ai-sidekicks/contracts/run/id";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import { CLAUDE_DRIVER_NAME } from "../capabilities.js";
import { boundFailureDetail } from "../../contract.js";

const UNDESCRIBED_FAILURE_DETAIL =
  "The Claude provider transport failed the resume with no describable detail.";

/** Why the driver refused to service a session or run operation. */
export type ClaudeSessionUnavailableReason =
  | "session_already_live"
  | "session_id_pin_diverged"
  | "no_live_session"
  | "no_live_run"
  | "run_already_dispatched"
  | "session_turn_in_flight"
  | "run_dispatch_unresolved"
  | "execution_posture_mismatch"
  | "output_schema_unbound"
  | "output_schema_mismatch"
  | "provider_account_unusable"
  | "provider_account_ambiguous";

const SESSION_UNAVAILABLE_MESSAGES: Readonly<Record<ClaudeSessionUnavailableReason, string>> = {
  session_already_live:
    "A live Claude session is already bound to this session; create would orphan it.",
  session_id_pin_diverged:
    "The spawned Claude process announced a session id other than the pinned one.",
  no_live_session: "No live Claude session is bound to this session.",
  no_live_run: "No live Claude session is bound to this run.",
  run_already_dispatched:
    "This run's opening frame is already on the wire and its turn has not settled.",
  session_turn_in_flight:
    "Another run's frame is still pending on this Claude session; its turn has not settled.",
  run_dispatch_unresolved: "The daemon resolved no Claude dispatch for this run.",
  execution_posture_mismatch:
    "The run's execution posture does not match the posture the Claude session was spawned with.",
  output_schema_mismatch:
    "The run's output schema differs from the schema the Claude session was spawned with.",
  output_schema_unbound:
    "The run requires schema-constrained output but the Claude session was spawned without a " +
    "schema.",
  // `unusable`: one source arrived malformed. `ambiguous`: two well-formed sources disagree.
  provider_account_unusable:
    "The request named a provider account that is present but empty; an account was meant to " +
    "be bound and none was.",
  provider_account_ambiguous:
    "Two resolvers name different provider accounts for this Claude session.",
};

/** The structured fields of a `ClaudeSessionUnavailableError`. */
export interface ClaudeSessionUnavailableFields {
  readonly driverId: string;
  readonly reason: ClaudeSessionUnavailableReason;
  readonly sessionId: SessionId | undefined;
  readonly runId: RunId | undefined;
}

/** The optional session, run and free-text detail attached to a refusal. */
export interface ClaudeSessionUnavailableContext {
  readonly sessionId?: SessionId | undefined;
  readonly runId?: RunId | undefined;
  readonly detail?: string | undefined;
}

/**
 * Every driver-side refusal to service a session or run operation. It rides the registered
 * `driver.unavailable` (503), and `reason` carries the finer distinction.
 */
export class ClaudeSessionUnavailableError extends Error {
  readonly code = "driver.unavailable" as const;
  readonly fields: ClaudeSessionUnavailableFields;

  constructor(reason: ClaudeSessionUnavailableReason, context: ClaudeSessionUnavailableContext) {
    const detail = context.detail;
    super(
      detail === undefined
        ? SESSION_UNAVAILABLE_MESSAGES[reason]
        : `${SESSION_UNAVAILABLE_MESSAGES[reason]} ${detail}`,
    );
    this.name = "ClaudeSessionUnavailableError";
    this.fields = {
      driverId: CLAUDE_DRIVER_NAME,
      reason,
      sessionId: context.sessionId,
      runId: context.runId,
    };
  }
}

/**
 * Thrown by a transport for an expired or missing credential; the only route to `reauth-required`.
 * Rides `driver.not_authenticated`.
 */
export class ClaudeAuthenticationRequiredError extends Error {
  readonly code = "driver.not_authenticated" as const;
  readonly fields: { readonly driverId: string };

  constructor(message: string) {
    super(message);
    this.name = "ClaudeAuthenticationRequiredError";
    this.fields = { driverId: CLAUDE_DRIVER_NAME };
  }
}

/** A request to the Claude Code process that its deadline expired on. Rides `driver.timeout`. */
export class ClaudeRequestTimeoutError extends Error {
  readonly code = "driver.timeout" as const;
  readonly fields: { readonly driverId: string; readonly timeoutMs: string };

  constructor(message: string, timeoutMs: number) {
    super(message);
    this.name = "ClaudeRequestTimeoutError";
    this.fields = { driverId: CLAUDE_DRIVER_NAME, timeoutMs: String(timeoutMs) };
  }
}

// `name` and `message` may be accessors and a throwing getter would throw inside the caller's
// catch; a non-string falls through, since stringifying could put a credential-bearing `toString`
// in a durable row.
function readErrorStringProperty(error: Error, property: "message" | "name"): string | undefined {
  try {
    const value: unknown = error[property];
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Renders a thrown value as one line safe to show the person; total, since every caller is a
 * `catch` block. It never serializes an arbitrary value (no `String(error)` fallback):
 * `providerFailureDetail` is persisted and could leak spawn configuration or credentials.
 */
export function describeFailure(error: unknown): string {
  if (error instanceof Error) {
    const name = readErrorStringProperty(error, "name");
    const message = readErrorStringProperty(error, "message");
    if (message !== undefined && message.length > 0) {
      // An unreadable name costs the prefix, not the whole detail.
      return name !== undefined && name.length > 0 ? `${name}: ${message}` : message;
    }
    if (name !== undefined && name.length > 0) {
      return name;
    }
    return UNDESCRIBED_FAILURE_DETAIL;
  }
  if (typeof error === "string") {
    return error;
  }
  return UNDESCRIBED_FAILURE_DETAIL;
}

/** Fits failure text to the persisted detail's rules, with this driver's empty-text fallback. */
export function sanitizeFailureDetail(detail: string): string {
  return boundFailureDetail(detail, UNDESCRIBED_FAILURE_DETAIL);
}

/** Names the evidence, not a credential source the probe did not report. */
export const CLAUDE_AUTH_PROBE_REACHED_DETAIL = "the provider answered the zero-turn auth probe";

/** Maps a failure to the recovery condition it leaves the session in: sign in again, or recover. */
export function classifyRecoveryCondition(error: unknown): RecoveryCondition {
  return error instanceof ClaudeAuthenticationRequiredError ? "reauth-required" : "recovery-needed";
}
