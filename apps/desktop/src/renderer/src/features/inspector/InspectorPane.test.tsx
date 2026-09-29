// The pane's two boundary absences, its registration, and the claim that neither
// absence is the record's.
//
// The pane is rendered through the real `PaneContext` shape rather than a
// props object of its own, because the two questions under test — was an entity
// addressed, and is there a session to read it from — are answered off that
// contract and nowhere else.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { PlatformBridge } from "@renderer/services/platform/platform-bridge.js";
import { createFixture } from "@test/helpers/fixture-bridge.js";
import { SessionStore } from "@renderer/store/session/session-store.js";
import { PaneRegistry } from "@renderer/console/seats/index.js";
// The declaring module rather than the door: the predicate is read only from suites.
import { type PaneContextOf } from "@renderer/console/seats/index.js";
import { paneContext } from "@renderer/registries/panes/pane-context.test-support.js";
import { registerInspectorPane } from "./contributions/panes.js";
import { InspectorPane } from "./InspectorPane.js";

const SESSION_ID = "session-inspector";

/**
 * A bridge the pane never touches: the inspector reads the store, not the wire.
 *
 * The shipped fixture rather than an empty object cast to the type, because "never
 * touches it" is a claim rather than a premise: a pane that grew a read would get a
 * real answer here and change what this file renders, where a cast stand-in answers
 * `undefined.something` and fails somewhere that names neither the read nor the pane.
 */
const UNUSED_BRIDGE: PlatformBridge = createFixture().bridge;

/**
 * The entity an inspector is addressed at.
 *
 * Read off the address union rather than widened to `EntityRef`: the
 * inspector's arm admits a workspace or a worktree, so a run or a repo
 * reference is refused at the address and never reaches this pane.
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

/** The element the pane names itself by, resolved the way an assistive reader does. */
function accessibleName(pane: HTMLElement): string {
  const labelledBy = pane.getAttribute("aria-labelledby");
  if (labelledBy === null) {
    throw new Error("the pane names itself by nothing");
  }
  const naming = pane.ownerDocument.getElementById(labelledBy);
  if (naming === null) {
    throw new Error(`the pane names itself by "${labelledBy}", which is on no element`);
  }
  return naming.textContent ?? "";
}

/** A session store holding the one worktree the link cases inspect. */
function storeWithWorktree(): SessionStore {
  const store = new SessionStore({ sessionId: SESSION_ID });
  store.initialize({
    cursor: 1,
    entities: [{ kind: "worktree", id: "worktree-1", state: "dirty" }],
  });
  return store;
}

describe("the inspector's one boundary absence", () => {
  // There is no case for an inspector opened with no entity, and that is the
  // address union's doing: the inspector's arm REQUIRES one, so the refusal lives
  // at `parsePaneAddress` — where an untyped layout row or route is read —
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
    store.initialize({
      cursor: 1,
      entities: [{ kind: "worktree", id: "worktree-1", state: "dirty" }],
    });
    const container = renderPane({ kind: "worktree", id: "worktree-1" }, store);
    expect(container.querySelector(".meridian-entity-record")?.textContent).toContain("Worktree");
    expect(container.querySelector(".meridian-nothing--not-checked")).not.toBeNull();
  });

  it("wears the pane chrome, and is named by its whole trail", () => {
    // The name is `aria-labelledby` and not an `aria-label`: the two cannot both name
    // one element, so the chrome points at the crumb list and the pane's name is
    // "session-inspector worktree-1 Inspector" rather than "Inspector" for every
    // inspector in the deck. The entity contributes its ID and not its kind — the
    // kind is already said by the glyph and the last crumb.
    const store = new SessionStore({ sessionId: SESSION_ID });
    const pane = renderPane({ kind: "worktree", id: "worktree-1" }, store).querySelector(
      ".meridian-pane",
    );
    if (!(pane instanceof HTMLElement)) {
      throw new Error("the inspector rendered no pane element");
    }
    const name = accessibleName(pane);
    expect(name).toContain(SESSION_ID);
    expect(name).toContain("worktree-1");
    expect(name).toContain("Inspector");
  });

  it("negative control: the name is the trail rather than the kind alone", () => {
    // Without this the case above would pass for a chrome that named every pane
    // "Inspector" and happened to render the ids somewhere else in the subtree.
    const store = new SessionStore({ sessionId: SESSION_ID });
    const pane = renderPane({ kind: "worktree", id: "worktree-1" }, store).querySelector(
      ".meridian-pane",
    );
    if (!(pane instanceof HTMLElement)) {
      throw new Error("the inspector rendered no pane element");
    }
    expect(accessibleName(pane)).not.toBe("Inspector");
    expect(pane.getAttribute("aria-label")).toBeNull();
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
  it("claims the inspector kind", () => {
    const registry = new PaneRegistry();
    registerInspectorPane(registry);
    expect(registry.descriptorFor("inspector")?.owner).toBe("inspector-pane");
  });

  it("negative control: it claims nothing else", () => {
    const registry = new PaneRegistry();
    registerInspectorPane(registry);
    expect(registry.registeredPaneKinds()).toStrictEqual(["inspector"]);
  });
});
