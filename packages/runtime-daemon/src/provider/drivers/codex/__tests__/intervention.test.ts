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
//   P0-3 (T3.14) — the REQUESTER's `clientIdempotencyKey` reaches the runtime
//     verbatim on the steer path, and is never re-minted per dispatch.
//   P3-1 (T3.14) — a steer acknowledgement that names a different turn, or names
//     none at all, degrades instead of reading as success.

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
  type CodexSteerAcknowledgement,
  type CodexSteerRunRequest,
} from "../intervention.js";

const RUN_ID = "22222222-2222-4222-8222-222222222222" as RunId;

// What the fake runtime reports as the live turn when the caller pinned none —
// standing in for the manager's `#requireActiveTurn` resolution, so the ack it
// echoes is against the turn that would really have gone on the wire.
const LIVE_TURN_ID = "turn-live";

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
    async (request: CodexSteerRunRequest): Promise<CodexSteerAcknowledgement> => {
      // The confirming default: the provider acknowledges the very turn the
      // driver targeted. Every degraded-ack case overrides it explicitly, so the
      // grading under test is always stated by the test that depends on it.
      const targetedTurnId = request.expectedTurnId ?? LIVE_TURN_ID;
      return { targetedTurnId, acknowledgedTurnId: targetedTurnId };
    },
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

    expect(harness.steerRun).toHaveBeenCalledWith({
      runId: RUN_ID,
      content: "focus on the failing test",
      expectedTurnId: "turn-01",
      clientIdempotencyKey: "idem-1",
    });
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
    expect(harness.steerRun).toHaveBeenCalledWith({
      runId: RUN_ID,
      content: "stop guessing",
      expectedTurnId: undefined,
      clientIdempotencyKey: "idem-1",
    });
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
          async (_request: CodexSteerRunRequest): Promise<CodexSteerAcknowledgement> => {
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

describe("CodexInterventionDispatcher idempotency-key ride-through (P0-3)", () => {
  it("hands the requester's key to the runtime verbatim", async () => {
    const harness = createHarness();

    await harness.dispatcher.applyIntervention(steerParams());

    // Verbatim is the whole property: a key re-minted at this boundary would give
    // the provider a fresh value on every retry and defeat the `interventions`
    // UNIQUE guard that turns at-least-once delivery into exactly-once
    // application.
    const [request] = harness.steerRun.mock.calls[0] as [CodexSteerRunRequest];
    expect(request.clientIdempotencyKey).toBe("idem-1");
  });

  it("sends the same key on a retry of the same intervention", async () => {
    const harness = createHarness();

    await harness.dispatcher.applyIntervention(steerParams());
    await harness.dispatcher.applyIntervention(steerParams());

    const keys = (harness.steerRun.mock.calls as Array<[CodexSteerRunRequest]>).map(
      ([request]) => request.clientIdempotencyKey,
    );
    expect(keys).toEqual(["idem-1", "idem-1"]);
  });

  it("sends no client key on the interrupt path, rather than inventing one", async () => {
    const harness = createHarness();

    await harness.dispatcher.applyIntervention(interruptParams());

    // `turn/interrupt` is `{ threadId, turnId }` at the pin and accepts no
    // client-supplied identifier, so the params carry the run and the reason and
    // nothing else. An invented substitute would be an unregistered wire field.
    const [params] = harness.interruptRun.mock.calls[0] as [InterruptRunParams];
    expect(Object.keys(params).sort()).toEqual(["reason", "runId"]);
  });
});

describe("CodexInterventionDispatcher ambiguous steer acknowledgement (P3-1)", () => {
  function harnessAcknowledging(acknowledgedTurnId: string | null): Harness {
    return createHarness(
      {},
      {
        steerRun: vi.fn(
          async (request: CodexSteerRunRequest): Promise<CodexSteerAcknowledgement> => {
            return {
              targetedTurnId: request.expectedTurnId ?? LIVE_TURN_ID,
              acknowledgedTurnId,
            };
          },
        ),
      },
    );
  }

  it("degrades when the provider acknowledges a different turn", async () => {
    const harness = harnessAcknowledging("turn-99");

    const result = await harness.dispatcher.applyIntervention(steerParams());

    // The provider accepted SOMETHING; that is not evidence it accepted this. A
    // silent `applied` here would report a participant's directive as delivered
    // to a turn that never saw it.
    expect(result).toEqual({
      status: "degraded",
      fallbackAction: CODEX_INTERVENTION_FALLBACK_ACTION,
    });
  });

  it("degrades when the acknowledgement names no turn at all", async () => {
    const harness = harnessAcknowledging(null);

    const result = await harness.dispatcher.applyIntervention(steerParams());

    expect(result).toEqual({
      status: "degraded",
      fallbackAction: CODEX_INTERVENTION_FALLBACK_ACTION,
    });
  });

  it("applies when the acknowledgement names the targeted turn", async () => {
    const harness = harnessAcknowledging("turn-01");

    const result = await harness.dispatcher.applyIntervention(steerParams());

    expect(result).toEqual({ status: "applied" });
  });

  it("grades an unpinned steer against the turn the runtime actually targeted", async () => {
    const harness = harnessAcknowledging(LIVE_TURN_ID);

    const result = await harness.dispatcher.applyIntervention({
      ...steerParams(),
      payload: { content: "stop guessing" },
    } as ApplyInterventionParams);

    // The comparand is what went on the wire, not the caller's absent hint —
    // otherwise every unpinned steer would grade against `undefined` and degrade.
    expect(result).toEqual({ status: "applied" });
  });

  it("does not grade the interrupt acknowledgement on its shape", async () => {
    const harness = createHarness(
      {},
      { interruptRun: vi.fn(async (_params: InterruptRunParams): Promise<void> => {}) },
    );

    // `turn/interrupt` answers an empty object at the pin, so resolving without a
    // JSON-RPC error is the whole of the evidence. Checking that emptiness would
    // degrade every interrupt the day the provider adds a member to a response
    // that took nothing away.
    await expect(harness.dispatcher.applyIntervention(interruptParams())).resolves.toEqual({
      status: "applied",
    });
    await expect(harness.dispatcher.applyIntervention(cancelParams())).resolves.toEqual({
      status: "applied",
    });
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
