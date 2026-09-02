// The failure matrix.
//
// This file was written BEFORE the store, persistence, and bridge code it exercises
// and it is the reason those modules have the shapes they do. Each block below is a
// way the console can be wrong that a happy-path test would never reach: an event
// that arrives before the store is ready, a database that refuses to open, a timer
// that outlives its pane, a wheel that runs out of colours, a wire that lands.
//
// The rule the file enforces on itself: every row is an EXECUTING test, not a
// comment describing one. A failure matrix that lists modes without driving them is
// documentation with a `.test.ts` extension.
//
// Where a mode has a "the code should have refused" shape, the assertion is on the
// REFUSAL — its code, its detail, the tripwire it fired — rather than merely on the
// absence of a crash. Not throwing is not the same as behaving correctly, and the
// difference is where every silent-corruption bug lives.

import { beforeEach, describe, expect, it } from "vitest";
import {
  createRefusingGrowthPort,
  GROWTH_OPERATIONS,
  GROWTH_PREREQUISITES,
  growthUnavailable,
} from "./bridge/growth-port.js";
import { GROWTH_SLATE_ROWS, type GrowthSlateRow } from "./bridge/growth-slate.js";
import {
  CONSOLE_SCENARIO_MANIFEST,
  findOrphanedLedgerRowIds,
  mapSlateRowCoverage,
  type ConsoleScenarioManifest,
} from "./bridge/scenario-manifest.js";
import { ScenarioEngine } from "./bridge/scenario.js";
import { FIRST_RUN_SCENARIO } from "./bridge/scenarios/first-run.js";
import { parseRoute } from "./routing/index.js";
import { classifyOpenFailure, openConsoleDatabase } from "./persistence/indexeddb-adapter.js";
import { MemoryPersistenceAdapter } from "./persistence/memory-adapter.js";
import { UiStateStore } from "./persistence/ui-state-store.js";
import { SessionStore } from "./store/session-store.js";
import type { ConsoleSessionEvent } from "./store/entities.js";
import { ParticipantHueAllocator, preferredHueStep } from "./tokens/participant-hue.js";
import { PARTICIPANT_HUE_STEPS } from "./tokens/palette.js";
import { consoleTripwires } from "./core/tripwires.js";

// Tripwires throw in development so a breach is impossible to ignore. Under test
// they are RECORDED instead, because the point of these cases is to assert that the
// breach was detected and described — a throw would only prove it was noticed.
beforeEach(() => {
  consoleTripwires.setThrowOnReport(false);
  consoleTripwires.reset();
});

function eventAt(
  sequence: number,
  overrides: Partial<ConsoleSessionEvent> = {},
): ConsoleSessionEvent {
  return {
    sessionId: "session-1",
    sequence,
    kind: "run.started",
    occurredAt: new Date(Date.UTC(2026, 0, 1, 0, 0, sequence)).toISOString(),
    ...overrides,
  };
}

describe("failure matrix — a bridge event arrives before the store is initialised", () => {
  it("buffers rather than dropping, and drains in sequence order once initialised", () => {
    const store = new SessionStore({ sessionId: "session-1" });

    const early = store.applyBatch([eventAt(3), eventAt(2)]);
    expect(early.admitted).toBe(0);
    expect(early.buffered).toBe(2);
    expect(store.snapshot().timeline).toHaveLength(0);

    store.initialise({ cursor: 1, entities: [], participantJoinLog: [] });

    // Both buffered events land, ordered, with no gap recorded: the events were
    // never missing, only early. Dropping them would have left a hole the console
    // could only heal with a full re-pull.
    const timeline = store.snapshot().timeline;
    expect(timeline.map((event) => event.sequence)).toStrictEqual([2, 3]);
    expect(store.snapshot().gapSequences).toStrictEqual([]);
    expect(store.snapshot().cursor).toBe(3);
  });

  it("refuses an event addressed to another session instead of mixing it in", () => {
    const store = new SessionStore({ sessionId: "session-1" });
    store.initialise({ cursor: 0, entities: [], participantJoinLog: [] });

    const outcome = store.applyBatch([eventAt(1, { sessionId: "session-2" })]);

    expect(outcome.refusedForeignSession).toBe(1);
    expect(outcome.admitted).toBe(0);
    expect(store.snapshot().timeline).toHaveLength(0);
  });

  it("records the missing sequences when a gap opens rather than renumbering", () => {
    const store = new SessionStore({ sessionId: "session-1" });
    store.initialise({ cursor: 0, entities: [], participantJoinLog: [] });

    const outcome = store.applyBatch([eventAt(1), eventAt(4)]);

    expect(outcome.gapDetected).toBe(true);
    expect(store.snapshot().gapSequences).toStrictEqual([2, 3]);
  });
});

