// The destination's one question: which session is this reading from?
//
// Every case here drives the REAL growth port — the fixture's for a scenario that
// answers, the live bridge's refusing one for a scenario that cannot — because the
// defect this surface exists to fix was a scope that could never resolve, and a
// stand-in port would have agreed with whatever the component did. The frame store
// and the session-store registry are the real classes for the same reason: the
// retained session is a fact one of them owns.

import { act, fireEvent, render } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";

import { createFixtureBridge } from "../bridge/index.js";
import { createRefusingGrowthPort } from "../bridge/growth-port.js";
import { WORKFLOWS_SCENARIO } from "../bridge/scenarios/workflows.js";
import { WORKFLOWS_SCENARIO_DEFINITIONS } from "../bridge/scenarios/workflow-fixture-definitions.js";
import { WORKFLOWS_SESSION_ID } from "../bridge/scenarios/workflow-fixture-ids.js";
import { WORKFLOWS_PARKED_RUN } from "../bridge/scenarios/workflow-fixture-runs.js";
import type { GrowthPort } from "../bridge/index.js";
import { LiveAnnouncerProvider } from "../primitives/index.js";
import { FrameStore, SessionStoreRegistry } from "../store/index.js";
import type { ConsolePaneAddress } from "../seats/index.js";
import { FOLLOWING_WINDOW_RETENTION, type WorkflowsScopeState } from "./destination-scope.js";
import { WorkflowsDestination } from "./WorkflowsDestination.js";

/**
 * The first definition the browser lists, which is the first name a person can press.
 *
 * Read off the fixture's own table rather than written as a literal, so the case that
 * asserts the opened address cannot drift from the row it pressed.
 */
const RELEASE_CHECKS_ID = WORKFLOWS_SCENARIO_DEFINITIONS[0]?.id ?? "";

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

/**
 * The one thing the destination stopped owning: which arm the scope is on.
 *
 * The surface is controlled, because the host above it hands the same answer to a
 * pane it opens. So a case that presses "choose a different session" needs somewhere
 * for that arm to live — and it lives HERE, holding the arm and nothing else. The
 * resolution from arm to session id stays in the component under test, so no case
 * below re-implements the rule it is checking.
 */
function ScopeHolder(props: {
  readonly children: (
    scope: WorkflowsScopeState,
    onScopeChange: (next: WorkflowsScopeState) => void,
  ) => React.JSX.Element;
}): React.JSX.Element {
  const [scope, setScope] = useState<WorkflowsScopeState>(FOLLOWING_WINDOW_RETENTION);
  return props.children(scope, setScope);
}

