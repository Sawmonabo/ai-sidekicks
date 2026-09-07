// The boundary a run is executing under, over a real projector sequence.
//
// The fold is driven rather than hand-built, because the defect this suite pins was
// invisible to a hand-built reading: the store's entity body is a SPREAD MERGE, so a
// `run.running` stamp survives every later transition that omits the member, and the
// reading used to prefer that retained value over the projection's intentionally
// cleared one. A case that handed the reading two loose values could be written to
// pass either way; a case that runs `run.running` and then a paused transition
// through `RunStateProjection` cannot.

import { describe, expect, it } from "vitest";
import type { ExecutionPosture } from "@ai-sidekicks/contracts";

import type { ConsoleEntity } from "../../store/index.js";
import { settledRunPosture } from "./run-posture.js";
import { RunStateProjection, type RunProjection } from "./run-state-projection.js";
import { STATE_CHANGE_DELIVERY } from "./run-state-feed.test-support.js";
import { RUN_ID } from "./runs-pane.test-support.js";

/** The posture a sandboxed run's `run.running` stamps, in the registered shape. */
const SANDBOXED_POSTURE: ExecutionPosture = {
  networkAccess: "none",
  writableRoots: ["/work/session-1"],
  mode: "workspace-sandboxed",
  credentialPolicyRef: "sha256:0f1e",
};

/** A second, materially different posture, so "which one" is an assertable answer. */
const TRUSTED_POSTURE: ExecutionPosture = {
  networkAccess: "allowed-domains",
  allowedDomains: ["registry.example"],
  writableRoots: [],
  profileName: "default",
  mode: "trusted",
};

/** A transition into `paused`, carrying no posture — as every non-running one does. */
const PAUSED_DELIVERY: Readonly<Record<string, unknown>> = {
  runId: RUN_ID,
  runVersion: 4,
  previousState: "running",
  currentState: "paused",
  timestamp: "2026-09-02T09:01:00.000Z",
};

/**
 * The run's reading after this projector has folded every delivery in order.
 *
 * The real fold, not a literal: what makes the paused case decisive is that
 * `RunStateProjection` is what clears the member, and a hand-written projection
 * would be this suite asserting its own author's memory of that rule.
 */
function projectionAfter(deliveries: readonly Readonly<Record<string, unknown>>[]): RunProjection {
  const projection = new RunStateProjection();
  for (const delivery of deliveries) {
    if (!projection.accept(delivery)) {
      throw new Error("the fold refused a delivery this suite depends on being readable");
    }
  }
  const [run] = projection.runs();
  if (run === undefined) {
    throw new Error("the fold described no run, so there is no reading to assert");
  }
  return run;
}

/**
 * The run entity as the durable partition holds it once `run.running` has landed.
 *
 * The retained body is the point: the projector's upsert is a spread, so the stamped
 * posture stays on the body through every later transition, and `state` is the member
 * that moves. Both are passed exactly as the store would hold them.
 */
function runEntity(state: string, body: Readonly<Record<string, unknown>>): ConsoleEntity {
  return { kind: "run", id: RUN_ID, state, body };
}

describe("the posture is scoped to the run that is executing under it", () => {
  it("answers the stamp while the run is running", () => {
    const projection = projectionAfter([
      { ...STATE_CHANGE_DELIVERY, executionPosture: SANDBOXED_POSTURE },
    ]);

    expect(
      settledRunPosture(runEntity("running", { executionPosture: SANDBOXED_POSTURE }), projection),
    ).toStrictEqual(SANDBOXED_POSTURE);
  });

  it("answers nothing once a later transition cleared it, retained body and all", () => {
    // The defect. `run.running` stamps the posture; `run.paused` carries none, so the
    // fold clears it — and the entity body still holds the old one because the store's
    // merge is a spread. A reading that preferred the retained value reported a
    // boundary a paused run is not executing under.
    const projection = projectionAfter([
      { ...STATE_CHANGE_DELIVERY, executionPosture: SANDBOXED_POSTURE },
      PAUSED_DELIVERY,
    ]);
    expect(projection.state).toBe("paused");
    expect(projection.executionPosture).toBeUndefined();

    expect(
      settledRunPosture(runEntity("paused", { executionPosture: SANDBOXED_POSTURE }), projection),
    ).toBeUndefined();
  });

  it("answers nothing for a terminal run whose durable body still carries a stamp", () => {
    const projection = projectionAfter([
      { ...STATE_CHANGE_DELIVERY, executionPosture: SANDBOXED_POSTURE },
      {
        runId: RUN_ID,
        runVersion: 5,
        previousState: "running",
        currentState: "completed",
        timestamp: "2026-09-02T09:05:00.000Z",
      },
    ]);

    expect(
      settledRunPosture(
        runEntity("completed", { executionPosture: SANDBOXED_POSTURE }),
        projection,
      ),
    ).toBeUndefined();
  });
});

describe("which source answers for a run that IS running", () => {
  it("takes the stream's stamp over a durable one the store has not caught up to", () => {
    // The other half of the same defect: the durable entry lags the stream, so
    // preferring it renders the boundary of the epoch before this one.
    const projection = projectionAfter([
      { ...STATE_CHANGE_DELIVERY, executionPosture: TRUSTED_POSTURE },
    ]);

    expect(
      settledRunPosture(runEntity("running", { executionPosture: SANDBOXED_POSTURE }), projection),
    ).toStrictEqual(TRUSTED_POSTURE);
  });

  it("falls back to the durable stamp for a run whose start this stream never saw", () => {
    // A subscription opened mid-run: the stream's first transition for this run is
    // the one it delivered, and no stream frame carries the stamp. The durable entry
    // is the only reading there is, and dropping it would replace a known boundary
    // with an unknown one.
    const projection = projectionAfter([STATE_CHANGE_DELIVERY]);
    expect(projection.executionPosture).toBeUndefined();

    expect(
      settledRunPosture(runEntity("running", { executionPosture: SANDBOXED_POSTURE }), projection),
    ).toStrictEqual(SANDBOXED_POSTURE);
  });

  it("negative control: a durable entry that is itself past running answers nothing", () => {
    // Without this the fallback above would re-admit the retained value by the back
    // door whenever the STREAM was the lagging side, which is the same stale
    // boundary read off the other source.
    const projection = projectionAfter([STATE_CHANGE_DELIVERY]);

    expect(
      settledRunPosture(runEntity("paused", { executionPosture: SANDBOXED_POSTURE }), projection),
    ).toBeUndefined();
  });

  it("answers nothing where neither source carries a stamp", () => {
    const projection = projectionAfter([STATE_CHANGE_DELIVERY]);

    expect(settledRunPosture(runEntity("running", {}), projection)).toBeUndefined();
    expect(settledRunPosture(undefined, projection)).toBeUndefined();
  });
});
