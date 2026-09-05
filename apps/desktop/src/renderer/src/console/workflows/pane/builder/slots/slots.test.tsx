// The two Plan-017 slots the builder mounts, checked on the two things a slot owes.
//
//   1. **The shell stands while nobody has filled it**, and says the feature has
//      not been built — never a shape that reads as a broken one, and never a word
//      of the governance prose the contract carries.
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

import { DraftStore, UiStateStore } from "../../../../persistence/index.js";
import { WORKFLOW_DRAFT_SLOT, WORKFLOW_GRAPH_SLOT } from "../../../owner-slots.js";
import { DraftsSlot, type DraftsMount } from "./DraftsSlot.js";
import { NodeGraphSlot, type NodeGraphMount } from "./NodeGraphSlot.js";

const DEFINITION_ID = "workflow-definition-01";

/**
 * The real store, holding an adapter that never arrives.
 *
 * The class itself and not a hand-made double, because what is under test is WHICH
 * store reaches the body and a double would prove only that a double was passed
 * along. Its own `opening()` factory is avoided for the reason `WorkflowRunPane`'s
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
      <NodeGraphSlot
        key="node-graph"
        workflowDefinitionId={DEFINITION_ID}
        uiStateStore={unopenedUiStateStore()}
      />,
    ],
    [
      "drafts",
      <DraftsSlot
        key="drafts"
        workflowDefinitionId={DEFINITION_ID}
        draftStore={new DraftStore()}
      />,
    ],
  ];
}

describe("an unfilled builder slot is reserved, not stubbed", () => {
  it.each(unfilledSlots())("%s stands in its own mount with an empty absence", (_name, element) => {
    const { container } = render(element);
    expect(container.querySelectorAll(".meridian-workflow__slot")).toHaveLength(1);
    expect(container.querySelector(".meridian-nothing--empty")).not.toBeNull();
  });

  it.each(unfilledSlots())(
    "%s renders none of the contract's governance prose",
    (_name, element) => {
      const { container } = render(element);
      expect(container.textContent ?? "").not.toContain("Plan-017");
    },
  );

  it("negative control: the contracts really do carry that prose, so the case is not vacuous", () => {
    // Both contracts name their owning task. If neither did, the assertion above
    // would hold over a component that rendered the whole contract verbatim.
    for (const slot of [WORKFLOW_GRAPH_SLOT, WORKFLOW_DRAFT_SLOT]) {
      expect(slot.owningTask).toContain("Plan-017");
    }
  });
});

describe("a filled builder slot receives exactly what the mount promised", () => {
  it("hands the node graph the definition and the durable store, and no draft store", () => {
    const uiStateStore = unopenedUiStateStore();
    const body = vi.fn((_mount: NodeGraphMount) => <p>canvas body</p>);
    const { container } = render(
      <NodeGraphSlot
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
    expect(container.querySelector(".meridian-nothing--empty")).toBeNull();
  });

  it("hands the drafts the definition and the window store, and no durable store", () => {
    const draftStore = new DraftStore();
    const body = vi.fn((_mount: DraftsMount) => <p>inspector body</p>);
    render(<DraftsSlot workflowDefinitionId={DEFINITION_ID} draftStore={draftStore} body={body} />);
    // The durable store is absent by design and not by omission: a draft that
    // survived a restart would be participant prose in a durable home.
    expect(body.mock.calls[0]?.[0]?.draftStore).toBe(draftStore);
    expect(body.mock.calls[0]?.[0]).toStrictEqual({
      workflowDefinitionId: DEFINITION_ID,
      draftStore,
    });
  });

  it("negative control: an unfilled slot calls nothing and keeps its shell", () => {
    const body = vi.fn(() => <p>canvas body</p>);
    const { container } = render(
      <NodeGraphSlot workflowDefinitionId={DEFINITION_ID} uiStateStore={unopenedUiStateStore()} />,
    );
    expect(body).not.toHaveBeenCalled();
    expect(container.querySelector(".meridian-nothing--empty")).not.toBeNull();
  });
});
