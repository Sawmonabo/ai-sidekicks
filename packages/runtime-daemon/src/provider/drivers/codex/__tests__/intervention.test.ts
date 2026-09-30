// Codex intervention dispatcher: each intervention type maps onto a native provider operation, or
// returns a structured degraded result.
//
// - An unsupported intervention is returned as data for the orchestration layer, never thrown.
// - A type whose capability flag is not `true` returns `{ status: 'degraded', fallbackAction }`
//   and performs no provider operation, so the layer above never compensates for an applied steer.
// - The requester's `clientIdempotencyKey` reaches the runtime verbatim and is never re-minted.
// - A steer acknowledgement naming a different turn, or none, degrades instead of reading as
//   success.

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

// The live turn the fake runtime reports when the caller pinned none, as the manager's
// `#requireActiveTurn` would resolve it.
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
  textNeutralizationDecisionForTurn: ReturnType<typeof vi.fn>;
  capabilities: ReturnType<typeof makeCapabilities>;
}

function createHarness(
  overrides: Partial<Record<DriverCapabilityFlag, boolean>> = {},
  runtimeOverrides: Partial<CodexInterventionRuntime> = {},
): Harness {
  // Typed with the port's real parameter lists so a change to the port fails to compile here.
  const steerRun = vi.fn(
    async (request: CodexSteerRunRequest): Promise<CodexSteerAcknowledgement> => {
      // Confirming default: the provider acknowledges the turn the driver targeted. Degraded-ack
      // tests override it.
      const targetedTurnId = request.expectedTurnId ?? LIVE_TURN_ID;
      return { targetedTurnId, acknowledgedTurnId: targetedTurnId };
    },
  );
  const interruptRun = vi.fn(async (_params: InterruptRunParams): Promise<void> => {});
  // Default is "no refusal known": the turn a steer joins is still running when the steer resolves.
  const textNeutralizationDecisionForTurn = vi.fn(
    (_turnId: string): { readonly refused: boolean } => ({ refused: false }),
  );
  const capabilities = makeCapabilities(overrides);
  const runtime: CodexInterventionRuntime = {
    steerRun,
    interruptRun,
    textNeutralizationDecisionForTurn,
    ...runtimeOverrides,
  };
  return {
    dispatcher: new CodexInterventionDispatcher({
      runtime,
      readCapabilities: () => capabilities.snapshot,
    }),
    steerRun,
    interruptRun,
    textNeutralizationDecisionForTurn,
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
    payload: { reason: "operator canceled the run" },
  };
}

describe("CodexInterventionDispatcher native routing", () => {
  it("routes steer onto the provider's native steer", async () => {
    const harness = createHarness();

    const result = await harness.dispatcher.applyIntervention(steerParams());

    expect(harness.steerRun).toHaveBeenCalledWith({
      runId: RUN_ID,
      content: "focus on the failing test",
      expectedTurnId: "turn-01",
      clientIdempotencyKey: "idem-1",
      // A steer directive is user text; the absent-origin default would report `origin=unknown`.
      frameOrigin: "human_text",
    });
    expect(result).toEqual({ status: "applied" });
  });

  it("omits fallbackAction entirely on the applied arm", async () => {
    const harness = createHarness();

    const result = await harness.dispatcher.applyIntervention(steerParams());

    // Under `exactOptionalPropertyTypes` an explicit `undefined` differs from an absent key.
    expect(Object.keys(result)).toEqual(["status"]);
    expect("fallbackAction" in result).toBe(false);
  });

  it("passes a caller-supplied turn expectation through untouched", async () => {
    const harness = createHarness();

    await harness.dispatcher.applyIntervention({
      ...steerParams(),
      payload: { content: "stop guessing" },
    } as ApplyInterventionParams);

    // Absent means the driver picks the live turn; the dispatcher must not invent one.
    expect(harness.steerRun).toHaveBeenCalledWith({
      runId: RUN_ID,
      content: "stop guessing",
      expectedTurnId: undefined,
      clientIdempotencyKey: "idem-1",
      frameOrigin: "human_text",
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

    // Codex has one turn-stopping operation; interrupt and cancel differ only in what the daemon
    // does with the run afterwards.
    expect(harness.interruptRun).toHaveBeenCalledWith({
      runId: RUN_ID,
      reason: "operator canceled the run",
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

describe("CodexInterventionDispatcher degraded fallback", () => {
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

    // Degrading after steering would apply the intervention the layer above compensates for.
    expect(harness.steerRun).not.toHaveBeenCalled();
    expect(harness.interruptRun).not.toHaveBeenCalled();
  });

  it("degrades rather than throwing, so the orchestration layer can choose", async () => {
    const harness = createHarness({ steer: false });

    await expect(harness.dispatcher.applyIntervention(steerParams())).resolves.toMatchObject({
      status: "degraded",
    });
  });

  it("treats an undeclared flag as unsupported (fail-closed)", async () => {
    const harness = createHarness();
    // A snapshot from an untyped boundary with the flag missing: `!== true` catches it,
    // `=== false` would not.
    delete (harness.capabilities.snapshot.flags as Partial<Record<DriverCapabilityFlag, boolean>>)
      .steer;

    const result = await harness.dispatcher.applyIntervention(steerParams());

    expect(result).toMatchObject({ status: "degraded" });
    expect(harness.steerRun).not.toHaveBeenCalled();
  });

  it("keeps interrupt and cancel ungated even when steer is unsupported", async () => {
    const harness = createHarness({ steer: false });

    // Stopping a turn is a core driver obligation, and `DRIVER_CAPABILITY_FLAGS` has no
    // interrupt or cancel member to gate on.
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

    // Degraded means the provider cannot do this; a provider that can and failed is an outage, and
    // reporting it as degraded would trigger the fallback for the wrong reason.
    await expect(harness.dispatcher.applyIntervention(steerParams())).rejects.toThrow(
      /no active Codex turn/,
    );
  });
});

describe("CodexInterventionDispatcher idempotency-key ride-through", () => {
  it("hands the requester's key to the runtime verbatim", async () => {
    const harness = createHarness();

    await harness.dispatcher.applyIntervention(steerParams());

    // A re-minted key would differ on every retry and defeat the `interventions` unique key on
    // `(target_run_id, client_idempotency_key)`, which makes at-least-once delivery apply once.
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

    // `turn/interrupt` is `{ threadId, turnId }` at the pin and takes no client identifier, so the
    // params carry only the run and the reason.
    const [params] = harness.interruptRun.mock.calls[0] as [InterruptRunParams];
    expect(Object.keys(params).sort()).toEqual(["reason", "runId"]);
  });
});

describe("CodexInterventionDispatcher ambiguous steer acknowledgement", () => {
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

    // The provider accepted some turn, not necessarily this one; `applied` would report the
    // directive as delivered to a turn that never saw it.
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

    // The comparand is the turn sent on the wire, not the caller's absent hint; otherwise every
    // unpinned steer would degrade.
    expect(result).toEqual({ status: "applied" });
  });

  it("does not grade the interrupt acknowledgement on its shape", async () => {
    const harness = createHarness(
      {},
      { interruptRun: vi.fn(async (_params: InterruptRunParams): Promise<void> => {}) },
    );

    // `turn/interrupt` answers an empty object at the pin, so resolving without a JSON-RPC error is
    // the whole evidence; checking for emptiness would break when the provider adds a member.
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
