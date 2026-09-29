// The send router's shared scaffolding: one router, one set of stub calls, one ledger —
// and the composer family's one copy of the wire shapes a send travels on.
//
// Lives here because both suites build the SAME router — resolution and dispatch are
// two halves of one send — and a second builder written beside one of them would let
// the two drift into routers that resolve alike and dispatch differently.
//
// THE REGISTERED REPLIES AND THE IDS ARE HERE FOR THE SAME REASON, and every suite in
// this directory takes them from here, so one `QUEUE_CREATED`, one `STEER_APPLIED` and
// one `SESSION_ID` are what every case is written against.

import type { InterventionRequestResponse, QueueItemCreateResponse } from "@ai-sidekicks/contracts";
import type { Mock } from "vitest";
import type { RecordedDaemonCall } from "@renderer/console/bridge/fixture/call-plane/bridge.test-support.js";
import type {
  ComposerChannelTarget,
  ComposerRunTarget,
} from "@renderer/shell/composer/chips/chip-models.js";
import type { ComposerSendCalls } from "./send-dispatch.js";
import { ComposerSendRouter } from "./send-router.js";

export const SESSION_ID = "8f1c2c3e-5c6a-4a19-9f5f-1d2b3c4d5e6f";
export const RUN_ID = "2b3c4d5e-6f7a-4b1c-9d2e-4f5a6b7c8d9e";
export const PINNED_REQUEST_UUID = "3c4d5e6f-7a8b-4c1d-8e2f-5a6b7c8d9e0f";
export const INTERVENTION_ID = "4d5e6f7a-8b9c-4d1e-8f2a-6b7c8d9e0f1a";

/**
 * One registered `run.intervene` response, in the shape the wire actually admits.
 *
 * The steer arm and not a bare `{}`: the router parses this reply, so a stand-in
 * that did not parse would put every case below on the unreadable arm and prove
 * nothing about the state the daemon reported.
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

/**
 * One registered `run.queueCreate` response, in the shape the wire actually admits.
 *
 * The new-turn path parses its reply for the same reason the steer path does, so a
 * bare `{}` here would put every new-turn case below on the unreadable arm
 * and prove nothing about the message having been queued.
 */
export const QUEUE_CREATED: Readonly<Record<string, unknown>> = {
  queueItemId: "5e6f7a8b-9c0d-4e1f-8a2b-7c8d9e0f1a2b",
  state: "queued",
  createdAt: "2026-09-02T09:00:00.000Z",
};

export const CHANNEL_TARGET: ComposerChannelTarget = {
  path: "channel-message",
  sessionId: SESSION_ID,
};

export const RUN_TARGET: ComposerRunTarget = {
  path: "provider-bound",
  sessionId: SESSION_ID,
  agentId: "agent-implementer",
  driverName: "claude",
  targetRunId: RUN_ID,
  expectedRunVersion: 7,
  providerFailureDetail: undefined,
};

/** The daemon-call mock these cases assert on, called as `(method, params)`. */
export type DaemonCallMock = Mock & ((method: string, params: unknown) => Promise<unknown>);

/**
 * Stub send calls that answer as the case says, whatever the case answers with.
 *
 * Each call is handed to `answer` as the method it stands for and the request it was
 * given, so a case scripts a reply, a park or a rejection in one place.
 */
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

export function routerWith(
  call: DaemonCallMock,
  recognized: readonly string[] = [],
  published: readonly string[] = [],
): ComposerSendRouter {
  return new ComposerSendRouter({
    calls: sendCallsAnswering(async (recorded) => call(recorded.method, recorded.params)),
    recognizeClientCommand: (name) => recognized.includes(name),
    recognizeProviderCommand: (name) =>
      published.includes(name)
        ? { name, kind: "command" as const, driverName: "claude" }
        : undefined,
    mintIdempotencyKey: () => PINNED_REQUEST_UUID,
  });
}
