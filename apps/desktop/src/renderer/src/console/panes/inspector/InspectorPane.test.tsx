// The pane's two boundary absences, its registration, and the claim that neither
// absence is the record's.
//
// The pane is rendered through the real `ConsolePaneContext` shape rather than a
// props object of its own, because the two questions under test — was an entity
// addressed, and is there a session to read it from — are answered off that
// contract and nowhere else.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { ConsoleBridge } from "../../bridge/index.js";
import { SessionStore } from "../../store/index.js";
import { ConsolePaneRegistry } from "../../seats/index.js";
// The declaring module rather than the door: the predicate is read only from suites.
import { isDetachablePaneKind } from "../../seats/pane-kinds.js";
import { type PaneContextOf } from "../pane-chrome.js";
import { paneContext } from "../pane-chrome.test-support.js";
import { registerInspectorPane } from "./index.js";
import { InspectorPane } from "./InspectorPane.js";

const SESSION_ID = "session-inspector";

/** A bridge the pane never touches: the inspector reads the store, not the wire. */
const UNUSED_BRIDGE = {} as unknown as ConsoleBridge;

/**
 * The entity an inspector is addressed at.
 *
 * Read off the address union rather than widened to `ConsoleEntityRef`: the
 * inspector's arm admits the five sidebar-card kinds the spec enumerates, so a run
 * or a channel reference is refused at the address and never reaches this pane.
 */
type InspectedRef = PaneContextOf<"inspector">["entity"];

function renderPane(
  entity: InspectedRef,
  sessionStore: SessionStore | undefined,
  linkedSourcePaneId?: string,
): HTMLElement {
  const context = paneContext(
    { kind: "inspector", entity },
    {
      bridge: UNUSED_BRIDGE,
      sessionStore,
      ...(linkedSourcePaneId === undefined ? {} : { linkedSourcePaneId }),
    },
  );
  const { container } = render(<InspectorPane {...context} />);
  return container;
}

/** A session store holding the one worktree the link cases inspect. */
function storeWithWorktree(): SessionStore {
  const store = new SessionStore({ sessionId: SESSION_ID });
  store.initialise({
    cursor: 1,
    entities: [{ kind: "worktree", id: "worktree-1", state: "dirty" }],
    participantJoinLog: [],
  });
  return store;
}

describe("the inspector's one boundary absence", () => {
  // There is no case for an inspector opened with no entity, and that is the
  // address union's doing: the inspector's arm REQUIRES one, so the refusal lives
  // at `parseConsolePaneAddress` — where an untyped layout row or route is read —
  // and this body is never reached without it.
  it("says so when there is an entity and no session to read it from", () => {
    const container = renderPane({ kind: "worktree", id: "worktree-1" }, undefined);
    expect(container.querySelector(".meridian-nothing--not-checked")).not.toBeNull();
    expect(container.textContent).toContain("outside a session");
  });

  it("negative control: that absence is not the record's own", () => {
    // The arm above is `not-checked` — nothing was asked. Rendering the record's
    // `not-loaded` or `empty` instead would have the pane claiming a read is in
    // flight, or that the entity does not exist, over a question it never put.
    const withoutSession = renderPane({ kind: "worktree", id: "worktree-1" }, undefined);
    expect(withoutSession.querySelector(".meridian-nothing--not-loaded")).toBeNull();
    expect(withoutSession.querySelector(".meridian-nothing--empty")).toBeNull();
  });
});

describe("the inspector with an entity and a session", () => {
  it("hands the read to the addressed kind's record", () => {
    const store = new SessionStore({ sessionId: SESSION_ID });
    store.initialise({
      cursor: 1,
      entities: [{ kind: "worktree", id: "worktree-1", state: "dirty" }],
      participantJoinLog: [],
    });
    const container = renderPane({ kind: "worktree", id: "worktree-1" }, store);
    expect(container.querySelector(".meridian-entity-record")?.textContent).toContain("Worktree");
    expect(container.querySelector(".meridian-nothing--not-checked")).not.toBeNull();
  });

  it("wears the pane chrome, with the entity in the breadcrumb", () => {
    const store = new SessionStore({ sessionId: SESSION_ID });
    const pane = renderPane({ kind: "worktree", id: "worktree-1" }, store).querySelector(
      ".meridian-pane",
    );
    expect(pane?.getAttribute("aria-label")).toContain("worktree worktree-1");
    expect(pane?.getAttribute("aria-label")).toContain("Inspector");
  });
});

describe("a linked inspector says which pane opened it", () => {
  it("names the source pane the deck opened it from", () => {
    // The deck puts the source pane's id on the seat, and the record has rendered
    // that provenance line all along — the pane was discarding the member before
    // the record could read it, so every linked inspector looked unlinked.
    const container = renderPane(
      { kind: "worktree", id: "worktree-1" },
      storeWithWorktree(),
      "pane-ledger-2",
    );
    const link = container.querySelector(".meridian-entity-record__link");
    expect(link?.textContent).toContain("pane-ledger-2");
    expect(link?.textContent).toContain("Closing that pane does not close this one.");
  });

  it("negative control: an unlinked inspector claims no source pane", () => {
    // Without this, a pane that named some other pane unconditionally would pass
    // the case above and tell every reader their inspector came from somewhere.
    const container = renderPane({ kind: "worktree", id: "worktree-1" }, storeWithWorktree());
    expect(container.querySelector(".meridian-entity-record__link")).toBeNull();
  });
});

describe("the pane's registration", () => {
  it("claims the inspector kind, and the window model refuses it a tear-off", () => {
    const registry = new ConsolePaneRegistry();
    registerInspectorPane(registry);
    expect(registry.descriptorFor("inspector")?.owner).toBe("inspector-pane");
    // The descriptor advertises no detach: `isDetachablePaneKind` is derived from
    // the auxiliary-route set, and the inspector is not one of the two it names.
    expect(isDetachablePaneKind("inspector")).toBe(false);
  });

  it("negative control: it claims nothing else", () => {
    const registry = new ConsolePaneRegistry();
    registerInspectorPane(registry);
    expect(registry.registeredPaneKinds()).toStrictEqual(["inspector"]);
  });
});
