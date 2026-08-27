// Codex driver — intervention dispatcher tests (Plan-005 Phase 3, T3.2).
//
// Coverage map (the cites are the authoritative contract, not just the ACs):
//
//   `Spec-005 §Required Behavior` — one generic dispatcher routes every
//     intervention type onto a native provider operation, or returns a
//     structured degraded result.
//   ADR-011 — an unsupported intervention is DATA the orchestration layer acts
//     on, never an exception.
//   I-005-4 — an intervention type whose capability flag is not declared `true`
//     returns `{ status: 'degraded', fallbackAction }` AND performs no provider
//     operation. The second half matters as much as the first: a dispatcher that
//     returned `degraded` after already steering would have applied an
//     intervention the layer above is about to compensate for.
//   I-005-2 — the gate is `!== true`, so a missing flag is as unsupported as a
//     false one.

import { describe, expect, it, vi } from "vitest";

import {
  DRIVER_CAPABILITY_FLAGS,
  DriverInterventionResultSchema,
  type ApplyInterventionParams,
  type DriverCapabilities,
  type DriverCapabilityFlag,
  type InterruptRunParams,
  type RunId,
} from "@ai-sidekicks/contracts";

import {
  CodexInterventionDispatcher,
  CODEX_INTERVENTION_CAPABILITY_FLAGS,
  CODEX_INTERVENTION_FALLBACK_ACTION,
  type CodexInterventionRuntime,
} from "../intervention.js";

const RUN_ID = "22222222-2222-4222-8222-222222222222" as RunId;

function makeCapabilities(overrides: Partial<Record<DriverCapabilityFlag, boolean>>): {
  snapshot: DriverCapabilities;
  set: (flag: DriverCapabilityFlag, value: boolean) => void;
} {
  const flags = Object.fromEntries(DRIVER_CAPABILITY_FLAGS.map((flag) => [flag, true])) as Record<
    DriverCapabilityFlag,
    boolean
  >;
  Object.assign(flags, overrides);
  const snapshot: DriverCapabilities = { flags, contractVersion: "1.0.0" };
  return {
    snapshot,
    set: (flag, value) => {
      flags[flag] = value;
    },
  };
}

interface Harness {
  dispatcher: CodexInterventionDispatcher;
  steerRun: ReturnType<typeof vi.fn>;
  interruptRun: ReturnType<typeof vi.fn>;
  capabilities: ReturnType<typeof makeCapabilities>;
}

function createHarness(
  overrides: Partial<Record<DriverCapabilityFlag, boolean>> = {},
  runtimeOverrides: Partial<CodexInterventionRuntime> = {},
): Harness {
  // Declared with the port's real parameter lists, so the fake is checked
  // against the contract it stands in for. A cast here would have let the port
  // change shape without a single test noticing.
  const steerRun = vi.fn(
    async (_runId: RunId, _content: string, _expectedTurnId?: string): Promise<void> => {},
  );
  const interruptRun = vi.fn(async (_params: InterruptRunParams): Promise<void> => {});
  const capabilities = makeCapabilities(overrides);
  const runtime: CodexInterventionRuntime = {
    steerRun,
    interruptRun,
    ...runtimeOverrides,
  };
  return {
    dispatcher: new CodexInterventionDispatcher({
      runtime,
      readCapabilities: () => capabilities.snapshot,
    }),
    steerRun,
    interruptRun,
    capabilities,
  };
}

function steerParams(): ApplyInterventionParams {
  return {
    type: "steer",
    targetRunId: RUN_ID,
    expectedRunVersion: 4,
    clientIdempotencyKey: "idem-1",
    payload: { content: "focus on the failing test", expectedTurnId: "turn-01" },
  };
}

function interruptParams(): ApplyInterventionParams {
  return {
    type: "interrupt",
    targetRunId: RUN_ID,
    expectedRunVersion: 4,
    clientIdempotencyKey: "idem-2",
    payload: { reason: "operator paused the run" },
  };
}

function cancelParams(): ApplyInterventionParams {
  return {
    type: "cancel",
    targetRunId: RUN_ID,
    expectedRunVersion: 4,
    clientIdempotencyKey: "idem-3",
    payload: { reason: "operator cancelled the run" },
  };
}

describe("CodexInterventionDispatcher native routing (Spec-005 §Required Behavior)", () => {
  it("routes steer onto the provider's native steer", async () => {
    const harness = createHarness();

    const result = await harness.dispatcher.applyIntervention(steerParams());

    expect(harness.steerRun).toHaveBeenCalledWith(RUN_ID, "focus on the failing test", "turn-01");
    expect(result).toEqual({ status: "applied" });
  });

  it("omits fallbackAction entirely on the applied arm", async () => {
    const harness = createHarness();

    const result = await harness.dispatcher.applyIntervention(steerParams());

    // Under `exactOptionalPropertyTypes` an explicit `undefined` is not the same
    // as an absent key, and a strict envelope should not carry a key whose
    // meaning is "no fallback applies".
    expect(Object.keys(result)).toEqual(["status"]);
    expect("fallbackAction" in result).toBe(false);
  });

  it("passes a caller-supplied turn expectation through untouched", async () => {
    const harness = createHarness();

    await harness.dispatcher.applyIntervention({
      ...steerParams(),
      payload: { content: "stop guessing" },
    } as ApplyInterventionParams);

    // Absent means "the driver picks the live turn"; it must not be invented.
    expect(harness.steerRun).toHaveBeenCalledWith(RUN_ID, "stop guessing", undefined);
  });

  it("routes interrupt onto the provider's turn interrupt", async () => {
    const harness = createHarness();

    const result = await harness.dispatcher.applyIntervention(interruptParams());

    expect(harness.interruptRun).toHaveBeenCalledWith({
      runId: RUN_ID,
      reason: "operator paused the run",
    });
    expect(result).toEqual({ status: "applied" });
  });

  it("routes cancel onto the same turn-stopping operation", async () => {
    const harness = createHarness();

    const result = await harness.dispatcher.applyIntervention(cancelParams());

    // Codex exposes one turn-stopping operation; interrupt and cancel differ in
    // what the DAEMON does with the run afterwards, not in the provider call.
    expect(harness.interruptRun).toHaveBeenCalledWith({
      runId: RUN_ID,
      reason: "operator cancelled the run",
    });
    expect(result).toEqual({ status: "applied" });
  });

  it("omits an absent reason rather than sending an undefined one", async () => {
    const harness = createHarness();

    await harness.dispatcher.applyIntervention({
      ...interruptParams(),
      payload: {},
    } as ApplyInterventionParams);

    expect(harness.interruptRun).toHaveBeenCalledWith({ runId: RUN_ID });
  });
});