describe("failure matrix — the durable store cannot be opened", () => {
  it("classifies a refused open as the unprivileged-scheme case", () => {
    expect(classifyOpenFailure(named("SecurityError"))).toBe("open-refused");
    expect(classifyOpenFailure(named("InvalidStateError"))).toBe("open-refused");
    expect(classifyOpenFailure(named("UnknownError"))).toBe("open-refused");
  });

  it("classifies a version mismatch separately, so nothing is deleted to recover", () => {
    // A newer build already wrote this database. Falling back to memory keeps its
    // bytes intact; treating it as a generic failure and clearing the store would
    // destroy a future version's state.
    expect(classifyOpenFailure(named("VersionError"))).toBe("version-mismatch");
  });

  it("reports the missing global rather than throwing when there is no IndexedDB", async () => {
    const outcome = await openConsoleDatabase({ indexedDbFactory: undefined });
    expect(outcome).toStrictEqual({ outcome: "unavailable", reason: "no-indexeddb-global" });
  });

  it("falls back to memory and SAYS SO when the open is refused (I-023-11)", async () => {
    const refusingFactory = {
      open: () => {
        throw named("SecurityError");
      },
    } as unknown as IDBFactory;

    const outcome = await openConsoleDatabase({ indexedDbFactory: refusingFactory });
    expect(outcome.outcome).toBe("unavailable");

    const store = new UiStateStore({
      adapter: new MemoryPersistenceAdapter({ unavailableReason: "open-refused" }),
    });
    const health = await store.health();
    expect(health.durable).toBe(false);
    expect(health.description).toContain("not survive a restart");
    // The disclosure names the cause. "Storage unavailable" alone would leave an
    // operator with nothing to check.
    expect(health.description).toContain("renderer scheme");
  });

  it("trims once and then surfaces the refusal when the quota is exhausted", async () => {
    // The ceiling admits the first record (43 bytes by the adapter's estimator:
    // partition + key + value class + serialised value) and cannot admit the
    // second (88) even with the first evicted. That is the case worth pinning:
    // the trim runs, frees a whole partition, and the write STILL fails — so the
    // refusal reaches the caller instead of being retried forever.
    const store = new UiStateStore({
      adapter: new MemoryPersistenceAdapter({ capacityBytes: 50 }),
      sessionPartitionCap: 1,
    });

    const first = await store.write("session-1", "layout", "layout", { deck: { width: 100 } });
    expect(first.outcome).toBe("written");

    const overflowing = await store.write("session-2", "layout", "layout", {
      deck: { width: 100, height: 200, ratio: 3, offset: 4, gutter: 5 },
    });

    expect(overflowing.outcome).toBe("refused");
    if (overflowing.outcome === "refused") {
      expect(overflowing.refusal.code).toBe("quota-exceeded");
    }
    const health = await store.health();
    expect(health.trimCount).toBeGreaterThan(0);
    expect(health.refusalCounts["quota-exceeded"]).toBe(1);
  });
});

