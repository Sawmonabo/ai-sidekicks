// The three composer-family scenarios, held to the properties a scenario file can
// silently lose.
//
// The wire-truth predicate is the shipped one, driven rather than restated — a test
// carrying its own copy of the rule would go green against a copy nobody ships. What
// this file adds are the three properties that predicate deliberately does not
// cover, because each is a fact about what a scenario is FOR rather than about the
// event contract:
//
//   1. A scripted reply names a call something can actually make. The registry
//      carries no `session.list`, so a reply for it is an answer to a question no
//      surface asks — and the session directory it looks like it serves is served
//      from scenario state by the growth port instead.
//   2. The run streams are fed. `run.subscribeState` and `run.subscribeQueue` route
//      by KIND, so a scenario with no `queue_item.*` beat leaves the queue
//      subscriber silent for the life of the window and its live half unreachable.
//   3. The stated viewer is stated. The fixture answers the caller-identity read
//      from that field alone and refuses when it is absent.

import { describe, expect, it } from "vitest";

import { createFixtureGrowthPort } from "../fixture/fixture-growth-port.js";
import { ScenarioEngine } from "../scenario-runtime/scenario-engine.js";
import { type ConsoleScenario } from "../scenario-runtime/scenario.js";
import {
  RUN_QUEUE_EVENT_STREAM,
  RUN_STATE_EVENT_STREAM,
  subscriptionDeliversEventKind,
} from "../daemon/session-event-streams.js";
import { APPROVALS_SCENARIO } from "./approvals.js";
import { COMPOSER_SCENARIO } from "./composer.js";
import { RUNS_SCENARIO } from "./runs.js";
import { findScenarioWireTruthDefects } from "./wire-truth.js";

/** The three this lane owns, named once so every case below covers all of them. */
const FAMILY_SCENARIOS: readonly ConsoleScenario[] = [
  COMPOSER_SCENARIO,
  RUNS_SCENARIO,
  APPROVALS_SCENARIO,
];

/**
 * Calls no method registry in the corpus carries, so no surface can ever make one.
 *
 * One entry today. `session.list` is the name three of these scenarios shipped with:
 * it reads exactly like a real method, the daemon registry has `session.read` and no
 * list verb, and the directory a surface actually wants comes from the growth
 * operation `sessionList`, which carries no `expectedWireMethod` at all — so it
 * cannot be scripted, and the fixture port derives it from scenario state instead.
 */
const UNREGISTERED_CALLS: readonly string[] = ["session.list"];

/** Every scripted call in a scenario that names no registered method. */
function unregisteredScriptedCalls(scenario: ConsoleScenario): readonly string[] {
  return scenario.replies
    .map((reply) => reply.call)
    .filter((call) => UNREGISTERED_CALLS.includes(call));
}

/** Which of the two run streams a scenario's beats would actually reach. */
function streamsFedBy(scenario: ConsoleScenario): ReadonlySet<string> {
  const fed = new Set<string>();
  for (const beat of scenario.beats) {
    for (const streamName of [RUN_STATE_EVENT_STREAM, RUN_QUEUE_EVENT_STREAM]) {
      if (subscriptionDeliversEventKind(streamName, beat.event.kind)) {
        fed.add(streamName);
      }
    }
  }
  return fed;
}

describe("the composer family's three scenarios are wire-true", () => {
  it("plays only registered event types, with the payloads those types register", () => {
    const defects = findScenarioWireTruthDefects(FAMILY_SCENARIOS);

    // Printed in full rather than counted: the beat and the reason are what a reader
    // needs, not the number of things wrong.
    expect(
      defects.map((defect) => `${defect.scenarioId}: ${defect.subject} — ${defect.reason}`),
    ).toStrictEqual([]);
  });

  it("negative control: the predicate reports the defect these files used to carry", () => {
    // Without this the case above could be passing over a predicate that reports
    // nothing at all. The defect driven here is the exact one this lane repaired —
    // `agent.attached` carrying a `displayName` the wire does not have — expressed
    // on a kind the strict layer DOES register, so the control fails for its own
    // reason rather than for the absence of a variant.
    const defects = findScenarioWireTruthDefects([
      {
        ...COMPOSER_SCENARIO,
        id: "composer-control",
        beats: [
          {
            atMs: 0,
            event: {
              id: "019b7a11-1100-7e00-8110-e5e0c115c001",
              sessionId: COMPOSER_SCENARIO.sessionId,
              sequence: 1,
              kind: "session.created",
              occurredAt: COMPOSER_SCENARIO.startedAtIso,
              payload: { sessionId: COMPOSER_SCENARIO.sessionId, displayName: "Composer" },
            },
          },
        ],
      },
    ]);

    expect(defects).toHaveLength(1);
    expect(defects[0]?.reason).toContain("rejects this beat");
  });
});

