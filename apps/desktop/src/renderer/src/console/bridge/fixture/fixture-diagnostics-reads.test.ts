// The diagnostics plane's two-way split, driven through the real fixture bridge.
//
// The suite beside `fixture-diagnostics-reads.ts`, and it earns its place on the one
// property lifting the plane out of the port could silently break: WHICH of the five
// answers under a scenario that scripts nothing. The sweep in
// `fixture-growth-port.test.ts` calls every served operation and holds each answer to
// the served tuple, which is a different claim — that each one answers at all. What
// separates "the two empty-form reads still serve their default and the three
// subject-addressed ones still refuse" from "every read still resolves" is driving BOTH
// scenarios and comparing, which is what the pairs below do.
//
// Each pair is the other's negative control. A plane that had lost its script routing
// would serve the default shape under the settings scenario too, and the flagship cases
// would go on passing while the settings ones failed; a plane that had lost its
// unscripted fallback would refuse under the flagship while the settings ones passed.
// Neither case alone reports the split.

import { describe, expect, it } from "vitest";

import { crossMacrotaskBoundary } from "../../core/macrotask-boundary.test-support.js";
import { createFixture } from "./fixture-bridge.test-support.js";
import { servedValueOf } from "./fixture-growth-port.test-support.js";
import { FLAGSHIP_SCENARIO } from "../scenarios/flagship.js";
import { SCRIPT_ABSENT_REFUSAL_CODE } from "../scenario-runtime/index.js";
import { FAILED_RUN_ID, STALLED_RUN_ID } from "../scenarios/settings-diagnostics-plane.js";
import { SETTINGS_SCENARIO } from "../scenarios/settings.js";

/** The scripted latency on every diagnostics read but the recovery request. */
const DIAGNOSTICS_READ_LATENCY_MS = 40;
/** The scripted latency on the recovery request, which is a press rather than a read. */
const DIAGNOSTICS_RECOVERY_LATENCY_MS = 60;

/**
 * The runs the three subject-addressed answers are addressed by.
 *
 * Taken from the scenario rather than restated, because each of these reads answers
 * with facts about ONE named run — a probe naming another run would be asking a
 * question the settings scenario holds nothing for.
 */
const STALL_SUBJECT = { runId: STALLED_RUN_ID } as const;
const FAILURE_SUBJECT = { runId: FAILED_RUN_ID } as const;
const RECOVERY_REQUEST = { runId: STALLED_RUN_ID, action: "interrupt" } as const;

describe("the fixture's diagnostics plane — two reads that always answer", () => {
  it("serves the scripted machine condition for a scenario that states one", async () => {
    const fixture = createFixture(SETTINGS_SCENARIO);

    const reading = fixture.bridge.growth.healthStatusRead({});
    await crossMacrotaskBoundary();
    fixture.engine.advance(DIAGNOSTICS_READ_LATENCY_MS);

    const settled = servedValueOf(await reading);
    expect(settled.overall).toBe("degraded");
    expect(settled.components.map((component) => component.name)).toStrictEqual([
      "daemon",
      "provider",
      "replay",
    ]);
  });

  it("serves the healthy empty reading for a scenario that states none", async () => {
    // `healthy` over an empty component set is what "nothing reported a problem" looks
    // like on this wire, so it is a real daemon answer rather than a fabrication — the
    // reason this read is not in the script-only class.
    const fixture = createFixture(FLAGSHIP_SCENARIO);

    const reading = fixture.bridge.growth.healthStatusRead({});
    await crossMacrotaskBoundary();

    expect(servedValueOf(await reading)).toStrictEqual({ overall: "healthy", components: [] });
  });

  it("serves the scripted redaction posture for a scenario that states one", async () => {
    const fixture = createFixture(SETTINGS_SCENARIO);

    const reading = fixture.bridge.growth.healthRedactionPolicyRead({});
    await crossMacrotaskBoundary();
    fixture.engine.advance(DIAGNOSTICS_READ_LATENCY_MS);

    const settled = servedValueOf(await reading);
    expect(settled.retentionPolicyOverrideActive).toBe(true);
    expect(settled.buckets.length).toBeGreaterThan(0);
  });

  it("serves the default posture for a scenario that states none", async () => {
    // No bucket override, outbound denied, no retention override in force: the shape a
    // fresh node is in, which the page draws.
    const fixture = createFixture(FLAGSHIP_SCENARIO);

    const reading = fixture.bridge.growth.healthRedactionPolicyRead({});
    await crossMacrotaskBoundary();

    expect(servedValueOf(await reading)).toStrictEqual({
      buckets: [],
      outboundDefault: "deny",
      retentionPolicyOverrideActive: false,
    });
  });
});

describe("the fixture's diagnostics plane — three answers addressed by a subject", () => {
  it("serves the scripted stall reading and failure detail for a scenario that states them", async () => {
    const fixture = createFixture(SETTINGS_SCENARIO);

    const stall = fixture.bridge.growth.healthStuckRunInspect(STALL_SUBJECT);
    const failure = fixture.bridge.growth.healthFailureDetailRead(FAILURE_SUBJECT);
    await crossMacrotaskBoundary();
    fixture.engine.advance(DIAGNOSTICS_READ_LATENCY_MS);

    expect(servedValueOf(await stall).healthSignal).toBe("stuck-suspected");
    expect(servedValueOf(await failure).recoveryCondition).toBe("provider_unavailable");
  });

  it("serves the scripted recovery receipt for a scenario that states one", async () => {
    const fixture = createFixture(SETTINGS_SCENARIO);

    const recovery = fixture.bridge.growth.healthRecoveryActionRequest(RECOVERY_REQUEST);
    await crossMacrotaskBoundary();
    fixture.engine.advance(DIAGNOSTICS_RECOVERY_LATENCY_MS);

    expect(servedValueOf(await recovery).newState).toBe("interrupted");
  });

  it("refuses all three by name for a scenario that states none", async () => {
    // An empty form would assert that a run no author declared exists and has nothing
    // wrong with it, and a synthesized receipt would report that the daemon moved one.
    // Both take the "not checked" refusal, which is what a script that has not said is.
    const fixture = createFixture(FLAGSHIP_SCENARIO);

    const outcomes = await Promise.all([
      fixture.bridge.growth.healthStuckRunInspect(STALL_SUBJECT),
      fixture.bridge.growth.healthFailureDetailRead(FAILURE_SUBJECT),
      fixture.bridge.growth.healthRecoveryActionRequest(RECOVERY_REQUEST),
    ]);

    expect(outcomes.map((outcome) => outcome.status)).toStrictEqual([
      "unavailable",
      "unavailable",
      "unavailable",
    ]);
    for (const outcome of outcomes) {
      expect(outcome.status === "unavailable" && outcome.code).toBe(SCRIPT_ABSENT_REFUSAL_CODE);
    }
  });
});
