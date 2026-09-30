// The two engine mount points the builder mounts: an unfilled one is an empty frame, and a
// filled one hands its body exactly what its props type promises. Each filled case also
// asserts the other store never arrives: canvas geometry goes to the durable UI-state store,
// unsent prose to the window-lifetime draft store.

import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { MAXIMUM_LIVE_DRAFT_COUNT } from "@renderer/store/persistence-caps.js";
import { DraftStore } from "@renderer/store/draft-store.js";
import { UiStateStore } from "@renderer/store/persistence/ui-state-store.js";
import { DraftsMountPoint, type DraftsMount } from "./DraftsMountPoint.js";
import { NodeGraphMountPoint, type NodeGraphMount } from "./NodeGraphMountPoint.js";

const DEFINITION_ID = "workflow-definition-01";

/**
 * The real store holding an adapter that never arrives: the subject is which store reaches the
 * body, which a double cannot show. `opening()` is avoided because it opens a database.
 */
function unopenedUiStateStore(): UiStateStore {
  return new UiStateStore({ adapter: new Promise(() => undefined) });
}

/** Every mount point's unfilled rendering, as one table so a third cannot skip a case. */
function unfilledMountPoints(): readonly (readonly [string, React.JSX.Element])[] {
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

describe("an unfilled builder mount point is an empty frame", () => {
  it.each(unfilledMountPoints())(
    "%s stands as its own frame and holds nothing",
    (_name, element) => {
      const { container } = render(element);
      const frames = container.querySelectorAll(".meridian-workflow__mount-point");
      expect(frames).toHaveLength(1);
      expect(frames[0]?.childElementCount).toBe(0);
      expect(frames[0]?.textContent).toBe("");
    },
  );
});

describe("a filled builder mount point receives exactly what the mount promised", () => {
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
    // Identity, not deep equality: every field is private, so a wrong store would pass a
    // structural check.
    expect(body.mock.calls[0]?.[0]?.uiStateStore).toBe(uiStateStore);
    // The first argument only: React owns the argument list of a component it renders.
    expect(body.mock.calls[0]?.[0]).toStrictEqual({
      workflowDefinitionId: DEFINITION_ID,
      uiStateStore,
    });
    expect(container.querySelector(".meridian-workflow__mount-point")?.textContent).toBe(
      "canvas body",
    );
  });

  it("hands the drafts the definition and the window store, and no durable store", () => {
    const draftStore = new DraftStore({ maximumDraftCount: MAXIMUM_LIVE_DRAFT_COUNT });
    const body = vi.fn((_mount: DraftsMount) => <p>inspector body</p>);
    render(
      <DraftsMountPoint workflowDefinitionId={DEFINITION_ID} draftStore={draftStore} body={body} />,
    );
    // The durable store is absent by design: a draft that survived a restart would be user prose
    // in a durable home.
    expect(body.mock.calls[0]?.[0]?.draftStore).toBe(draftStore);
    expect(body.mock.calls[0]?.[0]).toStrictEqual({
      workflowDefinitionId: DEFINITION_ID,
      draftStore,
    });
  });
});