describe("every scripted reply names a call something can make", () => {
  it.each(FAMILY_SCENARIOS)("$id scripts no unregistered method", (scenario) => {
    expect(unregisteredScriptedCalls(scenario)).toStrictEqual([]);
  });

  it("negative control: the check reports a scenario that scripts one", () => {
    const control: ConsoleScenario = {
      ...COMPOSER_SCENARIO,
      id: "composer-control",
      replies: [{ call: "session.list", result: { sessions: [] } }],
    };

    expect(unregisteredScriptedCalls(control)).toStrictEqual(["session.list"]);
  });

  it("serves the session directory from scenario state instead", async () => {
    // The half that makes the removal above a repair rather than a deletion: the
    // directory a `session.list` reply looked like it served is served here, from the
    // scenario's own session and without a scripted reply of any kind.
    const port = createFixtureGrowthPort(new ScenarioEngine({ scenario: COMPOSER_SCENARIO }));
    const outcome = await port.sessionList({});

    expect(outcome.status).toBe("served");
    expect(
      outcome.status === "served" ? outcome.value.map((row) => row.sessionId) : [],
    ).toStrictEqual([COMPOSER_SCENARIO.sessionId]);
  });
});

describe("the runs scenario feeds both run subscriptions", () => {
  it("routes beats to the state stream and to the queue stream", () => {
    // Two streams, not one. A scenario whose beats reach only the state stream
    // leaves the queue subscriber silent, and the queue's live half — a row
    // arriving, a row admitted, a row expiring — cannot be rendered at all.
    expect([...streamsFedBy(RUNS_SCENARIO)].sort()).toStrictEqual(
      [RUN_QUEUE_EVENT_STREAM, RUN_STATE_EVENT_STREAM].sort(),
    );
  });

  it("reaches the rewind arm, which carries no state transition", () => {
    const rewind = RUNS_SCENARIO.beats.find((beat) => beat.event.kind === "run.rolled_back");

    expect(rewind).toBeDefined();
    // `RunRolledBackEvent` deliberately carries no `previousState` / `newState`,
    // because a rollback is not a transition; a beat that carried them would train a
    // consumer to fabricate one.
    const payload = rewind?.event.payload as Record<string, unknown> | undefined;
    expect(payload?.["targetPosition"]).toBeTypeOf("number");
    expect(payload?.["previousState"]).toBeUndefined();
    expect(payload?.["newState"]).toBeUndefined();
  });

  it("negative control: a scenario with no run beats feeds neither stream", () => {
    // Built by REMOVING the run beats from a real scenario rather than by naming one
    // that happens to have none: the approvals scenario was that scenario until it
    // grew the `run.running` beat its execution-boundary section reads a posture
    // from, and a control whose premise is another file's contents goes stale the
    // moment that file gains a beat. Derived like this it cannot.
    const withoutRunBeats: ConsoleScenario = {
      ...APPROVALS_SCENARIO,
      id: "approvals-without-run-beats",
      beats: APPROVALS_SCENARIO.beats.filter((beat) => !beat.event.kind.startsWith("run.")),
    };

    expect([...streamsFedBy(withoutRunBeats)]).toStrictEqual([]);
    // And the scenario it was derived from does feed one, which is what makes the
    // filter above the thing being tested rather than a no-op.
    expect([...streamsFedBy(APPROVALS_SCENARIO)]).toStrictEqual([RUN_STATE_EVENT_STREAM]);
  });
});

describe("every scenario states which participant this window is", () => {
  it.each(FAMILY_SCENARIOS)("$id names a viewer inside its own roster", (scenario) => {
    expect(scenario.viewingParticipantId).toBeDefined();
    expect(scenario.participantIdsInJoinOrder).toContain(scenario.viewingParticipantId);
  });

  it("negative control: the caller-identity read refuses when none is stated", async () => {
    // The state a scenario without a viewer leaves every role-resolving surface in,
    // driven through the real port so the assertion is about the shipped rule.
    // Spelled out rather than spread-with-`undefined`: `exactOptionalPropertyTypes`
    // makes an explicit `undefined` a different thing from an absent member, and the
    // absent one is the state under test.
    const withoutViewer: ConsoleScenario = {
      id: `${COMPOSER_SCENARIO.id}-viewerless`,
      label: COMPOSER_SCENARIO.label,
      purpose: COMPOSER_SCENARIO.purpose,
      sessionId: COMPOSER_SCENARIO.sessionId,
      participantIdsInJoinOrder: COMPOSER_SCENARIO.participantIdsInJoinOrder,
      beats: COMPOSER_SCENARIO.beats,
      replies: COMPOSER_SCENARIO.replies,
      startedAtIso: COMPOSER_SCENARIO.startedAtIso,
    };
    const port = createFixtureGrowthPort(new ScenarioEngine({ scenario: withoutViewer }));
    const outcome = await port.callerParticipantRead({ sessionId: COMPOSER_SCENARIO.sessionId });

    expect(outcome.status).toBe("unavailable");
  });

  it("answers the caller-identity read when one is stated", async () => {
    const port = createFixtureGrowthPort(new ScenarioEngine({ scenario: COMPOSER_SCENARIO }));
    const outcome = await port.callerParticipantRead({ sessionId: COMPOSER_SCENARIO.sessionId });

    expect(outcome.status).toBe("served");
    expect(outcome.status === "served" ? outcome.value.participantId : undefined).toBe(
      COMPOSER_SCENARIO.viewingParticipantId,
    );
  });
});
