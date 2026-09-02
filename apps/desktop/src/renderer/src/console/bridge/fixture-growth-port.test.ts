// What the fixture serves, and that its claim about it is true.
//
// Two claims travel separately and have to agree: the port ANSWERS two operations,
// and the bridge PUBLISHES a set naming them. The composition root reads the set
// synchronously to decide whether to build a registry that can read at all, so a
// set that over-claims would have the console bind a stream to a store nothing can
// initialise, and a set that under-claims would leave the whole store layer dormant
// against a fixture that was ready to feed it. Neither failure is visible in a
// surface: both render as a console that quietly shows nothing.
//
// So every operation on the port is called, and each answer is checked against the
// set rather than against a list retyped here.

import { describe, expect, it } from "vitest";

import type { AttentionItem } from "./attention-projection.js";
import { createFixtureBridge } from "./fixture-bridge.js";
import { FIXTURE_SERVED_GROWTH_OPERATION_IDS } from "./fixture-growth-port.js";
import type { GrowthOperationId } from "./growth-entry.js";
import { GROWTH_OPERATIONS } from "./growth-operations.js";
import type { GrowthOutcome } from "./growth-outcome.js";
import type { GrowthPort } from "./index.js";
import { createLiveBridge } from "./live-bridge.js";
import type { ConsoleScenario, ScenarioBeat } from "./scenario.js";
import { FLAGSHIP_SCENARIO } from "./scenarios/flagship.js";
import { findScenarioWireTruthDefects } from "./scenarios/wire-truth.js";
import { createTier1Bridge } from "@ai-sidekicks/contracts";

/**
 * Call one operation without knowing its request shape.
 *
 * Every arm ignores its argument, and the alternative — a table of one request per
 * operation retyped here — is a second declaration of the signature table that
 * would go stale the first time a request grew a member.
 */
async function callOperation(
  port: GrowthPort,
  operationId: GrowthOperationId,
): Promise<GrowthOutcome<unknown>> {
  const call = port[operationId] as (request: unknown) => Promise<GrowthOutcome<unknown>>;
  return call({});
}

function fixturePort(): GrowthPort {
  const bridge = createFixtureBridge({ scenario: FLAGSHIP_SCENARIO });
  return bridge.growth;
}

describe("the fixture growth port — what it serves, and what it still refuses", () => {
  it("answers every operation its bridge claims to serve, and refuses every other", async () => {
    const bridge = createFixtureBridge({ scenario: FLAGSHIP_SCENARIO });
    const served = new Set<string>(FIXTURE_SERVED_GROWTH_OPERATION_IDS);

    for (const operationId of Object.keys(GROWTH_OPERATIONS) as GrowthOperationId[]) {
      const outcome = await callOperation(bridge.growth, operationId);
      expect(outcome.status, `${operationId} answered the wrong way`).toBe(
        served.has(operationId) ? "served" : "unavailable",
      );
    }
  });

  it("publishes exactly the set it serves, so the synchronous decision is the true one", () => {
    const bridge = createFixtureBridge({ scenario: FLAGSHIP_SCENARIO });

    expect([...bridge.growthServedOperations].sort()).toStrictEqual(
      [...FIXTURE_SERVED_GROWTH_OPERATION_IDS].sort(),
    );
  });

  it("negative control: the live bridge serves none of them and names each one's own row", async () => {
    // Without this the sweep above would hold over a port that served everything.
    // The live arm is the one a release build takes, and it must still render the
    // `not-checked` absence for every wire the fixture answers.
    //
    // The expected row is read from the ledger rather than written out here. A
    // literal would have been right for exactly as long as the served set drew on
    // one slate row, and the assertion it makes — that a refusal attributes to the
    // row that owes ITS wire — is the ledger's claim, not this file's.
    const bridge = createLiveBridge(createTier1Bridge());

    expect([...bridge.growthServedOperations]).toStrictEqual([]);
    for (const operationId of FIXTURE_SERVED_GROWTH_OPERATION_IDS) {
      const outcome = await callOperation(bridge.growth, operationId);
      expect(outcome.status).toBe("unavailable");
      if (outcome.status === "unavailable") {
        expect(outcome.code).toBe("wire-unregistered");
        expect(outcome.slateRow).toBe(GROWTH_OPERATIONS[operationId].slateRow);
      }
    }
  });

  it("reads the base state a store can actually be initialised from", async () => {
    const port = fixturePort();

    const outcome = await port.sessionRead({ sessionId: FLAGSHIP_SCENARIO.sessionId });

    expect(outcome.status).toBe("served");
    if (outcome.status === "served") {
      // Cursor zero, so the store admits the scenario's first beat rather than
      // discarding a stream that starts below its base state.
      expect(outcome.value.cursor).toBe(0);
      expect(outcome.value.participantJoinLog).toStrictEqual(
        FLAGSHIP_SCENARIO.participantIdsInJoinOrder,
      );
    }
  });

  it("lends no session's join order to another, hue allocation keying on it", async () => {
    const port = fixturePort();

    const outcome = await port.sessionRead({ sessionId: "session-somebody-else" });

    expect(outcome.status).toBe("served");
    if (outcome.status === "served") {
      expect(outcome.value.participantJoinLog).toStrictEqual([]);
    }
  });

  it("lists the scenario's session, and names it by its identifier rather than inventing one", async () => {
    const port = fixturePort();

    const outcome = await port.sessionList({});

    expect(outcome.status).toBe("served");
    if (outcome.status === "served") {
      expect(outcome.value).toStrictEqual([
        { sessionId: FLAGSHIP_SCENARIO.sessionId, state: "active" },
      ]);
    }
  });
});

// The attention plane's own suite.
//
// It sits apart from the sweep above because its subject is different: the sweep
// checks WHICH operations answer, and these check WHAT the answer says. The
// projection is the one served value the console must not compute for itself
// (Plan-019 I-019-4), so a fixture that answered plausibly-but-wrongly would train
// every attention surface against a projection no daemon will ever send.
//
// The flagship arm is honestly empty, which on its own would pass over a port that
// returned `[]` for everything. So the derivation is driven over scenarios built
// here that DO reach an attention state — held to the same wire-truth predicate the
// shipped scenarios are held to, `findScenarioWireTruthDefects`, so the beats are
// events a daemon can emit rather than plausible-looking inventions.

const ATTENTION_SESSION_ID = "019b7a11-0280-75e5-8510-ada11a5a33a5";
const ATTENTION_PARTICIPANT_ID = "019b7a11-0280-79a4-8110-cca0117a0330";
const RUN_AWAITING_APPROVAL = "019b7a11-0280-740e-8110-d1a4c1150021";
const RUN_FINISHED = "019b7a11-0280-740e-8120-d1a4c1150022";

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
      sessionId: ATTENTION_SESSION_ID,
      sequence,
      kind: `run.${newState}`,
      occurredAt: new Date(Date.parse("2026-01-01T16:00:00.000Z") + atMs).toISOString(),
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
    // The canonical event each item came from, keyed the way the console keys
    // events. Asserted against the scenario's own beat rather than a literal.
    expect(byRunId.get(RUN_AWAITING_APPROVAL)?.sourceEventId).toBe(`${ATTENTION_SESSION_ID}:2`);
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