function renderDestination(
  growth: GrowthPort,
  frameStore: FrameStore,
  registry: SessionStoreRegistry = emptyRegistry(),
): {
  readonly container: HTMLElement;
  readonly rerender: () => void;
  /** Every address this surface asked for a pane at, in the order it asked. */
  readonly openedAddresses: readonly ConsolePaneAddress[];
} {
  // A recording opener rather than a real host: what this surface owes is the exact
  // address per act, and where an opened pane lands is the mounting surface's answer
  // and not this one's.
  const openedAddresses: ConsolePaneAddress[] = [];
  const element = (
    <LiveAnnouncerProvider>
      <ScopeHolder>
        {(scope, onScopeChange) => (
          <WorkflowsDestination
            growth={growth}
            frameStore={frameStore}
            sessionStoreRegistry={registry}
            scope={scope}
            onScopeChange={onScopeChange}
            openPane={(address) => {
              openedAddresses.push(address);
            }}
          />
        )}
      </ScopeHolder>
    </LiveAnnouncerProvider>
  );
  const { container, rerender } = render(element);
  return {
    container,
    openedAddresses,
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

  it("puts the session's runs under its definitions, both read with the same scope", async () => {
    // Two reads under one scope, and the runs half is the one that had no caller at
    // all: the list and its projection were reachable only from their own tests, so
    // the attention-ordered view the family had built could not be reached by a
    // person. One scope feeds both, which is why they are asserted together.
    const { container } = renderDestination(
      fixtureGrowthPort(),
      frameStoreRetaining(WORKFLOWS_SESSION_ID),
    );
    await settle();

    expect(container.querySelector(".meridian-workflows-runs")).not.toBeNull();
    expect(container.querySelectorAll(".meridian-run-row")).toHaveLength(4);
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
    // The runs go with it. An unscoped destination has no session to enumerate for,
    // and a runs section standing there would draw the same absence twice.
    expect(container.querySelector(".meridian-workflows-runs")).toBeNull();
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

  it("shows the picker when a person asks to choose, with a session already in hand", async () => {
    // The path the control exists for, end to end: this window has been in a session,
    // so the destination is scoped without anyone choosing anything, and the button is
    // the only way back to the question. Under the fold this replaced, pressing it
    // resolved to the retained session again and the surface did not move.
    const { container } = renderDestination(
      fixtureGrowthPort(),
      frameStoreRetaining(WORKFLOWS_SESSION_ID),
    );
    await settle();
    const rescope = container.querySelector(".meridian-workflows-destination__rescope");
    if (!(rescope instanceof HTMLElement)) {
      throw new Error("the scoped destination offered no way to choose again");
    }

    fireEvent.click(rescope);
    await settle();

    expect(container.textContent).toContain("Which session's workflows should this show?");
    expect(scopeLine(container)).toBeNull();
  });

  it("scopes to the session picked after asking again, and stops following retention", async () => {
    // The other half of the same control: choosing from the picker it opened settles
    // the scope, so the button is a round trip rather than a one-way door.
    const { container } = renderDestination(
      fixtureGrowthPort(),
      frameStoreRetaining(WORKFLOWS_SESSION_ID),
    );
    await settle();
    const rescope = container.querySelector(".meridian-workflows-destination__rescope");
    if (!(rescope instanceof HTMLElement)) {
      throw new Error("the scoped destination offered no way to choose again");
    }
    fireEvent.click(rescope);
    await settle();
    const choice = container.querySelector(".meridian-choice-list__choice");
    if (!(choice instanceof HTMLElement)) {
      throw new Error("the picker offered no session to choose");
    }

    fireEvent.click(choice);
    await settle();

    expect(scopeLine(container)?.textContent).toContain(WORKFLOWS_SESSION_ID);
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

describe("the workflows destination — what its lists open", () => {
  it("opens the builder on the definition a person pressed", async () => {
    // Before this the name rendered as a plain span: the surface supplied no open
    // action, so the pane kind this family claims was reachable from its own tests
    // and from nowhere a person could reach.
    const { container, openedAddresses } = renderDestination(
      fixtureGrowthPort(),
      frameStoreRetaining(WORKFLOWS_SESSION_ID),
    );
    await settle();
    const name = container.querySelector(".meridian-definition-row__open");
    if (!(name instanceof HTMLElement)) {
      throw new Error("no definition name was pressable");
    }

    fireEvent.click(name);

    expect(openedAddresses).toStrictEqual([
      { kind: "workflow-builder", entity: { kind: "workflow-definition", id: RELEASE_CHECKS_ID } },
    ]);
  });

  it("draws no new-definition control, because nothing in this build authors one", async () => {
    // Absent, not disabled, and not dead: the growth port's ten workflow operations
    // include no write of a definition, so this control used to open a pane with
    // nothing to author. The browser's prop stays optional and unfilled — it is the
    // mechanism a later authoring wire fills, and an entry point appears when its
    // caller supplies the action and not before.
    const { container } = renderDestination(
      fixtureGrowthPort(),
      frameStoreRetaining(WORKFLOWS_SESSION_ID),
    );
    await settle();

    const actionLabels = [...container.querySelectorAll(".meridian-workflow__action")].map(
      (control) => control.textContent,
    );
    expect(actionLabels).not.toContain("New definition");
    // The rows themselves still open, so this is a withheld control and not a
    // browser that lost its actions.
    expect(container.querySelector(".meridian-definition-row__open")).not.toBeNull();
  });

  it("opens the run pane on the run a person pressed", async () => {
    // The parked run leads the list, which is the run an operator is most likely to
    // press — and the one that had no route to the controls that lift its park.
    const { container, openedAddresses } = renderDestination(
      fixtureGrowthPort(),
      frameStoreRetaining(WORKFLOWS_SESSION_ID),
    );
    await settle();
    const name = container.querySelector(".meridian-run-row__open");
    if (!(name instanceof HTMLElement)) {
      throw new Error("no run name was pressable");
    }

    fireEvent.click(name);

    expect(openedAddresses).toStrictEqual([
      {
        kind: "workflow-run",
        entity: { kind: "workflow-run", id: WORKFLOWS_PARKED_RUN.workflowRunId },
      },
    ]);
  });

  it("negative control: nothing is opened until something is pressed", async () => {
    // Without this every case above would pass over a surface that opened a pane on
    // mount, which is a different defect wearing the same assertions.
    const { openedAddresses } = renderDestination(
      fixtureGrowthPort(),
      frameStoreRetaining(WORKFLOWS_SESSION_ID),
    );
    await settle();

    expect(openedAddresses).toStrictEqual([]);
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
