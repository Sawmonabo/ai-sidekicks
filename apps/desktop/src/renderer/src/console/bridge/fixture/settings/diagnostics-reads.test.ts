// The diagnostics plane's two-way split, driven through the real fixture bridge.
//
// The suite beside `diagnostics-reads.ts`, and it earns its place on the one
// property lifting the plane out of the port could silently break: WHICH of the five
// answers under a scenario that scripts nothing. The sweep in
// `growth/growth-port.test.ts` calls every served operation and holds each answer to
// the served tuple, which is a different claim — that each one answers at all. What
// separates "the one empty-form read still serves its default and the other four still
// refuse by name" from "every read still resolves" is driving scenarios that script
// different subsets and comparing, which is what the cases below do.
//
// Each case is another's negative control. A plane that had lost its script routing
// would answer the same way under every scenario, and the cases that expect a refusal
// would go on passing while the scripted ones failed; a plane that had grown an
// unscripted fallback where it has no honest empty form would serve under the
// onboarding scenario, which scripts no reading at all. No case alone reports the
// split.

import { describe, expect, it } from "vitest";

import { crossMacrotaskBoundary } from "../../../core/macrotask-boundary.test-support.js";
import { createFixture } from "../call-plane/bridge.test-support.js";
import { servedValueOf } from "../growth/growth-port.test-support.js";
import { FLAGSHIP_SCENARIO } from "../../scenario/flagship/flagship.js";
import { ONBOARDING_SCENARIO } from "../../scenario/onboarding.js";
import { SCRIPT_ABSENT_REFUSAL_CODE } from "../../scenario/runtime/index.js";
import { FAILED_RUN_ID, STALLED_RUN_ID } from "../../scenario/settings/diagnostics-plane.js";
import { SETTINGS_SCENARIO } from "../../scenario/settings/settings.js";

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

describe("the fixture's diagnostics plane — the one read that always answers", () => {
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

  it("serves the scripted machine condition for the flagship, which states its own", async () => {
    // The other scenario that scripts this read, and the reason the negative control
    // below needs a third: the flagship measures the node too, so a plane that had
    // stopped routing scripts would fail the settings case above and pass this one.
    const fixture = createFixture(FLAGSHIP_SCENARIO);

    const reading = fixture.bridge.growth.healthStatusRead({});
    await crossMacrotaskBoundary();

    const settled = servedValueOf(await reading);
    expect(settled.overall).toBe("degraded");
    expect(settled.components.map((component) => component.name)).toStrictEqual([
      "session-store",
      "relay",
    ]);
  });

  it("names the scenario's own gap for a scenario that measured nothing", async () => {
    // The status read is a MEASUREMENT and has no empty form: its reply must name one
    // of three categories, so a synthesized `healthy` would be the fixture asserting
    // somebody checked this machine. Under a scenario that scripts no reading it
    // refuses, and with the code that says the SCENARIO is silent rather than the one
    // that says the wire is unbuilt — the bridge does stand in for this wire.
    const fixture = createFixture(ONBOARDING_SCENARIO);

    const reading = fixture.bridge.growth.healthStatusRead({});
    await crossMacrotaskBoundary();

    const outcome = await reading;
    expect(outcome.status).toBe("unavailable");
    if (outcome.status === "unavailable") {
      expect(outcome.code).toBe(SCRIPT_ABSENT_REFUSAL_CODE);
    }
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