describe("CodexInterventionDispatcher degraded fallback (I-005-4, ADR-011)", () => {
  it("returns a degraded result when the governing capability is declared false", async () => {
    const harness = createHarness({ steer: false });

    const result = await harness.dispatcher.applyIntervention(steerParams());

    expect(result).toEqual({
      status: "degraded",
      fallbackAction: CODEX_INTERVENTION_FALLBACK_ACTION,
    });
  });

  it("performs no provider operation on the degraded path", async () => {
    const harness = createHarness({ steer: false });

    await harness.dispatcher.applyIntervention(steerParams());

    // Degrading AFTER steering would apply the very intervention the layer above
    // is about to compensate for.
    expect(harness.steerRun).not.toHaveBeenCalled();
    expect(harness.interruptRun).not.toHaveBeenCalled();
  });

  it("degrades rather than throwing, so the orchestration layer can choose", async () => {
    const harness = createHarness({ steer: false });

    await expect(harness.dispatcher.applyIntervention(steerParams())).resolves.toMatchObject({
      status: "degraded",
    });
  });

  it("treats an undeclared flag as unsupported (I-005-2 fail-closed)", async () => {
    const harness = createHarness();
    // Simulates a snapshot arriving through an untyped boundary with the flag
    // missing entirely: `!== true` must catch it, `=== false` would not.
    delete (harness.capabilities.snapshot.flags as Partial<Record<DriverCapabilityFlag, boolean>>)
      .steer;

    const result = await harness.dispatcher.applyIntervention(steerParams());

    expect(result).toMatchObject({ status: "degraded" });
    expect(harness.steerRun).not.toHaveBeenCalled();
  });

  it("keeps interrupt and cancel ungated even when steer is unsupported", async () => {
    const harness = createHarness({ steer: false });

    // Stopping an in-flight turn is a core obligation of the driver contract, and
    // `DRIVER_CAPABILITY_FLAGS` registers no interrupt/cancel member to gate on.
    await expect(harness.dispatcher.applyIntervention(interruptParams())).resolves.toEqual({
      status: "applied",
    });
    await expect(harness.dispatcher.applyIntervention(cancelParams())).resolves.toEqual({
      status: "applied",
    });
    expect(harness.interruptRun).toHaveBeenCalledTimes(2);
  });

  it("reads the capability snapshot live at every dispatch", async () => {
    const harness = createHarness();

    await expect(harness.dispatcher.applyIntervention(steerParams())).resolves.toMatchObject({
      status: "applied",
    });
    harness.capabilities.set("steer", false);
    await expect(harness.dispatcher.applyIntervention(steerParams())).resolves.toMatchObject({
      status: "degraded",
    });
  });

  it("propagates a real failure instead of reporting it as degraded", async () => {
    const harness = createHarness(
      {},
      {
        steerRun: vi.fn(
          async (_runId: RunId, _content: string, _expectedTurnId?: string): Promise<void> => {
            throw new Error("no active Codex turn");
          },
        ),
      },
    );

    // Degraded means "this provider cannot do this kind of thing". A provider
    // that can and failed is an outage, and flattening the two would send the
    // orchestration layer into a fallback for the wrong reason.
    await expect(harness.dispatcher.applyIntervention(steerParams())).rejects.toThrow(
      /no active Codex turn/,
    );
  });
});

describe("CodexInterventionDispatcher result contract", () => {
  it("emits results that satisfy the strict driver envelope", async () => {
    const harness = createHarness();

    const applied = await harness.dispatcher.applyIntervention(interruptParams());
    harness.capabilities.set("steer", false);
    const degraded = await harness.dispatcher.applyIntervention(steerParams());

    expect(DriverInterventionResultSchema.parse(applied)).toEqual(applied);
    expect(DriverInterventionResultSchema.parse(degraded)).toEqual(degraded);
  });

  it("maps exactly the three dispatchable intervention types", () => {
    // `rollback` is a member of `InterventionType` but not of the params union —
    // it travels through `rollbackTo`, so its absence here is by construction.
    expect(Object.keys(CODEX_INTERVENTION_CAPABILITY_FLAGS).sort()).toEqual([
      "cancel",
      "interrupt",
      "steer",
    ]);
    expect(CODEX_INTERVENTION_CAPABILITY_FLAGS.steer).toBe("steer");
    expect(CODEX_INTERVENTION_CAPABILITY_FLAGS.interrupt).toBeNull();
    expect(CODEX_INTERVENTION_CAPABILITY_FLAGS.cancel).toBeNull();
  });
});