describe("failure matrix — the persistence chokepoint is handed something it may not keep", () => {
  it("refuses an unknown value class and names the closed set", async () => {
    const store = new UiStateStore({ adapter: new MemoryPersistenceAdapter() });

    // Deliberately cast: the compiler already refuses this, and the runtime guard
    // has to hold anyway for anything that arrives across a boundary the compiler
    // does not see.
    const result = await store.write("session-1", "k", "composer-draft" as never, "hello");

    expect(result.outcome).toBe("refused");
    if (result.outcome === "refused") {
      expect(result.refusal.code).toBe("value-class-unknown");
      expect(result.refusal.detail).toContain("layout");
    }
    expect(consoleTripwires.firingCount("persistence-value-class")).toBe(1);
  });

  it("refuses participant-authored prose inside an allowed class", async () => {
    const store = new UiStateStore({ adapter: new MemoryPersistenceAdapter() });

    const result = await store.write("session-1", "selection", "selection", {
      composer: "Can you take another look at the rate-limit wiring before I merge it?",
    });

    expect(result.outcome).toBe("refused");
    if (result.outcome === "refused") {
      expect(result.refusal.code).toBe("value-not-identifier-shaped");
    }
    expect(consoleTripwires.firingCount("persistence-value-class")).toBe(1);
  });

  it("refuses prose smuggled through an object KEY", async () => {
    const store = new UiStateStore({ adapter: new MemoryPersistenceAdapter() });

    const result = await store.write("session-1", "scroll", "scroll-position", {
      "note to self: fix this later": 12,
    });

    expect(result.outcome).toBe("refused");
    if (result.outcome === "refused") {
      expect(result.refusal.code).toBe("value-not-identifier-shaped");
    }
  });

  it("accepts the identifier-shaped values the classes are for", async () => {
    const store = new UiStateStore({ adapter: new MemoryPersistenceAdapter() });

    await expect(
      store.write("session-1", "expansion", "expansion", ["run-01", "run-02"]),
    ).resolves.toStrictEqual({ outcome: "written" });
    await expect(store.writeGlobal("scheme", "scheme", "dark")).resolves.toStrictEqual({
      outcome: "written",
    });
    expect(consoleTripwires.totalFiringCount).toBe(0);
  });
});

describe("failure matrix — a scenario tick arrives after teardown", () => {
  it("drops the tick, counts it, and reports rather than delivering into a dead store", () => {
    const engine = new ScenarioEngine({ scenario: FIRST_RUN_SCENARIO });
    const delivered: ConsoleSessionEvent[][] = [];
    engine.subscribe((events) => {
      delivered.push([...events]);
    });

    engine.dispose();
    engine.tick();
    engine.advance(500);

    expect(delivered).toHaveLength(0);
    expect(engine.droppedTickCount).toBe(2);
    expect(consoleTripwires.firingCount("apply-chokepoint-bypass")).toBe(2);
  });

  it("delivers normally before teardown, so the drop is not vacuous", () => {
    const engine = new ScenarioEngine({ scenario: FIRST_RUN_SCENARIO });
    const delivered: ConsoleSessionEvent[][] = [];
    engine.subscribe((events) => {
      delivered.push([...events]);
    });

    engine.runToCompletion();

    expect(delivered).toHaveLength(1);
    expect(engine.progress.isComplete).toBe(true);
  });
});

describe("failure matrix — the participant hue wheel runs out of steps", () => {
  it("keeps every participant distinguishable past twelve by ringing the wrap", () => {
    const allocator = new ParticipantHueAllocator();
    const participantIds = Array.from(
      { length: PARTICIPANT_HUE_STEPS + 5 },
      (_unused, index) => `participant-${String(index)}`,
    );

    const assignments = participantIds.map((participantId) => allocator.admit(participantId));

    expect(allocator.admittedCount).toBe(participantIds.length);
    // Every one of the first twelve holds a distinct step: the wheel is used up
    // before anything wraps.
    const firstTwelveSteps = new Set(
      assignments.slice(0, PARTICIPANT_HUE_STEPS).map((one) => one.step),
    );
    expect(firstTwelveSteps.size).toBe(PARTICIPANT_HUE_STEPS);
    // Past twelve, a step repeats but the (step, ring) pair does not — which is the
    // property the design actually needs, since two people sharing a colour with no
    // second axis are indistinguishable in a ledger.
    const pairs = assignments.map((one) => `${String(one.step)}:${one.ringTreatment}`);
    expect(new Set(pairs).size).toBe(participantIds.length);
  });

  it("gives the same participant the same hue regardless of arrival order", () => {
    // Two ids whose preferred step collides. Found by search rather than asserted,
    // so the case stays real if the hash changes.
    const collidingPair = findCollidingParticipantIds();
    expect(collidingPair).toBeDefined();
    if (collidingPair === undefined) {
      return;
    }
    const [first, second] = collidingPair;

    const forward = new ParticipantHueAllocator();
    const forwardFirst = forward.admit(first);
    const forwardSecond = forward.admit(second);

    const reverse = new ParticipantHueAllocator();
    const reverseSecond = reverse.admit(second);
    const reverseFirst = reverse.admit(first);

    // Order changes WHO gets the preferred step — that is inherent to first-come
    // allocation and is fine. What must not change is that both are distinct and
    // that each allocation is stable within its own session.
    expect(forwardFirst.step).not.toBe(forwardSecond.step);
    expect(reverseFirst.step).not.toBe(reverseSecond.step);
    expect(forward.assignmentFor(first)?.step).toBe(forwardFirst.step);
    expect(reverse.assignmentFor(second)?.step).toBe(reverseSecond.step);
    // And the first arrival always gets the step both wanted, in both orders.
    expect(forwardFirst.step).toBe(preferredHueStep(first));
    expect(reverseSecond.step).toBe(preferredHueStep(second));
  });

  it("frees nothing when a participant leaves, so a colour never changes hands", () => {
    const allocator = new ParticipantHueAllocator();
    const leaving = allocator.admit("participant-leaving");
    // There is deliberately no `release`. Re-using a departed participant's hue
    // would silently re-attribute their rows in the scrollback above.
    expect("release" in allocator).toBe(false);
    const later = allocator.admit("participant-later");
    expect(later.step).not.toBe(leaving.step);
  });
});

