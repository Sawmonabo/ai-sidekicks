// The fixture's attention projection — derived from the scenario, never invented.
//
// It sits apart from the served-set sweep in `fixture-growth-port.test.ts` because
// its subject is different: that sweep checks WHICH operations answer, and these
// check WHAT the answer says. The projection is the one served value the console
// must not compute for itself (Plan-019 I-019-4), so a fixture that answered
// plausibly-but-wrongly would train every attention surface against a projection no
// daemon will ever send.
//
// The flagship arm is honestly empty, which on its own would pass over a port that
// returned `[]` for everything. So the derivation is driven over scenarios built
// here that DO reach an attention state — held to the same wire-truth predicate the
// shipped scenarios are held to, `findScenarioWireTruthDefects`, so the beats are
// events a daemon can emit rather than plausible-looking inventions.

import { describe, expect, it } from "vitest";

import type { AttentionItem } from "../wire-shapes/attention-projection.js";
import { createFixtureBridge } from "./fixture-bridge.js";
import type { GrowthPort } from "../index.js";
import type { ConsoleScenario, ScenarioBeat } from "../scenario-runtime/scenario.js";
import { FLAGSHIP_SCENARIO } from "../scenarios/flagship.js";
import { findScenarioWireTruthDefects } from "../scenarios/wire-truth.js";

const ATTENTION_SESSION_ID = "019b7a11-0280-75e5-8510-ada11a5a33a5";
const ATTENTION_PARTICIPANT_ID = "019b7a11-0280-79a4-8110-cca0117a0330";
const RUN_AWAITING_APPROVAL = "019b7a11-0280-740e-8110-d1a4c1150021";
const RUN_FINISHED = "019b7a11-0280-740e-8120-d1a4c1150022";
const RUN_FAILED = "019b7a11-0280-740e-8130-d1a4c1150023";

/**
 * The instant this scenario's beats are offset from.
 *
 * Built with `Date.UTC` rather than parsed, so the fixture never asks a second
 * reader what `core/instant.ts` is the one reader for.
 */
const ATTENTION_SCENARIO_STARTED_AT_MILLISECONDS = Date.UTC(2026, 0, 1, 16, 0, 0);

/**
 * The daemon's opaque row id for the beat at `sequence`.
 *
 * A UUID v7 like every identifier the shipped scenarios carry, and deliberately
 * NOT a function of the session id and the sequence: the assertions below prove
 * an item's `sourceEventId` is the triggering event's OWN id, and a composed one
 * would let the derivation keep composing and still pass.
 */
function eventIdFor(sequence: number): string {
  return `019b7a11-0280-7ea1-8110-e5e0d115${String(sequence).padStart(4, "0")}`;
}

/** One run state transition, in the shape the shipped scenarios script them. */
function runTransition(
  atMs: number,
  sequence: number,
  runId: string,
  previousState: string,
  newState: string,
): ScenarioBeat {
  return {
    atMs,
    event: {
      id: eventIdFor(sequence),
      sessionId: ATTENTION_SESSION_ID,
      sequence,
      kind: `run.${newState}`,
      occurredAt: new Date(ATTENTION_SCENARIO_STARTED_AT_MILLISECONDS + atMs).toISOString(),
      payload: {
        sessionId: ATTENTION_SESSION_ID,
        runId,
        runVersion: sequence,
        previousState,
        newState,
      },
    },
  };
}

/**
 * A session whose two runs reach two different attention states.
 *
 * One run waits for an approval and one finishes, so the projection has to carry an
 * actionable contributor and an informational one at once — which is the only shape
 * in which the aggregate's severity rule and its representative-selection rule can
 * both be wrong without the other noticing.
 */
function twoRunAttentionScenario(extraBeats: readonly ScenarioBeat[] = []): ConsoleScenario {
  return {
    id: "attention-two-runs",
    label: "Two runs, two kinds of attention",
    purpose:
      "Drives the fixture's attention derivation over an actionable and an informational contributor.",
    sessionId: ATTENTION_SESSION_ID,
    participantIdsInJoinOrder: [ATTENTION_PARTICIPANT_ID],
    startedAtIso: "2026-01-01T16:00:00.000Z",
    beats: [
      runTransition(100, 1, RUN_FINISHED, "running", "completed"),
      runTransition(200, 2, RUN_AWAITING_APPROVAL, "running", "waiting_for_approval"),
      ...extraBeats,
    ],
    replies: [],
  };
}

