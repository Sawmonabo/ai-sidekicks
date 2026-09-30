// The pane's boundary absence, its registration, and that the absence is not the record's.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { PlatformBridge } from "@renderer/services/platform/platform-bridge.js";
import { createFixture } from "@test/helpers/fixture-bridge.js";
import { SessionStore } from "@renderer/store/session/session-store.js";
import { PaneRegistry } from "@renderer/registries/panes/pane-registry.js";
import { type PaneContextOf } from "@renderer/registries/panes/pane-body-for-kind.js";
import { paneContext } from "@renderer/registries/panes/pane-context.test-support.js";
import { registerInspectorPane } from "./contributions/panes.js";
import { InspectorPane } from "./InspectorPane.js";

const SESSION_ID = "session-inspector";

// The shipped fixture rather than a cast stand-in: a stand-in fails with `undefined.something`
// far from the read that caused it.
const UNUSED_BRIDGE: PlatformBridge = createFixture().bridge;

// Read off the address union rather than widened to `EntityRef`: the inspector's arm admits
// only a workspace or a worktree.
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

function storeWithWorktree(): SessionStore {
  const store = new SessionStore({ sessionId: SESSION_ID });
  store.initialize({
    cursor: 1,
    entities: [{ kind: "worktree", id: "worktree-1", state: "dirty" }],
  });
  return store;
}

describe("the inspector's one boundary absence", () => {
  // No case for an inspector opened with no entity: `parsePaneAddress` refuses it, so this
  // body is never reached without one.
  it("says so when there is an entity and no session to read it from", () => {
    const container = renderPane({ kind: "worktree", id: "worktree-1" }, undefined);
    expect(container.querySelector(".meridian-nothing--not-checked")).not.toBeNull();
    expect(container.textContent).toContain("outside a session");
  });

  it("negative control: that absence is not the record's own", () => {
    // `not-checked`, nothing was asked. The record's `not-loaded` or `empty` would claim a read
    // in flight or a missing entity.
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
    // `aria-labelledby` on the crumb list, since it and `aria-label` cannot both name one
    // element: the name is the whole trail, not "Inspector" for every pane.
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
    // Without this the case above passes for a chrome naming every pane "Inspector".
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
  it("names the source pane the pane layout opened it from", () => {
    // The pane layout puts the source pane's id on the pane context; the pane must pass it on.
    const container = renderPane(
      { kind: "worktree", id: "worktree-1" },
      storeWithWorktree(),
      "pane-transcript-2",
    );
    const link = container.querySelector(".meridian-entity-record__link");
    expect(link?.textContent).toContain("pane-transcript-2");
    expect(link?.textContent).toContain("Closing that pane does not close this one.");
  });

  it("negative control: an unlinked inspector claims no source pane", () => {
    // Without this, a pane naming some other pane unconditionally would pass the case above.
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
