// Shared scaffolding for the send-router suites: one router builder, stub calls, and the wire
// shapes and ids every case is written against, so the suites cannot drift apart.

import type { QueueItemCreateResponse } from "@ai-sidekicks/contracts/run/queue";
import type { Mock } from "vitest";
import type { RecordedDaemonCall } from "#test/helpers/fixture/bridge.js";
import type { ComposerSessionTarget, ComposerRunTarget } from "../../target.js";
import type { ComposerSendCalls } from "./dispatch.js";
import { ComposerSendRouter } from "./router.js";

/** Session id every case is addressed to. */
export const SESSION_ID = "8f1c2c3e-5c6a-4a19-9f5f-1d2b3c4d5e6f";
/** The idempotency key the router mints in tests. */
export const PINNED_REQUEST_UUID = "3c4d5e6f-7a8b-4c1d-8e2f-5a6b7c8d9e0f";

/** One registered `run.queueCreate` response, in the shape the wire admits. */
export const QUEUE_CREATED: Readonly<Record<string, unknown>> = {
  queueItemId: "5e6f7a8b-9c0d-4e1f-8a2b-7c8d9e0f1a2b",
  state: "queued",
  createdAt: "2026-09-02T09:00:00.000Z",
};

/** A composer addressed to the session. */
export const SESSION_TARGET: ComposerSessionTarget = {
  kind: "session",
  sessionId: SESSION_ID,
};

/** A composer bound to a running agent, whose message waits for the agent's next step. */
export const RUN_TARGET: ComposerRunTarget = {
  kind: "run",
  sessionId: SESSION_ID,
  agentId: "agent-implementer",
  driverName: "claude",
  targetRunId: "2b3c4d5e-6f7a-4b1c-9d2e-4f5a6b7c8d9e",
};

/** Stub send calls that answer as the case says; `answer` gets the method and request. */
export function sendCallsAnswering(
  answer: (call: RecordedDaemonCall) => Promise<unknown>,
): ComposerSendCalls {
  return {
    queueCreate: async (request) =>
      (await answer({ method: "run.queueCreate", params: request })) as QueueItemCreateResponse,
  };
}

/** A router over one daemon-call mock, recognizing the given console command names. */
export function routerWith(
  call: DaemonCallMock,
  recognized: readonly string[] = [],
): ComposerSendRouter {
  return new ComposerSendRouter({
    calls: sendCallsAnswering(async (recorded) => call(recorded.method, recorded.params)),
    recognizeConsoleCommand: (name) => recognized.includes(name),
    mintIdempotencyKey: () => PINNED_REQUEST_UUID,
  });
}

/** The daemon-call mock these cases assert on, called as `(method, params)`. */
type DaemonCallMock = Mock & ((method: string, params: unknown) => Promise<unknown>);
