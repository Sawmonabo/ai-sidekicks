// The run controls reach the port, and the refusal a person reads is the raiser's own.
//
// THE DEFECT THIS SUITE IS THE INSTRUMENT FOR: both controls were mounted as
// hand-composed refusals saying the operation was "not on the bridge yet", while
// `bridge/growth-operations/workflows.ts` carried `workflowRunCancel` and
// `workflowRunResume` and `bridge/growth-port.ts` composed its own refusal for a build
// that cannot serve them. So the first group asserts the press ARRIVES, and the second
// asserts the refusal is the PORT's — origin, code and structured members — which is
// exactly what the pre-fix shape could not produce: it never called anything, and its
// refusal carried this family's own origin.
//
// WHAT IS NEXT DOOR AND WHY. `run-control-dispatch.flight.test.tsx` holds the call
// still and varies the TIMING and the ADDRESS — a second press while one is in flight,
// an answer arriving after a retarget, the round a served act advances. That is a
// different subject from whether a press composes and arrives at all, and the two
// share their scaffolding through `run-control-dispatch.test-support.tsx`.

import { act, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  createRefusingGrowthPort,
  growthUnavailable,
  type GrowthPort,
} from "../../../bridge/index.js";
import {
  DAEMON_REFUSAL,
  RUN_A,
  heldCancelPort,
  observeControls,
  settle,
} from "./run-control-dispatch.test-support.js";

afterEach(() => {
  cleanup();
});

describe("a press reaches the growth port", () => {
  it("sends the run and the operator's reason on the request the operation declares", async () => {
    const port = heldCancelPort();
    const controls = observeControls(port.growth, RUN_A);
    await act(async () => {
      controls.latest().cancel.cancel("superseded");
    });
    expect(port.requests).toStrictEqual([{ workflowRunId: RUN_A, reason: "superseded" }]);
  });

  it("omits the reason key entirely when the operator gave none", async () => {
    // Not `reason: undefined`. The request's member is optional under
    // `exactOptionalPropertyTypes`, and a key carrying nothing is a different request
    // from one that does not carry the key.
    const port = heldCancelPort();
    const controls = observeControls(port.growth, RUN_A);
    await act(async () => {
      controls.latest().cancel.cancel(undefined);
    });
    expect(port.requests).toStrictEqual([{ workflowRunId: RUN_A }]);
  });

  it("carries the chosen re-pin as the resume request's optional member", async () => {
    const requests: Parameters<GrowthPort["workflowRunResume"]>[0][] = [];
    const growth: GrowthPort = {
      ...createRefusingGrowthPort(),
      workflowRunResume: async (request) => {
        requests.push(request);
        return { status: "served", value: { workflowRunId: RUN_A, state: "running" } };
      },
    };
    const controls = observeControls(growth, RUN_A);
    await act(async () => {
      controls.latest().resume.resume({ targetWorkflowVersionId: "wfv-02" });
    });
    expect(requests).toStrictEqual([
      { workflowRunId: RUN_A, versionRepin: { targetWorkflowVersionId: "wfv-02" } },
    ]);
  });

  it("negative control: a pane naming no run puts nothing on the port", async () => {
    // The arm the pane never renders, asserted rather than assumed. Both requests carry
    // a required run id, so there is nothing to address — and a fabricated one would be
    // a console asking the daemon about a run that does not exist.
    const port = heldCancelPort();
    const controls = observeControls(port.growth, undefined);
    await act(async () => {
      controls.latest().cancel.cancel("superseded");
    });
    expect(port.requests).toStrictEqual([]);
    expect(controls.latest().cancel.outcome.kind).toBe("idle");
  });
});

describe("the refusal a person reads is the raiser's own", () => {
  it("renders the PORT's refusal for a wire this build does not carry", async () => {
    // The pre-fix shape is what this rules out. It composed a refusal here, under this
    // family's own origin, naming a bridge it had never consulted — so the assertion
    // is on the origin and the code the growth port itself produces.
    const controls = observeControls(createRefusingGrowthPort(), RUN_A);
    await act(async () => {
      controls.latest().cancel.cancel(undefined);
    });
    await settle();
    const { outcome } = controls.latest().cancel;
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") {
      throw new Error("the cancel control settled on the wrong arm");
    }
    // The port's own object, whole: origin, code, sentence, and the structured
    // `operationId` / `slateRow` / `owningDocument` a hand-composed refusal has none
    // of. Compared against the real producer rather than against a copied sentence,
    // so a reworded slate row moves both sides at once.
    expect(outcome.refusal).toStrictEqual(growthUnavailable("workflowRunCancel"));
    expect(outcome.refusal.origin).toBe("growth-port");
    expect(outcome.refusal.code).toBe("wire-unregistered");
  });

  it("settles a REJECTED call rather than reading forever", async () => {
    // A scripted daemon refusal is thrown verbatim, and the live seam will throw the
    // same shape. A fulfilment handler alone left the control `dispatching` over an
    // answer that had already arrived.
    const port = heldCancelPort();
    const controls = observeControls(port.growth, RUN_A);
    await act(async () => {
      controls.latest().cancel.cancel(undefined);
    });
    await act(async () => {
      port.refuseAsDaemon();
    });
    await settle();
    const { outcome } = controls.latest().cancel;
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") {
      throw new Error("the cancel control settled on the wrong arm");
    }
    expect(outcome.refusal.code).toBe(DAEMON_REFUSAL.code);
  });

  it("negative control: a served call settles on the settled arm, not the refused one", async () => {
    // Without this, the two cases above would pass over a dispatcher that refused
    // every call it made.
    const port = heldCancelPort();
    const controls = observeControls(port.growth, RUN_A);
    await act(async () => {
      controls.latest().cancel.cancel(undefined);
    });
    await act(async () => {
      port.serve();
    });
    await settle();
    const { outcome } = controls.latest().cancel;
    expect(outcome.kind).toBe("settled");
    if (outcome.kind !== "settled") {
      throw new Error("the cancel control settled on the wrong arm");
    }
    // The wire word verbatim, so the settlement and the run agree on one string.
    expect(outcome.runState).toBe("cancelled");
  });
});
