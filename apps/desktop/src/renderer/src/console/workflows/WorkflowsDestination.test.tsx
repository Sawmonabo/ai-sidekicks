// The destination's one question: which session is this reading from?
//
// Every case here drives the REAL growth port — the fixture's for a scenario that
// answers, the live bridge's refusing one for a scenario that cannot — because the
// defect this surface exists to fix was a scope that could never resolve, and a
// stand-in port would have agreed with whatever the component did. The frame store
// and the session-store registry are the real classes for the same reason: the
// retained session is a fact one of them owns.

import { act, fireEvent, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { createFixtureBridge } from "../bridge/index.js";
import { createRefusingGrowthPort } from "../bridge/growth-port.js";
import { WORKFLOWS_SCENARIO } from "../bridge/scenarios/workflows.js";
import { WORKFLOWS_SESSION_ID } from "../bridge/scenarios/workflow-fixture-data.js";
import type { GrowthPort } from "../bridge/index.js";
import { LiveAnnouncerProvider } from "../primitives/index.js";
import { FrameStore, SessionStoreRegistry } from "../store/index.js";
import { WorkflowsDestination } from "./WorkflowsDestination.js";

/** The fixture's port, which serves both the session directory and the enumeration. */
function fixtureGrowthPort(): GrowthPort {
  return createFixtureBridge({ scenario: WORKFLOWS_SCENARIO }).growth;
}

/**
 * A frame store that has been in a session and has since left it.
 *
 * Built by navigating rather than by writing the field, because the retention rule
 * is the store's: a route that names a session records it, and a route that does not
 * leaves it alone. A test that set the member directly would pass over a store that
 * had stopped retaining anything.
 */
function frameStoreRetaining(sessionId: string): FrameStore {
  const frameStore = new FrameStore({ initialRoute: { kind: "workspace", sessionId } });
  frameStore.navigate({ kind: "workflows" });
  return frameStore;
}

/** A registry with nothing open and a reader that answers nothing. */
function emptyRegistry(): SessionStoreRegistry {
  return new SessionStoreRegistry({ read: () => Promise.resolve(undefined) });
}

function renderDestination(
  growth: GrowthPort,
  frameStore: FrameStore,
  registry: SessionStoreRegistry = emptyRegistry(),
): { readonly container: HTMLElement; readonly rerender: () => void } {
  const element = (
    <LiveAnnouncerProvider>
      <WorkflowsDestination
        growth={growth}
        frameStore={frameStore}
        sessionStoreRegistry={registry}
      />
    </LiveAnnouncerProvider>
  );
  const { container, rerender } = render(element);
  return {
    container,
    rerender: () => {
      rerender(element);
    },
  };
}

/** Let the directory and enumeration reads settle, so an assertion is about answers. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function politeAnnouncement(container: HTMLElement): string {
  const region = container.querySelector<HTMLElement>('[data-live-region="polite"]');
  if (region === null) {
    throw new Error("no polite live region was mounted");
  }
  return region.textContent ?? "";
}

function scopeLine(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>(".meridian-workflows-destination__scope");
}

function definitionNames(container: HTMLElement): readonly string[] {
  return [...container.querySelectorAll(".meridian-definition-row__name")].map(
    (name) => name.textContent ?? "",
  );
}

describe("the workflows destination — the session it reads from", () => {
  it("scopes the browser to the session this window last opened", async () => {
    const { container } = renderDestination(
      fixtureGrowthPort(),
      frameStoreRetaining(WORKFLOWS_SESSION_ID),
    );
    await settle();

    expect(scopeLine(container)?.textContent).toContain(WORKFLOWS_SESSION_ID);
    // The rows the fixture scripts. Their presence is the whole claim: the read went
    // out with a session id, which on the bare route it never could before.
    expect(definitionNames(container)).toContain("Release checks");
  });

  it("negative control: a window that has opened nothing renders no browser at all", async () => {
    // Without this, the case above would pass over a destination that mounted the
    // browser unconditionally and let it render its own three empty groups — which is
    // exactly the surface this component replaced.
    const { container } = renderDestination(fixtureGrowthPort(), new FrameStore());
    await settle();

    expect(scopeLine(container)).toBeNull();
    expect(definitionNames(container)).toStrictEqual([]);
    expect(container.querySelector(".meridian-workflow__scopes")).toBeNull();
  });

  it("asks which session, offering the ones the node's directory answered with", async () => {
    const { container } = renderDestination(fixtureGrowthPort(), new FrameStore());
    await settle();

    expect(container.textContent).toContain("Which session's workflows should this show?");
    expect(
      [...container.querySelectorAll(".meridian-choice-list__choice")].map(
        (choice) => choice.textContent,
      ),
    ).toStrictEqual([WORKFLOWS_SESSION_ID]);
  });

  it("scopes the browser to the session a person picks", async () => {
    const { container } = renderDestination(fixtureGrowthPort(), new FrameStore());
    await settle();
    const choice = container.querySelector(".meridian-choice-list__choice");
    if (!(choice instanceof HTMLElement)) {
      throw new Error("the picker offered no session to choose");
    }

    fireEvent.click(choice);
    await settle();

    expect(scopeLine(container)?.textContent).toContain(WORKFLOWS_SESSION_ID);
    expect(definitionNames(container)).toContain("Release checks");
  });

  it("says the directory was not checked when the port refuses and nothing is open", async () => {
    // "Not checked", never "none": the live bridge refuses the directory read, so the
    // console has not learned that this node has no sessions — it has learned nothing.
    const { container } = renderDestination(createRefusingGrowthPort(), new FrameStore());
    await settle();

    expect(container.textContent).toContain("This window has no session open.");
    expect(container.querySelector(".meridian-choice-list")).toBeNull();
    expect(container.textContent).not.toContain("There are no sessions on this node yet.");
  });
});

describe("the workflows destination — what it announces", () => {
  it("says which session the surface settled on, once", async () => {
    const { container } = renderDestination(
      fixtureGrowthPort(),
      frameStoreRetaining(WORKFLOWS_SESSION_ID),
    );
    await settle();

    expect(politeAnnouncement(container)).toBe(
      `Workflows scoped to session ${WORKFLOWS_SESSION_ID}.`,
    );
  });

  it("negative control: a re-render of the same scope announces nothing further", async () => {
    // The announcement is a settlement, not a description of the current render. A
    // hook that spoke on every pass would repeat this sentence over whatever a person
    // was reading, and the region's text alone cannot tell one announcement from two.
    const { container, rerender } = renderDestination(
      fixtureGrowthPort(),
      frameStoreRetaining(WORKFLOWS_SESSION_ID),
    );
    await settle();
    const region = container.querySelector<HTMLElement>('[data-live-region="polite"]');
    if (region === null) {
      throw new Error("no polite live region was mounted");
    }
    region.textContent = "";

    rerender();
    await settle();

    expect(region.textContent).toBe("");
  });

  it("announces nothing while no session is in scope", async () => {
    // A question is not a settlement. The picker's three absences are the rendering
    // of the directory read, and announcing "nothing is in scope" would be the
    // surface saying twice what it already says once.
    const { container } = renderDestination(fixtureGrowthPort(), new FrameStore());
    await settle();

    expect(politeAnnouncement(container)).toBe("");
  });
});
