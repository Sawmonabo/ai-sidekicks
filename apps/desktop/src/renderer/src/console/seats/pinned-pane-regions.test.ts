// The pinned-region board: who may claim a kind, and what an unfilled one answers.
//
// Two claims carry the module and neither is about a component. First, the duplicate
// policy — a second owner on one pane kind is a conflict rather than a swap decided by
// import order, and the same owner re-claiming is the hot reload the policy exists for.
// Second, the collapse: "nobody filled this kind" and "the body looked at this pane and
// had nothing to say" are one answer at this door, which is what lets the chrome draw
// one branch instead of two.
//
// The planted control is a body that really does return a node, so the emptiness claims
// below it are shown to be about the board rather than about an instrument that reports
// nothing whatever it is handed.

import { describe, expect, it } from "vitest";

// The raise by its declaring module: the core door publishes the registry class and
// not this symbol, for the reason that door states.
import { DuplicateRegistrationError } from "../core/keyed-registry.js";
import { PANE_KINDS } from "./pane-kinds.js";
import { PinnedPaneRegionRegistry, type PinnedPaneRegionContext } from "./pinned-pane-regions.js";

/** A pane scope to ask the board about. The kind is what the board is keyed on. */
function contextFor(overrides: Partial<PinnedPaneRegionContext> = {}): PinnedPaneRegionContext {
  return {
    kind: "timeline",
    sessionId: "session-1",
    channelId: "channel-1",
    runId: undefined,
    ...overrides,
  };
}

describe("pinned pane regions — claiming a kind", () => {
  it("planted control: a registered body's node reaches the door", () => {
    // The instrument, proven on a known-good input before anything below asserts an
    // absence. Without it every emptiness claim here is equally satisfied by a `render`
    // that returns `undefined` unconditionally.
    const board = new PinnedPaneRegionRegistry();

    board.register("timeline", { owner: "planted", render: () => "pinned" });

    expect(board.render(contextFor())).toBe("pinned");
    expect(board.registeredPaneKinds()).toStrictEqual(["timeline"]);
  });

  it("refuses a second owner on one kind, and admits the same owner again", () => {
    const board = new PinnedPaneRegionRegistry();
    board.register("timeline", { owner: "workflows", render: () => "first" });

    expect(() => {
      board.register("timeline", { owner: "collaboration", render: () => "second" });
    }).toThrow(DuplicateRegistrationError);
    // The hot reload: the owning family's module re-runs and replaces its own claim.
    board.register("timeline", { owner: "workflows", render: () => "reloaded" });

    expect(board.render(contextFor())).toBe("reloaded");
  });

  it("hands the body the pane's own scope, verbatim", () => {
    // The card narrows on the channel, so a board that dropped or defaulted a member
    // would leave every region rendering for every pane of its kind.
    const board = new PinnedPaneRegionRegistry();
    const seen: PinnedPaneRegionContext[] = [];
    board.register("timeline", {
      owner: "workflows",
      render: (context) => {
        seen.push(context);
        return null;
      },
    });

    board.render(contextFor({ channelId: undefined, runId: "run-9" }));

    expect(seen).toStrictEqual([
      { kind: "timeline", sessionId: "session-1", channelId: undefined, runId: "run-9" },
    ]);
  });

  it("enumerates claimed kinds in the pane set's own order", () => {
    const board = new PinnedPaneRegionRegistry();
    board.register("approvals", { owner: "composer", render: () => "a" });
    board.register("timeline", { owner: "workflows", render: () => "t" });

    // Declaration order and not insertion order: `timeline` precedes `approvals` in
    // `PANE_KINDS`, and the board was written the other way round on purpose.
    expect(board.registeredPaneKinds()).toStrictEqual(["timeline", "approvals"]);
    expect(PANE_KINDS.indexOf("timeline")).toBeLessThan(PANE_KINDS.indexOf("approvals"));
  });
});

describe("pinned pane regions — an unfilled region", () => {
  it("answers nothing for a kind nobody claimed", () => {
    const board = new PinnedPaneRegionRegistry();
    board.register("timeline", { owner: "workflows", render: () => "pinned" });

    expect(board.render(contextFor({ kind: "runs" }))).toBeUndefined();
  });

  it("answers nothing for a body that decided this pane is not one of its own", () => {
    // The second way of having nothing to pin, and the reason the door collapses the
    // two: a card keyed on a channel returns `null` on a session-scoped pane, and a
    // frame that told that apart from an unclaimed kind would draw the region's box
    // around an element React renders as nothing.
    const board = new PinnedPaneRegionRegistry();
    board.register("timeline", {
      owner: "workflows",
      render: (context) => (context.channelId === undefined ? null : "pinned"),
    });

    expect(board.render(contextFor({ channelId: undefined }))).toBeUndefined();
    expect(board.render(contextFor())).toBe("pinned");
  });

  it("answers nothing for a body that returned false", () => {
    // `false` is a legal `ReactNode` and the shape a `&&` guard produces, so a door
    // that tested only `null` and `undefined` would wrap it.
    const board = new PinnedPaneRegionRegistry();
    board.register("timeline", { owner: "workflows", render: () => false });

    expect(board.render(contextFor())).toBeUndefined();
  });

  it("stops answering once a claim is withdrawn", () => {
    const board = new PinnedPaneRegionRegistry();
    board.register("timeline", { owner: "workflows", render: () => "pinned" });
    board.unregister("timeline");

    expect(board.render(contextFor())).toBeUndefined();
    expect(board.registeredPaneKinds()).toStrictEqual([]);
  });
});
