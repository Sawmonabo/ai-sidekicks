// Codex's notices: a warning or a deprecation is the provider's own warning, a config warning is
// the setting Codex ignored, and a model switch waits for the warning Codex sends next on its
// thread, which is that switch's sentence and never a warning of its own.

import type { SessionNoticePayload } from "@ai-sidekicks/contracts/session/controls/events";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import { isPlainObject, readNonEmptyString } from "../../../record-readers.js";
import type { CodexDeliveryMemory } from "./memory.js";
import type { CodexRowDelivery, CodexRowRun } from "./rows.js";

/** What a `warning` frame became: its reroute's row, the session's notice, or nothing. */
export type CodexWarningReading =
  | { readonly kind: "reroute"; readonly delivery: CodexRowDelivery }
  | { readonly kind: "notice"; readonly notice: SessionNoticePayload }
  | { readonly kind: "none" };

// Codex's one reroute reason, a cyber-safety check.
const CODEX_CYBER_REROUTE_REASON = "highRiskCyberActivity";

/**
 * Holds a `model/rerouted` row on its thread for the warning that carries its sentence. A second
 * switch on the thread before that warning sends the first without one.
 */
export function holdReroute(
  memory: CodexDeliveryMemory,
  params: unknown,
  run: CodexRowRun,
): CodexRowDelivery | undefined {
  const payload = isPlainObject(params) ? params : {};
  const threadId = readNonEmptyString(payload, "threadId");
  const fromModel = readNonEmptyString(payload, "fromModel");
  const toModel = readNonEmptyString(payload, "toModel");
  if (threadId === undefined || fromModel === undefined || toModel === undefined) {
    return undefined;
  }
  const replaced = memory.pendingRerouteByThreadId.get(threadId);
  memory.pendingRerouteByThreadId.set(threadId, {
    bindingId: run.bindingId,
    operation: undefined,
    row: {
      type: "usage.model_rerouted",
      payload: {
        sessionId: run.sessionId,
        runId: run.runId,
        fromModel,
        toModel,
        scope: "turn",
        cause: "safety",
        ...(payload["reason"] === CODEX_CYBER_REROUTE_REASON ? { safetyCategory: "cyber" } : {}),
      },
    },
    body: undefined,
    method: "model/rerouted",
  });
  return replaced;
}

/** Sends the reroute still waiting on a thread whose turn ended without its sentence. */
export function releaseReroute(
  memory: CodexDeliveryMemory,
  threadId: string,
): CodexRowDelivery | undefined {
  const held = memory.pendingRerouteByThreadId.get(threadId);
  memory.pendingRerouteByThreadId.delete(threadId);
  return held;
}

/** Reads a `warning`: the sentence of the reroute waiting on its thread, else the session's. */
export function readCodexWarning(
  memory: CodexDeliveryMemory,
  sessionId: SessionId,
  params: unknown,
): CodexWarningReading {
  const payload = isPlainObject(params) ? params : {};
  const message = readNonEmptyString(payload, "message");
  if (message === undefined) {
    return { kind: "none" };
  }
  const threadId = readNonEmptyString(payload, "threadId");
  const reroute = threadId === undefined ? undefined : releaseReroute(memory, threadId);
  if (reroute !== undefined && reroute.row.type === "usage.model_rerouted") {
    return {
      kind: "reroute",
      delivery: {
        ...reroute,
        row: { ...reroute.row, payload: { ...reroute.row.payload, sentence: message } },
      },
    };
  }
  return {
    kind: "notice",
    notice: { sessionId, kind: "provider_warning", source: "warning", text: message },
  };
}

/** Reads a `deprecationNotice` as the session's provider warning, or `undefined`. */
export function readCodexDeprecationNotice(
  sessionId: SessionId,
  params: unknown,
): SessionNoticePayload | undefined {
  const payload = isPlainObject(params) ? params : {};
  const summary = readNonEmptyString(payload, "summary");
  if (summary === undefined) {
    return undefined;
  }
  const details = readNonEmptyString(payload, "details");
  return {
    sessionId,
    kind: "provider_warning",
    source: "deprecation",
    text: summary,
    ...(details === undefined ? {} : { details }),
  };
}

/**
 * Reads a `configWarning` as the setting Codex ignored, by its file and first line; one that names
 * no file and line is a warning in Codex's own words. `undefined` when it carries no words either.
 */
export function readCodexConfigWarning(
  sessionId: SessionId,
  params: unknown,
): SessionNoticePayload | undefined {
  const payload = isPlainObject(params) ? params : {};
  const file = readNonEmptyString(payload, "path");
  const range = payload["range"];
  const start = isPlainObject(range) ? range["start"] : undefined;
  const line = isPlainObject(start) ? start["line"] : undefined;
  if (file !== undefined && typeof line === "number" && Number.isInteger(line) && line >= 1) {
    return { sessionId, kind: "settings_ignored", provider: "codex", file, line };
  }
  const summary = readNonEmptyString(payload, "summary");
  if (summary === undefined) {
    return undefined;
  }
  const details = readNonEmptyString(payload, "details");
  return {
    sessionId,
    kind: "provider_warning",
    source: "warning",
    text: summary,
    ...(details === undefined ? {} : { details }),
  };
}