/**
 * A session whose one run fails, so the failure is the whole projection.
 *
 * One contributor and not two, deliberately: with an actionable contributor beside it
 * the aggregate would be actionable whatever this fold decided about a failure, so the
 * severity the aggregate carries here is the failure's own.
 */
function failedRunScenario(extraBeats: readonly ScenarioBeat[] = []): ConsoleScenario {
  return {
    id: "attention-run-failed",
    label: "One run, and it failed",
    purpose: "Drives the fixture's attention derivation over a terminal run failure.",
    sessionId: ATTENTION_SESSION_ID,
    participantIdsInJoinOrder: [ATTENTION_PARTICIPANT_ID],
    startedAtIso: "2026-01-01T16:00:00.000Z",
    beats: [runTransition(100, 1, RUN_FAILED, "running", "failed"), ...extraBeats],
    replies: [],
  };
}

/** The port and the engine for one scenario, so a test can advance playback itself. */
function playScenario(scenario: ConsoleScenario): {
  readonly port: GrowthPort;
  readonly advanceToEnd: () => void;
} {
  const bridge = createFixtureBridge({ scenario });
  const engine = bridge.scenarioEngine;
  if (engine === undefined) {
    throw new Error("the fixture bridge built no scenario engine");
  }
  return { port: bridge.growth, advanceToEnd: () => engine.runToCompletion() };
}

/** The served projection's items, or a failure naming the refusal instead. */
async function readAttentionItems(
  port: GrowthPort,
  sessionId: string,
): Promise<readonly AttentionItem[]> {
  const outcome = await port.attentionProjectionRead({ sessionId });
  if (outcome.status !== "served") {
    throw new Error(`the fixture refused the attention read: ${outcome.detail}`);
  }
  return outcome.value.items;
}

