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
  applyDraftAction,
  bindingSnapshotOf,
  driverMovedIn,
  rebasedAxes,
  submittableAxes,
  targetChainOf,
  EMPTY_AXIS_DRAFT,
  type AxisDraft,
  type HeldAxisDraft,
} from "./provider-switch-draft.js";
import type { AgentRosterEntry } from "../bridge/index.js";
import type { ProviderAxis } from "./agent-wire.js";

const CATALOG = OVERLAPPING_DRIVER_CATALOG_FIXTURE;

const ON_SHARED_MODEL: AgentRosterEntry = {
  agentId: "agent-scout",
  driverName: "claude",
  modelId: "shared-model",
  config: { effort: "high", providerAccountId: "account-claude-1", outputSpeed: "fast" },
};

const BINDING = bindingSnapshotOf(ON_SHARED_MODEL);

/** A draft already stamped with the agent's own binding, the way a mount starts. */
function held(axes: AxisDraft, binding: AxisDraft = BINDING): HeldAxisDraft {
  return { binding, axes };
}

/** One edit against the agent's own binding, the way the view dispatches it. */
function edit(axes: AxisDraft, axis: ProviderAxis, value: string | undefined): AxisDraft {
  return applyDraftAction(held(axes), {
    kind: "edit",
    axis,
    value,
    binding: BINDING,
    catalog: CATALOG,
  }).axes;
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

describe("the switch draft — a binding that moves under it", () => {
  /** The same agent after another participant moved its effort to the drafted value. */
  const CAUGHT_UP = bindingSnapshotOf({
    ...ON_SHARED_MODEL,
    config: { ...ON_SHARED_MODEL.config, effort: "low" },
  });

  it("drops an axis the binding has caught up with", () => {
    // The whole point: the switch landed, so the draft is no longer a difference and
    // resubmitting it would move nothing — or, on a binding that moved on, move the
    // agent back.
    expect(rebasedAxes(held({ effort: "low" }), CAUGHT_UP)).toEqual({});
  });

  it("keeps an axis the participant is still editing", () => {
    expect(rebasedAxes(held({ effort: "low", providerAccountId: "account-2" }), CAUGHT_UP)).toEqual(
      {
        providerAccountId: "account-2",
      },
    );
  });

  it("negative control: a binding equal to the stamp leaves the draft alone", () => {
    // Compared by VALUE and not by identity: the roster answers with a fresh object
    // on every read, and a draft cleared by a refresh that changed nothing would lose
    // the participant's work for no act of theirs.
    const restated = bindingSnapshotOf({ ...ON_SHARED_MODEL });
    expect(rebasedAxes(held({ effort: "low" }), restated)).toEqual({ effort: "low" });
  });

  it("does not resurrect an axis a later binding moves away from again", () => {
    // The stamp is ADVANCED rather than only compared. Without that, the draft would
    // still be measured against the binding it was born under, and the third move
    // below would report `account-2` as an edit nobody had made since it settled.
    const settled = applyDraftAction(held({ providerAccountId: "account-2" }), {
      kind: "rebase",
      binding: bindingSnapshotOf({
        ...ON_SHARED_MODEL,
        config: { ...ON_SHARED_MODEL.config, providerAccountId: "account-2" },
      }),
    });
    expect(settled.axes).toEqual({});

    const movedOn = bindingSnapshotOf({
      ...ON_SHARED_MODEL,
      config: { ...ON_SHARED_MODEL.config, providerAccountId: "account-3" },
    });
    expect(rebasedAxes(settled, movedOn)).toEqual({});
  });

  it("resolves a kept axis against the binding it was rebased onto, not the old one", () => {
    // A rebase is not a merge. The effort survives — it still differs — but it is now
    // a difference from `claude-only`, whose vocabulary excludes it, which is what the
    // chain rule reads and the view holds its actions on.
    const onLowEffort = bindingSnapshotOf({
      ...ON_SHARED_MODEL,
      config: { ...ON_SHARED_MODEL.config, effort: "low" },
    });
    const movedModel = bindingSnapshotOf({
      ...ON_SHARED_MODEL,
      modelId: "claude-only",
      config: { ...ON_SHARED_MODEL.config, effort: "low" },
    });
    const rebased = rebasedAxes(held({ effort: "high" }, onLowEffort), movedModel);
    expect(rebased).toEqual({ effort: "high" });
    expect(targetChainOf(rebased, movedModel)).toEqual({
      driverName: "claude",
      modelId: "claude-only",
      effort: "high",
    });
  });

  it("rebases before it applies, so one edit lands on the current binding", () => {
    const next = applyDraftAction(held({ effort: "low", providerAccountId: "account-2" }), {
      kind: "edit",
      axis: "providerAccountId",
      value: "account-4",
      binding: CAUGHT_UP,
      catalog: CATALOG,
    });
    expect(next.axes).toEqual({ providerAccountId: "account-4" });
    expect(next.binding).toEqual(CAUGHT_UP);
  });
});