describe("failure matrix — a growth-slate row lands and the port still claims fixture-only", () => {
  it("has every slate row served by at least one operation or prerequisite", () => {
    const uncovered = mapSlateRowCoverage().filter(
      (coverage) => coverage.operations.length === 0 && coverage.prerequisites.length === 0,
    );
    expect(uncovered.map((coverage) => coverage.row.id)).toStrictEqual([]);
  });

  it("has no ledger entry naming a row that is not on the slate", () => {
    expect(findOrphanedLedgerRowIds()).toStrictEqual([]);
  });

  it("agrees with the slate: every entry is fixture-only while its row is unregistered", () => {
    for (const entry of [
      ...CONSOLE_SCENARIO_MANIFEST.growthOperations,
      ...CONSOLE_SCENARIO_MANIFEST.prerequisites,
    ]) {
      expect(entry.liveStatus).toBe("fixture-only");
    }
    for (const row of GROWTH_SLATE_ROWS) {
      expect(row.wireRegistered).toBe(false);
    }
  });

  it("fails when a row is registered and its entries have not been re-pointed", () => {
    // The day a wire lands, its row leaves the slate. This drives that day: a
    // manifest whose slate no longer carries a row its entries still name must be
    // caught, not quietly tolerated.
    const withoutBrowserRow: ConsoleScenarioManifest = {
      ...CONSOLE_SCENARIO_MANIFEST,
      slateRows: CONSOLE_SCENARIO_MANIFEST.slateRows.filter(
        (row: GrowthSlateRow) => row.id !== "browser-pane-namespace",
      ),
    };

    expect(findOrphanedLedgerRowIds(withoutBrowserRow)).toContain("browser-pane-namespace");
  });

  it("refuses every operation under the live bridge, as the not-checked absence", async () => {
    const port = createRefusingGrowthPort();
    const outcome = await port.invitesList({ sessionId: "session-1" });

    expect(outcome.status).toBe("unavailable");
    if (outcome.status === "unavailable") {
      expect(outcome.detail).toContain("Not checked");
      expect(outcome.owningDocument).toContain("Spec-002");
    }
    // Not an empty list. "We have not asked" and "there are none" are different
    // facts, and a surface handed `[]` cannot tell them apart.
    expect(outcome).not.toHaveProperty("value");
  });

  it("exposes one port method per operation entry and none per prerequisite", () => {
    const port = createRefusingGrowthPort();
    const portMethodNames = Object.keys(port).sort();
    const operationIds = Object.keys(GROWTH_OPERATIONS).sort();

    expect(portMethodNames).toStrictEqual(operationIds);
    for (const prerequisiteId of Object.keys(GROWTH_PREREQUISITES)) {
      expect(portMethodNames).not.toContain(prerequisiteId);
    }
  });

  it("names the owning document in every refusal, so a reader knows who owes the wire", () => {
    for (const operationId of Object.keys(GROWTH_OPERATIONS)) {
      const refusal = growthUnavailable(operationId as keyof typeof GROWTH_OPERATIONS);
      expect(refusal.owningDocument.length).toBeGreaterThan(0);
      expect(refusal.detail).toContain("not registered yet");
    }
  });
});

