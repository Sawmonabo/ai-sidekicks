// What Claude Code's `system` frames say about a run, read into the daemon's words: the model
// switches and the refusal no other model took, a warning, the provider's coarse status, the
// worker's shutdown reason and a helper's end; and the refusal an `assistant` message ends on,
// read beside the other refusal. The frames are untrusted, so every member is narrowed and a frame
// that reads as nothing known reads as `undefined`.

import type { UsageModelReroutedPayload } from "@ai-sidekicks/contracts/event/declared-variants";
import type { RunRefusedCause } from "@ai-sidekicks/contracts/run/failure-cause";

import type { RunTransitionRequest } from "../../../../session/run/engine.js";
import { isPlainObject, readNonEmptyString } from "../../../record-readers.js";
import { sanitizeFailureDetail } from "../session/errors.js";

/** A model switch as `usage.model_rerouted` carries it, before its session and run are named. */
type ClaudeModelReroute = Omit<UsageModelReroutedPayload, "sessionId" | "runId">;

// The `model_fallback` trigger that names a blocked model; every other names an unavailable one.
const CLAUDE_MODEL_BLOCKED_TRIGGER = "model_blocked";

function readOptionalText(
  frame: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  const text = readNonEmptyString(frame, key);
  return text === undefined ? undefined : sanitizeFailureDetail(text);
}

// The provider's own words on a switch or refusal: `content` when not empty, its explanation and
// its check category.
function readRefusalWords(
  frame: Readonly<Record<string, unknown>>,
): Pick<ClaudeModelReroute, "sentence" | "explanation" | "safetyCategory"> {
  const sentence = readOptionalText(frame, "content");
  const explanation = readOptionalText(frame, "api_refusal_explanation");
  const safetyCategory = readNonEmptyString(frame, "api_refusal_category");
  return {
    ...(sentence === undefined ? {} : { sentence }),
    ...(explanation === undefined ? {} : { explanation }),
    ...(safetyCategory === undefined ? {} : { safetyCategory }),
  };
}

/**
 * The model switch one of Claude Code's three switch frames reports: a safety fallback keeps its
 * own scope (absent reads `session`), a failed primary holds for the turn, and a declined credits
 * gate holds for the session.
 */
export function readClaudeModelReroute(
  frameKind: string,
  frame: Readonly<Record<string, unknown>>,
): ClaudeModelReroute | undefined {
  const fromModel = readNonEmptyString(frame, "original_model");
  const toModel = readNonEmptyString(frame, "fallback_model");
  if (fromModel === undefined || toModel === undefined) {
    return undefined;
  }
  switch (frameKind) {
    case "system/model_refusal_fallback": {
      const scope = frame["scope"] === "local" ? "local" : "session";
      return { fromModel, toModel, scope, cause: "safety", ...readRefusalWords(frame) };
    }
    case "system/model_fallback": {
      const sentence = readOptionalText(frame, "content");
      return {
        fromModel,
        toModel,
        scope: "turn",
        cause:
          frame["trigger"] === CLAUDE_MODEL_BLOCKED_TRIGGER ? "model_blocked" : "model_unavailable",
        ...(sentence === undefined ? {} : { sentence }),
      };
    }
    case "system/model_consent_fallback": {
      const sentence = readOptionalText(frame, "content");
      return {
        fromModel,
        toModel,
        scope: "session",
        cause: "out_of_credits",
        ...(sentence === undefined ? {} : { sentence }),
      };
    }
    default:
      return undefined;
  }
}

/** The refusal a `model_refusal_no_fallback` frame reports, as `run.failed` carries it. */
export function readClaudeRefusalWithoutFallback(
  frame: Readonly<Record<string, unknown>>,
): RunRefusedCause | undefined {
  const model = readNonEmptyString(frame, "original_model");
  return model === undefined
    ? undefined
    : { cause: "refused", origin: "provider", model, ...readRefusalWords(frame) };
}

/**
 * The refusal an `assistant` frame's message ends on, `stop_reason` `refusal`, with the model that
 * refused and the check's category and explanation from its `stop_details`; Claude Code sends it
 * whether or not a `model_refusal_no_fallback` frame follows.
 */
export function readClaudeAssistantRefusal(
  frame: Readonly<Record<string, unknown>>,
): RunRefusedCause | undefined {
  const message = frame["message"];
  if (!isPlainObject(message) || message["stop_reason"] !== "refusal") {
    return undefined;
  }
  const model = readNonEmptyString(message, "model");
  if (model === undefined) {
    return undefined;
  }
  const details = isPlainObject(message["stop_details"]) ? message["stop_details"] : {};
  const explanation = readOptionalText(details, "explanation");
  const safetyCategory = readNonEmptyString(details, "category");
  return {
    cause: "refused",
    origin: "provider",
    model,
    ...(explanation === undefined ? {} : { explanation }),
    ...(safetyCategory === undefined ? {} : { safetyCategory }),
  };
}

/** The text of an `informational` frame Claude Code sent at level `warning`, else `undefined`. */
export function readClaudeWarning(frame: Readonly<Record<string, unknown>>): string | undefined {
  return frame["level"] === "warning" ? readOptionalText(frame, "content") : undefined;
}

/**
 * The coarse status a `status` frame reports (`compacting`, `requesting`). The frame's `null`,
 * which says the status is over, names no status and reads as `undefined`.
 */
export function readClaudeProviderStatus(
  frame: Readonly<Record<string, unknown>>,
): string | undefined {
  return readNonEmptyString(frame, "status");
}

/** The reason a `worker_shutting_down` frame gives, where it gives one. */
export function readClaudeWorkerShutdownReason(
  frame: Readonly<Record<string, unknown>>,
): string | undefined {
  return readOptionalText(frame, "reason");
}

/**
 * The move a helper's child run makes on its `task_notification`: `completed` ends it as a task,
 * `failed` and `stopped` as such; any other status reads as `undefined`.
 */
export function readClaudeHelperEnd(
  frame: Readonly<Record<string, unknown>>,
  childRunId: RunTransitionRequest["runId"],
): RunTransitionRequest | undefined {
  switch (frame["status"]) {
    case "completed":
      return { runId: childRunId, newState: "completed", completionKind: "task" };
    case "failed": {
      const summary = readOptionalText(frame, "summary");
      return {
        runId: childRunId,
        newState: "failed",
        failureCategory: "provider failure",
        ...(summary === undefined ? {} : { providerFailureDetail: summary }),
      };
    }
    case "stopped":
      return { runId: childRunId, newState: "stopped" };
    default:
      return undefined;
  }
}
