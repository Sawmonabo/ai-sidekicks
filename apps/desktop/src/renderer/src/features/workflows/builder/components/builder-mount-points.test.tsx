// The two workflow-engine slots the builder mounts, checked on the two things a slot owes.
//
//   1. **The frame stands while nobody has filled it**, and holds nothing — no copy and
//      no shape that reads as a broken one.
//   2. **The mount obligation is delivered.** A slot's props type is a promise
//      about what the body receives, and a promise nothing checks is prose. Each
//      case below supplies a body and reads back exactly what arrived.
//
// AND ONE THING ONLY THIS PAIR CAN BE CHECKED ON: the two client-local tiers stay
// apart. The canvas's geometry goes to the durable UI-state store and a person's
// unsent prose goes to the window-lifetime draft store, and the mounts are what
// keep a body from reaching the wrong one. So each case asserts the store it was
// handed AND that the other never arrived.

import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { MAXIMUM_LIVE_DRAFT_COUNT } from "@renderer/console/core/constants/persistence-caps.js";
import { DraftStore } from "@renderer/store/draft-store.js";
import { UiStateStore } from "@renderer/store/persistence/ui-state-store.js";
import { DraftsMountPoint, type DraftsMount } from "./DraftsMountPoint.js";
import { NodeGraphMountPoint, type NodeGraphMount } from "./NodeGraphMountPoint.js";

const DEFINITION_ID = "workflow-definition-01";

/**
 * The real store, holding an adapter that never arrives.
 *
 * The class itself and not a hand-made double, because what is under test is WHICH
 * store reaches the body and a double would prove only that a double was passed
 * along. Its own `opening()` factory is avoided for the reason `RunPage`'s
 * tests give for casting a whole context: that path opens a database, and these
 * cases never read or write one. The constructor only wraps what it is handed, so a
 * pending adapter costs nothing and arms nothing.
 */
function unopenedUiStateStore(): UiStateStore {
  return new UiStateStore({ adapter: new Promise(() => undefined) });
}

/** Every slot's unfilled rendering, as one table so a third cannot skip a case. */
function unfilledSlots(): readonly (readonly [string, React.JSX.Element])[] {
  return [
    [
      "node graph",
      <NodeGraphMountPoint
        key="node-graph"
        workflowDefinitionId={DEFINITION_ID}
        uiStateStore={unopenedUiStateStore()}
      />,
    ],
    [
      "drafts",
      <DraftsMountPoint
        key="drafts"
        workflowDefinitionId={DEFINITION_ID}
        draftStore={new DraftStore({ maximumDraftCount: MAXIMUM_LIVE_DRAFT_COUNT })}
      />,
    ],
  ];
}

describe("an unfilled builder slot is an empty frame", () => {
  it.each(unfilledSlots())("%s stands as its own frame and holds nothing", (_name, element) => {
    const { container } = render(element);
    const frames = container.querySelectorAll(".meridian-workflow__slot");
    expect(frames).toHaveLength(1);
    expect(frames[0]?.childElementCount).toBe(0);
    expect(frames[0]?.textContent).toBe("");
  });
});

describe("a filled builder slot receives exactly what the mount promised", () => {
  it("hands the node graph the definition and the durable store, and no draft store", () => {
    const uiStateStore = unopenedUiStateStore();
    const body = vi.fn((_mount: NodeGraphMount) => <p>canvas body</p>);
    const { container } = render(
      <NodeGraphMountPoint
        workflowDefinitionId={DEFINITION_ID}
        uiStateStore={uiStateStore}
        body={body}
      />,
    );
    // Identity and not deep equality: two stores compare equal field-for-field —
    // every field is private — so a body handed the WRONG store would pass a
    // structural check and fail the only one that matters.
    expect(body.mock.calls[0]?.[0]?.uiStateStore).toBe(uiStateStore);
    // The first argument rather than the whole call: React owns the argument list of
    // a component it renders, and an assertion on its arity would be a claim about
    // React rather than about this mount.
    expect(body.mock.calls[0]?.[0]).toStrictEqual({
      workflowDefinitionId: DEFINITION_ID,
      uiStateStore,
    });
    expect(container.querySelector(".meridian-workflow__slot")?.textContent).toBe("canvas body");
  });

  it("hands the drafts the definition and the window store, and no durable store", () => {
    const draftStore = new DraftStore({ maximumDraftCount: MAXIMUM_LIVE_DRAFT_COUNT });
    const body = vi.fn((_mount: DraftsMount) => <p>inspector body</p>);
    render(
      <DraftsMountPoint workflowDefinitionId={DEFINITION_ID} draftStore={draftStore} body={body} />,
    );
    // The durable store is absent by design and not by omission: a draft that
    // survived a restart would be user prose in a durable home.
    expect(body.mock.calls[0]?.[0]?.draftStore).toBe(draftStore);
    expect(body.mock.calls[0]?.[0]).toStrictEqual({
      workflowDefinitionId: DEFINITION_ID,
      draftStore,
    });
  });
});
