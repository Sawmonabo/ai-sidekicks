// Codex intervention dispatcher: each intervention type maps onto a native provider operation, or
// degrades with no provider operation when its capability is not declared, or when a steer is
// acknowledged on a different turn.

import { describe, expect, it, vi } from "vitest";

import {
  DRIVER_CAPABILITY_FLAGS,
  type ApplyInterventionParams,
  type DriverCapabilities,
  type DriverCapabilityFlag,
  type InterruptRunParams,
  type RunId,
} from "@ai-sidekicks/contracts";

import {
  CodexInterventionDispatcher,
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
} {
  const flags = Object.fromEntries(DRIVER_CAPABILITY_FLAGS.map((flag) => [flag, true])) as Record<
    DriverCapabilityFlag,
    boolean
  >;
  Object.assign(flags, overrides);
  const snapshot: DriverCapabilities = { flags, contractVersion: "1.0.0" };
  return { snapshot };
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
    payload: { reason: "the person paused the run" },
  };
}

function cancelParams(): ApplyInterventionParams {
  return {
    type: "cancel",
    targetRunId: RUN_ID,
    expectedRunVersion: 4,
    clientIdempotencyKey: "idem-3",
    payload: { reason: "the person canceled the run" },
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
      // A steer message is user text; the absent-origin default would report `origin=unknown`.
      frameOrigin: "human_text",
    });
    expect(result).toEqual({ status: "applied" });
  });

  it("routes interrupt onto the provider's turn interrupt", async () => {
    const harness = createHarness();

    const result = await harness.dispatcher.applyIntervention(interruptParams());

    expect(harness.interruptRun).toHaveBeenCalledWith({
      runId: RUN_ID,
      reason: "the person paused the run",
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
      reason: "the person canceled the run",
    });
    expect(result).toEqual({ status: "applied" });
  });
});

describe("CodexInterventionDispatcher degraded fallback", () => {
  it("degrades with no provider operation when the capability is declared false", async () => {
    const harness = createHarness({ steer: false });

    const result = await harness.dispatcher.applyIntervention(steerParams());

    expect(result).toEqual({
      status: "degraded",
      fallbackAction: CODEX_INTERVENTION_FALLBACK_ACTION,
    });
    // Degrading after steering would apply the intervention the layer above compensates for.
    expect(harness.steerRun).not.toHaveBeenCalled();
    expect(harness.interruptRun).not.toHaveBeenCalled();
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
    // message as delivered to a turn that never saw it.
    expect(result).toEqual({
      status: "degraded",
      fallbackAction: CODEX_INTERVENTION_FALLBACK_ACTION,
    });
  });
});