describe("the fixture's attention projection — derived from the scenario, never invented", () => {
  it("serves an empty projection for the flagship, whose runs never reach an attention state", async () => {
    // Honest emptiness, not a stub: the flagship's newest run transition is
    // `starting`, which `Spec-019 §Default Behavior` classifies as neither
    // actionable nor informational. The scenario is read for that fact here rather
    // than asserted about, and the cases below prove the fold is not simply inert.
    const { port, advanceToEnd } = playScenario(FLAGSHIP_SCENARIO);
    advanceToEnd();

    const newestRunState = FLAGSHIP_SCENARIO.beats
      .map((beat) => beat.event.payload?.["newState"])
      .filter((state): state is string => typeof state === "string")
      .at(-1);

    expect(newestRunState).toBe("starting");
    expect(await readAttentionItems(port, FLAGSHIP_SCENARIO.sessionId)).toStrictEqual([]);
  });

  it("scripts beats a daemon can actually emit, so the cases below are not about a fake wire", () => {
    expect(findScenarioWireTruthDefects([twoRunAttentionScenario()])).toStrictEqual([]);
  });

  it("derives one item per run in an attention state, with the severity the spec assigns", async () => {
    const { port, advanceToEnd } = playScenario(twoRunAttentionScenario());
    advanceToEnd();

    const items = await readAttentionItems(port, ATTENTION_SESSION_ID);
    const byRunId = new Map(
      items.filter((item) => item.runId !== undefined).map((item) => [item.runId, item]),
    );

    expect(byRunId.get(RUN_AWAITING_APPROVAL)).toMatchObject({
      trigger: "pending_approval",
      severity: "actionable",
      sessionId: ATTENTION_SESSION_ID,
    });
    expect(byRunId.get(RUN_FINISHED)).toMatchObject({
      trigger: "run_completed",
      severity: "informational",
    });
    // The canonical event each item came from — the triggering beat's OWN opaque
    // id, read off the scenario rather than restated as a literal. This is the
    // value `hydratedEventRead({sessionId, eventId})` takes, so an item that
    // named anything else would hand every attention surface a dead handle.
    const approvalBeat = twoRunAttentionScenario().beats.find(
      (beat) => beat.event.payload?.["runId"] === RUN_AWAITING_APPROVAL,
    );
    expect(approvalBeat).toBeDefined();
    expect(byRunId.get(RUN_AWAITING_APPROVAL)?.sourceEventId).toBe(approvalBeat?.event.id);
  });

  it("negative control: the id is the beat's own, not one composed from session and sequence", async () => {
    // The case above would pass over a derivation that composed
    // `${sessionId}:${sequence}` if the scenario's ids happened to be spelled
    // that way. They are not — `eventIdFor` mints a UUID unrelated to both — so
    // this pins the two apart: a composed id resolves through no read, and the
    // set of ids the projection carries must be a subset of the ids the script
    // actually played.
    const scenario = twoRunAttentionScenario();
    const { port, advanceToEnd } = playScenario(scenario);
    advanceToEnd();

    const items = await readAttentionItems(port, ATTENTION_SESSION_ID);
    const scriptedEventIds = new Set(scenario.beats.map((beat) => beat.event.id));
    const composedIds = new Set(
      scenario.beats.map((beat) => `${ATTENTION_SESSION_ID}:${String(beat.event.sequence)}`),
    );

    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(scriptedEventIds.has(item.sourceEventId)).toBe(true);
      expect(composedIds.has(item.sourceEventId)).toBe(false);
    }
  });

  it("carries the session aggregate as the item with no run, actionable while any contributor is", async () => {
    const { port, advanceToEnd } = playScenario(twoRunAttentionScenario());
    advanceToEnd();

    const items = await readAttentionItems(port, ATTENTION_SESSION_ID);
    const aggregate = items.find((item) => item.runId === undefined);
    const actionableContributor = items.find(
      (item) => item.runId !== undefined && item.severity === "actionable",
    );

    expect(aggregate).toBeDefined();
    // One actionable contributor out of two makes the aggregate actionable, and the
    // representative is that contributor — highest severity first. Both halves are
    // read off the contributors rather than restated as literals, so the assertion
    // fails if the aggregate ever names the informational one.
    expect(aggregate?.severity).toBe("actionable");
    expect(aggregate?.trigger).toBe(actionableContributor?.trigger);
    expect(aggregate?.sourceEventId).toBe(actionableContributor?.sourceEventId);
  });

  it("resolves an item when its run leaves the attention state, and drops the aggregate with the last one", async () => {
    // The resolution half. Without it the fold would be append-only and a session
    // would stay actionable forever after one approval request.
    const resolved = twoRunAttentionScenario([
      runTransition(300, 3, RUN_AWAITING_APPROVAL, "waiting_for_approval", "running"),
    ]);
    const { port, advanceToEnd } = playScenario(resolved);
    advanceToEnd();

    const items = await readAttentionItems(port, ATTENTION_SESSION_ID);

    expect(items.filter((item) => item.runId === RUN_AWAITING_APPROVAL)).toStrictEqual([]);
    // The finished run still contributes, so the aggregate survives and downgrades
    // rather than vanishing — a vanished aggregate would read as "nothing happened".
    expect(items.find((item) => item.runId === undefined)?.severity).toBe("informational");
  });

  it("raises one informational item for a run that failed, keyed to that run and its own event", async () => {
    // The state the projection exists for, and the one it used to drop: before this
    // classification a `run.failed` beat fell through the fold's delete branch, so a
    // scenario that played a failure served an EMPTY projection and every
    // failure-oriented surface would have been built against it. `Spec-019 §Required
    // Behavior` makes run failure a required trigger, and a terminal run blocks on no
    // participant, so the severity is the informational one that spec's own class
    // definition assigns.
    const scenario = failedRunScenario();
    const { port, advanceToEnd } = playScenario(scenario);
    advanceToEnd();

    const items = await readAttentionItems(port, ATTENTION_SESSION_ID);
    const runScoped = items.filter((item) => item.runId !== undefined);
    const failingBeat = scenario.beats.find((beat) => beat.event.payload?.["runId"] === RUN_FAILED);

    expect(runScoped).toHaveLength(1);
    expect(runScoped[0]).toMatchObject({
      id: `${RUN_FAILED}:run_failed`,
      runId: RUN_FAILED,
      trigger: "run_failed",
      severity: "informational",
      sessionId: ATTENTION_SESSION_ID,
    });
    // The failing event's OWN opaque id, which is what `hydratedEventRead` takes.
    expect(failingBeat).toBeDefined();
    expect(runScoped[0]?.sourceEventId).toBe(failingBeat?.event.id);
  });

  it("folds the failure into the session aggregate as informational when nothing else is actionable", async () => {
    const { port, advanceToEnd } = playScenario(failedRunScenario());
    advanceToEnd();

    const aggregate = (await readAttentionItems(port, ATTENTION_SESSION_ID)).find(
      (item) => item.runId === undefined,
    );

    expect(aggregate).toMatchObject({ trigger: "run_failed", severity: "informational" });
  });

  it("negative control: an outstanding approval still makes that same aggregate actionable", async () => {
    // D-019-2's rule, driven from the other side. Without this the case above would
    // hold over a fold that returned `informational` for every aggregate — which would
    // hide exactly the blocking state the two severities exist to separate.
    const withFailure = twoRunAttentionScenario([
      runTransition(300, 3, RUN_FAILED, "running", "failed"),
    ]);
    const { port, advanceToEnd } = playScenario(withFailure);
    advanceToEnd();

    const items = await readAttentionItems(port, ATTENTION_SESSION_ID);

    expect(items.filter((item) => item.runId === RUN_FAILED)).toHaveLength(1);
    expect(items.find((item) => item.runId === undefined)?.severity).toBe("actionable");
  });

  it("clears the failure through the one exit the state machine gives a terminal run", async () => {
    // The delete branch, unchanged and proven still to be reachable from this new
    // entry. `failed` is terminal, and the run state machine's transition table gives
    // it exactly one exit — the rollback intervention re-opening the run at `paused`,
    // which this table classifies as no attention at all. A fold that had learned to
    // raise a failure and not to resolve one would leave the session marked forever.
    const rolledBack = failedRunScenario([runTransition(200, 2, RUN_FAILED, "failed", "paused")]);
    const { port, advanceToEnd } = playScenario(rolledBack);
    advanceToEnd();

    expect(await readAttentionItems(port, ATTENTION_SESSION_ID)).toStrictEqual([]);
  });

  it("scripts the failure beats a daemon can emit, so the four cases above are not about a fake wire", () => {
    expect(
      findScenarioWireTruthDefects([
        failedRunScenario(),
        failedRunScenario([runTransition(200, 2, RUN_FAILED, "failed", "paused")]),
        twoRunAttentionScenario([runTransition(300, 3, RUN_FAILED, "running", "failed")]),
      ]),
    ).toStrictEqual([]);
  });

  it("reflects playback position, so attention arrives as the frozen clock reaches it", async () => {
    const { port, advanceToEnd } = playScenario(twoRunAttentionScenario());

    const beforeAnyBeat = await readAttentionItems(port, ATTENTION_SESSION_ID);
    advanceToEnd();
    const afterEveryBeat = await readAttentionItems(port, ATTENTION_SESSION_ID);

    // A projection computed from the whole script would be identical at both
    // points, which is exactly the fixture that cannot show a surface a state
    // arriving.
    expect(beforeAnyBeat).toStrictEqual([]);
    expect(afterEveryBeat.length).toBeGreaterThan(0);
  });

  it("answers for a session it is not playing, and answers that there is nothing", async () => {
    const { port, advanceToEnd } = playScenario(twoRunAttentionScenario());
    advanceToEnd();

    const outcome = await port.attentionProjectionRead({ sessionId: FLAGSHIP_SCENARIO.sessionId });

    // Served, not refused: the operation IS answered here, and what it found for
    // another session is nothing. A refusal would say the wire is missing, which
    // under this bridge is false.
    expect(outcome.status).toBe("served");
    if (outcome.status === "served") {
      expect(outcome.value.items).toStrictEqual([]);
    }
  });

  it("refuses the preference pair, which no store backs under either bridge", async () => {
    const { port } = playScenario(twoRunAttentionScenario());

    for (const outcome of [
      await port.attentionPreferenceRead({ participantId: ATTENTION_PARTICIPANT_ID }),
      await port.attentionPreferenceUpdate({
        participantId: ATTENTION_PARTICIPANT_ID,
        key: "mute-all",
        value: { enabled: true },
      }),
    ]) {
      expect(outcome.status).toBe("unavailable");
      if (outcome.status === "unavailable") {
        expect(outcome.slateRow).toBe("attention-plane");
        expect(outcome.owningDocument).toContain("Spec-019");
      }
    }
  });
});