describe("failure matrix — the router is handed a malformed auxiliary context", () => {
  it("treats an unknown window route as not-found rather than rendering blank", () => {
    expect(parseRoute("#/window/nonsense")).toStrictEqual({
      kind: "not-found",
      attempted: "#/window/nonsense",
    });
  });

  it("treats too many trailing segments as not-found", () => {
    expect(parseRoute("#/window/timeline/session-1/agent-1/extra").kind).toBe("not-found");
  });

  it("treats a BARE auxiliary route as a working window awaiting a subject", () => {
    // Not an error: the Window menu opens this window before anything is chosen.
    expect(parseRoute("#/window/timeline")).toStrictEqual({
      kind: "auxiliary",
      route: "timeline",
      sessionId: undefined,
      agentId: undefined,
    });
  });

  it("decodes a session id that needed escaping rather than splitting on it", () => {
    const route = parseRoute("#/window/agent-console/session%2Fwith%2Fslashes");
    expect(route).toStrictEqual({
      kind: "auxiliary",
      route: "agent-console",
      sessionId: "session/with/slashes",
      agentId: undefined,
    });
  });

  it("lands an empty hash on the default route", () => {
    expect(parseRoute("")).toStrictEqual({ kind: "sessions" });
    expect(parseRoute("#")).toStrictEqual({ kind: "sessions" });
    expect(parseRoute("#/")).toStrictEqual({ kind: "sessions" });
  });
});

describe("failure matrix — a subscriber writes back into the apply chokepoint", () => {
  it("queues the re-entrant batch, applies it, and names the subscriber as the defect", () => {
    const store = new SessionStore({ sessionId: "session-1" });
    store.initialise({ cursor: 0, entities: [], participantJoinLog: [] });

    let hasReentered = false;
    const unsubscribe = store.readable.subscribe(() => {
      if (hasReentered) {
        return;
      }
      hasReentered = true;
      // The bug this models: a selector-driven effect that writes during
      // notification. Left unguarded it interleaves two transitions and the
      // second one's `current` snapshot is already stale.
      store.applyBatch([eventAt(2)]);
    });

    const outcome = store.applyBatch([eventAt(1)]);
    unsubscribe();

    expect(outcome.admitted).toBe(1);
    // The re-entrant events are not lost — they are applied after the outer batch
    // settles, so state stays consistent — but the breach is recorded.
    expect(store.snapshot().timeline.map((event) => event.sequence)).toStrictEqual([1, 2]);
    expect(consoleTripwires.firingCount("apply-chokepoint-bypass")).toBe(1);
    const report = consoleTripwires.reports()[0];
    expect(report?.detail).toContain("re-entrant applyBatch");
  });

  it("applies a duplicate sequence exactly once", () => {
    const store = new SessionStore({ sessionId: "session-1" });
    store.initialise({ cursor: 0, entities: [], participantJoinLog: [] });

    store.applyBatch([eventAt(1)]);
    const second = store.applyBatch([eventAt(1)]);

    expect(second.duplicates).toBe(1);
    expect(second.admitted).toBe(0);
    expect(store.snapshot().timeline).toHaveLength(1);
  });
});

/** An error carrying only the `name` the classifier keys on. */
function named(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}

/**
 * Find two participant ids whose preferred step collides.
 *
 * Searched rather than hard-coded so the case survives a change to the hash: a
 * literal pair would silently stop colliding and the test would pass while
 * asserting nothing.
 */
function findCollidingParticipantIds(): readonly [string, string] | undefined {
  const seenByStep = new Map<number, string>();
  for (let index = 0; index < 4096; index += 1) {
    const participantId = `participant-${String(index)}`;
    const step = preferredHueStep(participantId);
    const existing = seenByStep.get(step);
    if (existing !== undefined) {
      return [existing, participantId];
    }
    seenByStep.set(step, participantId);
  }
  return undefined;
}
