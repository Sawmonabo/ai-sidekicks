// The attention read's harness: one bridge on frozen time, one registry, one probe.
//
// Hoisted out of `attention-read.test.tsx` when a second spec file next door needed
// the same four roles — `apps/desktop/AGENTS.md` puts shared scaffolding in one home
// per role, and the alternative was a second bridge builder free to disagree with
// this one about which clock the read runs on.
//
// Time is frozen throughout. The read is coalesced through the console's one refresh
// scheduler, so a case that did not advance a clock would be asserting about a read
// that has not happened yet rather than about one that never will.

import { act, render } from "@testing-library/react";
import { expect } from "vitest";

import {
  SidekicksBridgeProvider,
  createFixtureBridge,
  growthUnavailable,
  type ConsoleBridge,
} from "../../bridge/index.js";
import { ManualClock, REFRESH_DEBOUNCE_MS } from "../../core/index.js";
import { SessionStoreRegistry } from "../../store/index.js";
import { NotificationCenter } from "./NotificationCenter.js";
import type {
  AttentionProjectionRead,
  AttentionProjectionReader,
} from "./attention-projection-read.js";
import { useAttentionProjection } from "./attention-read.js";
import { settle as settleReactWork } from "../../core/settle.test-support.js";

export const FIRST_SESSION_ID = "session-attention-one";
export const SECOND_SESSION_ID = "session-attention-two";

export function attentionItem(overrides: Readonly<Record<string, unknown>> = {}): unknown {
  return {
    id: "attention-1",
    sessionId: FIRST_SESSION_ID,
    trigger: "pending_approval",
    severity: "actionable",
    summary: "A tool call is waiting on you.",
    sourceEventId: "event-1",
    createdAt: "2026-01-01T10:00:00.000Z",
    ...overrides,
  };
}

/**
 * A read that covered every session it asked about and carried these members.
 *
 * Written once because six cases below need it: the reader answers coverage beside
 * content, and a case spelling out an empty `refusedSessions` each time would be six
 * places to forget which half of the answer it was asserting about.
 */
export function coveredRead(members: readonly unknown[]): AttentionProjectionRead {
  return { members, refusedSessions: [] };
}

/** When the one scripted beat below falls due, for the cases that play it. */
export const BEAT_DUE_MS: number = 1_000;

/**
 * What one scripted beat is, taken from the fixture builder's own parameter.
 *
 * Derived rather than re-declared: the shape belongs to `bridge/scenario-runtime/`,
 * which publishes it to its own family and not through the bridge door, so a hand-
 * written copy here would be a second reading of what a beat is — free to disagree
 * with the engine that plays one.
 */
type ScenarioBeatShape = Parameters<typeof createFixtureBridge>[0]["scenario"]["beats"][number];

/**
 * A scenario beat, so a case can move the bridge's own attention plane.
 *
 * The fixture DERIVES its attention projection from delivered beats, so a beat is
 * the fixture's stand-in for the daemon publishing that a session's attention
 * changed — and it reaches every session the bridge can name rather than only the
 * ones this window has stores for, which is exactly the set the cases below need.
 */
export const ATTENTION_PLANE_BEAT: ScenarioBeatShape = {
  atMs: BEAT_DUE_MS,
  event: {
    id: "019b79ee-0280-7ea1-8110-e5e0d1150901",
    sessionId: FIRST_SESSION_ID,
    sequence: 1,
    kind: "run.starting",
    occurredAt: "2026-01-01T10:06:00.000Z",
  },
};

/** A fixture bridge whose frozen clock the registry and the read both run on. */
export function bridgeOnFrozenTime(beats: readonly ScenarioBeatShape[] = []): {
  bridge: ConsoleBridge;
  clock: ManualClock;
} {
  const bridge = createFixtureBridge({
    scenario: {
      id: "notifications-attention-read-test",
      label: "Nothing scripted",
      purpose: "Drives the attention read against a bridge that plays no beat.",
      sessionId: FIRST_SESSION_ID,
      participantIdsInJoinOrder: [],
      beats,
      replies: [],
      startedAtIso: "2026-01-01T10:05:00.000Z",
    },
  });
  const clock = bridge.scenarioEngine?.clock;
  expect(clock).toBeInstanceOf(ManualClock);
  return { bridge, clock: clock as ManualClock };
}

/**
 * A registry holding one open session, on the same frozen clock.
 *
 * The read is the growth port's own refusal, which is what a window whose bridge
 * cannot serve `sessionRead` is actually given — no store here ever initialises, and
 * none needs to: what this test drives is the CHANGE signal, not the projection.
 */
export function registryHolding(clock: ManualClock): SessionStoreRegistry {
  const registry = new SessionStoreRegistry({ read: growthUnavailable("sessionRead"), clock });
  const store = registry.open(FIRST_SESSION_ID);
  // Given a base state the way a read would, so a later batch PROJECTS rather than
  // buffering behind a read this window cannot perform.
  store.initialise({ cursor: 0, entities: [], participantJoinLog: [] });
  return registry;
}

/** Settle one session event into the open session's projection. */
export function settleSessionEvent(registry: SessionStoreRegistry, sequence: number): void {
  registry.enqueue(FIRST_SESSION_ID, [
    {
      id: `event-${String(sequence)}`,
      sessionId: FIRST_SESSION_ID,
      sequence,
      kind: "run.queued",
      occurredAt: "2026-01-01T10:06:00.000Z",
    },
  ]);
  registry.flush(FIRST_SESSION_ID);
}

/**
 * The surface under test: the read, rendered through the panel that consumes it.
 *
 * Exported because two spec files mount it — one directly, to swap the provider
 * around a probe whose own identity must not move, and one through
 * {@link renderProbe}.
 */
export function AttentionProbe(props: {
  readonly read: AttentionProjectionReader;
  readonly registry: SessionStoreRegistry;
}): React.JSX.Element {
  const { reading, retry } = useAttentionProjection(props.read, props.registry);
  return <NotificationCenter reading={reading} onReopen={retry} />;
}

/**
 * Mount the probe under the bridge provider, which is where a console surface runs.
 *
 * The read takes the window's clock from `useConsoleClock`, and that hook resolves
 * through the provider — so the provider is part of the shape under test rather than
 * harness decoration. Supplied with the same bridge the probe is handed, so a case
 * still drives exactly one transport.
 */
export function renderProbe(
  read: AttentionProjectionReader,
  bridge: ConsoleBridge,
  registry: SessionStoreRegistry,
): ReturnType<typeof render> {
  return render(
    <SidekicksBridgeProvider bridge={bridge}>
      <AttentionProbe read={read} registry={registry} />
    </SidekicksBridgeProvider>,
  );
}

/** Let the read's promise settle after the frozen clock released it. */
export async function settle(): Promise<void> {
  await settleReactWork();
}

/** Move past the coalescing window and let whatever it released land. */
export async function releaseCoalescedRead(clock: ManualClock): Promise<void> {
  await act(async () => {
    clock.advance(REFRESH_DEBOUNCE_MS + 1);
  });
  await settle();
}
