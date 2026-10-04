// Shared scaffolding for the send-router suites: one router builder, stub calls, and the wire
// shapes and ids every case is written against, so the suites cannot drift apart.

import type { InterventionRequestResponse } from "@ai-sidekicks/contracts/run-control";
import type { QueueItemCreateResponse } from "@ai-sidekicks/contracts/run-queue";
import type { Mock } from "vitest";
import type { RecordedDaemonCall } from "@test/helpers/fixture-bridge.js";
import type { ComposerSessionTarget, ComposerRunTarget } from "../composer-target.js";
import type { ComposerSendCalls } from "./send-dispatch.js";
import { ComposerSendRouter } from "./send-router.js";

/** Session id every case is addressed to. */
export const SESSION_ID = "8f1c2c3e-5c6a-4a19-9f5f-1d2b3c4d5e6f";
/** Run id of the steered run. */
export const RUN_ID = "2b3c4d5e-6f7a-4b1c-9d2e-4f5a6b7c8d9e";
/** The idempotency key the router mints in tests. */
export const PINNED_REQUEST_UUID = "3c4d5e6f-7a8b-4c1d-8e2f-5a6b7c8d9e0f";
/** Id of the intervention in `interventionResponse`. */
const INTERVENTION_ID = "4d5e6f7a-8b9c-4d1e-8f2a-6b7c8d9e0f1a";

/**
 * One registered `run.intervene` response, in the shape the wire admits. The router reads its
 * `state` and `runVersion`, so a bare `{}` would refuse every case.
 */
export function interventionResponse(
  state: string,
  runVersion: number,
  extra: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return {
    interventionId: INTERVENTION_ID,
    interventionType: "steer",
    state,
    runVersion,
    ...extra,
  };
}

/** The ordinary answer: the run took the steer and its version moved on. */
export const STEER_APPLIED: Readonly<Record<string, unknown>> = interventionResponse("applied", 8);

/** One registered `run.queueCreate` response, in the shape the wire admits. */
export const QUEUE_CREATED: Readonly<Record<string, unknown>> = {
  queueItemId: "5e6f7a8b-9c0d-4e1f-8a2b-7c8d9e0f1a2b",
  state: "queued",
  createdAt: "2026-09-02T09:00:00.000Z",
};

/** A composer addressed to the session (new-turn path). */
export const SESSION_TARGET: ComposerSessionTarget = {
  path: "session-message",
  sessionId: SESSION_ID,
};

/** A composer bound to a running agent (steer path). */
export const RUN_TARGET: ComposerRunTarget = {
  path: "provider-bound",
  sessionId: SESSION_ID,
  agentId: "agent-implementer",
  driverName: "claude",
  targetRunId: RUN_ID,
  expectedRunVersion: 7,
  providerFailureDetail: undefined,
};

/** Stub send calls that answer as the case says; `answer` gets the method and request. */
export function sendCallsAnswering(
  answer: (call: RecordedDaemonCall) => Promise<unknown>,
): ComposerSendCalls {
  return {
    queueCreate: async (request) =>
      (await answer({ method: "run.queueCreate", params: request })) as QueueItemCreateResponse,
    intervene: async (request) =>
      (await answer({ method: "run.intervene", params: request })) as InterventionRequestResponse,
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
