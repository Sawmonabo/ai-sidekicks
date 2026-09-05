// The send router's shared scaffolding: one router, one fixture bridge, one ledger —
// and the composer family's one copy of the wire shapes a send travels on.
//
// Lives here because both suites build the SAME router — resolution and dispatch are
// two halves of one send — and a second builder written beside one of them would let
// the two drift into routers that resolve alike and dispatch differently.
//
// THE REGISTERED REPLIES AND THE IDS ARE HERE FOR THE SAME REASON, and every suite in
// this directory takes them from here. There had been three `QUEUE_CREATED` literals,
// two `STEER_APPLIED`s that disagreed about `runVersion`, and three `SESSION_ID`s —
// which is three chances for a case to be written against a reply the wire would
// refuse, and to pass on the unreadable-reply arm while reading like a success.

import type { Mock } from "vitest";
import type { ConsoleBridge } from "../../../console/bridge/index.js";
import {
  createFixture,
  withDaemonCall,
} from "../../../console/bridge/fixture-bridge.test-support.js";
import type { ComposerChannelTarget, ComposerRunTarget } from "../chips/chip-models.js";
import { ComposerSendRouter } from "./send-router.js";

export const SESSION_ID = "8f1c2c3e-5c6a-4a19-9f5f-1d2b3c4d5e6f";
export const CHANNEL_ID = "1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d";
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
 * bare `{}` here would put every channel-addressed case below on the unreadable arm
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
  channelId: CHANNEL_ID,
  workspaceId: undefined,
  channelLabel: "main",
};

export const RUN_TARGET: ComposerRunTarget = {
  path: "provider-bound",
  sessionId: SESSION_ID,
  agentId: "agent-implementer",
  agentName: "Ada",
  driverName: "claude",
  targetRunId: RUN_ID,
  expectedRunVersion: 7,
  runState: "running",
  providerFailureDetail: undefined,
};

/**
 * The daemon-call mock these cases assert on.
 *
 * Spelled as an intersection rather than as `ReturnType<typeof vi.fn>`: that type is
 * `Mock<Procedure | Constructable>`, which records calls but is not callable, and the
 * old builder only ever ASSIGNED the mock into a literal so it never had to be. The
 * call arm now invokes it, so the callable half has to be declared.
 */
export type DaemonCallMock = Mock & ((method: string, params: unknown) => Promise<unknown>);

/**
 * A real bridge whose daemon call this suite's mock answers.
 *
 * A spread over the family's own fixture through `withDaemonCall`, rather than an
 * object cast to the bridge type. What is under test here is that the router reaches
 * the wire through `bridge.sidekicks.daemon.call` and nothing else — and a case
 * passing against a hand-built literal would not have proved it reached a bridge at
 * all, only that it called the one member the literal happened to carry.
 *
 * The mock keeps its `(method, params)` arity, which is the shape the cases assert.
 */
export function bridgeRecording(call: DaemonCallMock): ConsoleBridge {
  return withDaemonCall(createFixture().bridge, async (recorded) =>
    call(recorded.method, recorded.params),
  ).bridge;
}

export function routerWith(
  call: DaemonCallMock,
  recognized: readonly string[] = [],
  published: readonly string[] = [],
): ComposerSendRouter {
  return new ComposerSendRouter({
    bridge: bridgeRecording(call),
    recognizeClientCommand: (name) => recognized.includes(name),
    recognizeProviderCommand: (name) =>
      published.includes(name)
        ? { name, kind: "command" as const, driverName: "claude" }
        : undefined,
    mintIdempotencyKey: () => PINNED_REQUEST_UUID,
  });
}
