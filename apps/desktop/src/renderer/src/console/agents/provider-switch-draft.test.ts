// The switch draft driven directly: one edit in, the whole consequence out.
//
// Driven here rather than only through the DOM because the interesting values are the
// ones NOT in the draft — the axes the agent arrived with, which ride the request as
// omissions and which the daemon merges back in before it validates anything. A suite
// that could only reach them through a control would be measuring which controls
// exist, which is the view's own suite.

import { describe, expect, it } from "vitest";

import { OVERLAPPING_DRIVER_CATALOG_FIXTURE } from "./driver-catalog-fixtures.js";
import {
  applyAxisDraftEdit,
  bindingSnapshotOf,
  driverMovedIn,
  submittableAxes,
  targetChainOf,
  EMPTY_AXIS_DRAFT,
  type AxisDraft,
} from "./provider-switch-draft.js";
import type { AgentRosterEntry } from "./agent-wire.js";

const CATALOG = OVERLAPPING_DRIVER_CATALOG_FIXTURE;

const ON_SHARED_MODEL: AgentRosterEntry = {
  agentId: "agent-scout",
  driverName: "claude",
  modelId: "shared-model",
  config: { effort: "high", providerAccountId: "account-claude-1", outputSpeed: "fast" },
};

/** One edit against the agent's own binding, the way the view dispatches it. */
function edit(
  draft: AxisDraft,
  axis: Parameters<typeof applyAxisDraftEdit>[1]["axis"],
  value: string | undefined,
): AxisDraft {
  return applyAxisDraftEdit(draft, {
    axis,
    value,
    binding: bindingSnapshotOf(ON_SHARED_MODEL),
    catalog: CATALOG,
  });
}

describe("the switch draft — the binding it is a move away from", () => {
  it("reads every axis of the effective binding, from both places the roster holds them", () => {
    expect(bindingSnapshotOf(ON_SHARED_MODEL)).toEqual({
      driverName: "claude",
      modelId: "shared-model",
      effort: "high",
      providerAccountId: "account-claude-1",
      outputSpeed: "fast",
    });
  });

  it("negative control: an absent axis stays absent rather than becoming a value", () => {
    // `undefined` is what "the provider's default", "never set", and "not reported"
    // all arrive as, and none of them is a value a draft could be compared against.
    expect(bindingSnapshotOf({ agentId: "agent-bare" })).toEqual({});
  });
});

describe("the switch draft — what the agent would run under once it is applied", () => {
  it("resolves an unedited axis from the binding, because omitted means unchanged", () => {
    expect(targetChainOf(EMPTY_AXIS_DRAFT, bindingSnapshotOf(ON_SHARED_MODEL))).toEqual({
      driverName: "claude",
      modelId: "shared-model",
      effort: "high",
    });
  });

  it("stops the agent's own model standing in once the driver moves", () => {
    // A driver move REQUIRES a model of the target driver, so the agent's own never
    // rides such a request — the view holds its actions until one is named.
    const moved = edit(EMPTY_AXIS_DRAFT, "driverName", "codex");
    expect(targetChainOf(moved, bindingSnapshotOf(ON_SHARED_MODEL)).modelId).toBeUndefined();
    expect(driverMovedIn(moved, bindingSnapshotOf(ON_SHARED_MODEL))).toBe(true);
  });

  it("keeps resolving the effort from the binding even across a driver move", () => {
    // Nothing requires an effort of a move, so the agent's own is exactly what the
    // switch would leave it running under — the asymmetry with the model is the
    // form's own, and treating both alike would hide the axis that can still refuse.
    const moved = edit(EMPTY_AXIS_DRAFT, "driverName", "codex");
    expect(targetChainOf(moved, bindingSnapshotOf(ON_SHARED_MODEL)).effort).toBe("high");
  });
});

describe("the switch draft — one edit, with its own consequence", () => {
  it("clears every axis the driver governs when the driver moves", () => {
    const moved = edit(
      { modelId: "shared-model", effort: "low", outputSpeed: "fast" },
      "driverName",
      "codex",
    );
    expect(moved).toEqual({ driverName: "codex" });
  });

  it("negative control: returning to the agent's own driver clears nothing", () => {
    // Without this, the case above would pass over a reducer that cleared on every
    // driver edit, which would throw away a draft for an edit that moved nothing.
    expect(edit({ effort: "low" }, "driverName", "claude")).toEqual({
      driverName: "claude",
      effort: "low",
    });
  });

  it("drops a drafted effort the newly chosen model does not publish", () => {
    expect(edit({ effort: "high" }, "modelId", "claude-only")).toEqual({ modelId: "claude-only" });
  });

  it("negative control: keeps a drafted effort the newly chosen model still publishes", () => {
    expect(edit({ effort: "low" }, "modelId", "claude-only")).toEqual({
      modelId: "claude-only",
      effort: "low",
    });
  });

  it("clears an axis edited back to empty rather than submitting a blank value", () => {
    expect(edit({ providerAccountId: "account-2" }, "providerAccountId", "")).toEqual({});
  });
});

describe("the switch draft — the capability gate on what reaches the wire", () => {
  it("drops an axis the target driver declares no capability for", () => {
    // Reachable without any edit: a flag can go false under a draft nobody touched,
    // and a dispatch against an undeclared capability refuses outright.
    expect(
      submittableAxes({ outputSpeed: "fast", modelId: "shared-model" }, CATALOG, "codex"),
    ).toEqual({ modelId: "shared-model" });
  });

  it("negative control: a declared capability's axis is submitted", () => {
    // Both drivers in this reading declare model mutation, and neither declares a
    // speed axis — so without this the case above would be measuring nothing.
    expect(submittableAxes({ modelId: "shared-model", effort: "low" }, CATALOG, "claude")).toEqual({
      modelId: "shared-model",
      effort: "low",
    });
  });

  it("drops both per-turn axes where the driver is not one the catalog answered for", () => {
    // An unanswered flag is treated exactly as a false one, in either direction.
    expect(submittableAxes({ modelId: "shared-model" }, CATALOG, "gemini")).toEqual({});
  });
});
