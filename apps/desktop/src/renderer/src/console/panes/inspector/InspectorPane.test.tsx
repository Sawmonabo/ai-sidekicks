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
import { DraftStore, UiStateStore } from "../../persistence/index.js";
import { FrameStore, SessionStore, type ConsoleEntityRef } from "../../store/index.js";
import { ConsolePaneRegistry, type ConsolePaneContext } from "../../workspace/index.js";
import { registerInspectorPane } from "./index.js";
import { InspectorPane } from "./InspectorPane.js";

const SESSION_ID = "session-inspector";

/** A bridge the pane never touches: the inspector reads the store, not the wire. */
const UNUSED_BRIDGE = {} as unknown as ConsoleBridge;

function paneContext(
  entity: ConsoleEntityRef | undefined,
  sessionStore: SessionStore | undefined,
): ConsolePaneContext {
  return {
    kind: "inspector",
    entity,
    paneId: "pane-inspector",
    bridge: UNUSED_BRIDGE,
    frameStore: new FrameStore(),
    sessionStore,
    // An adapter that never settles. The pane performs no UI-state read, so if it
    // ever grew one this would hang here rather than pass against a stub.
    uiStateStore: new UiStateStore({ adapter: new Promise(() => undefined) }),
    draftStore: new DraftStore(),
    focusHue: undefined,
  };
}

function renderPane(
  entity: ConsoleEntityRef | undefined,
  sessionStore: SessionStore | undefined,
): HTMLElement {
  const { container } = render(<InspectorPane {...paneContext(entity, sessionStore)} />);
  return container;
}

describe("the inspector's two boundary absences", () => {
  it("says so when the deck opened it with no entity", () => {
    const container = renderPane(undefined, new SessionStore({ sessionId: SESSION_ID }));
    expect(container.querySelector(".meridian-nothing--not-checked")).not.toBeNull();
    expect(container.textContent).toContain("without an entity to inspect");
  });

  it("says a different thing when there is an entity and no session to read it from", () => {
    const container = renderPane({ kind: "run", id: "run-1" }, undefined);
    expect(container.querySelector(".meridian-nothing--not-checked")).not.toBeNull();
    expect(container.textContent).toContain("outside a session");
  });

  it("negative control: neither absence is the record's own", () => {
    // Both arms above are `not-checked` — nothing was asked. If either rendered
    // the record's `not-loaded` or `empty` instead, the pane would be claiming a
    // read is in flight, or that the entity does not exist, over a question it
    // never put.
    const withoutEntity = renderPane(undefined, new SessionStore({ sessionId: SESSION_ID }));
    expect(withoutEntity.querySelector(".meridian-nothing--not-loaded")).toBeNull();
    expect(withoutEntity.querySelector(".meridian-nothing--empty")).toBeNull();
    const withoutSession = renderPane({ kind: "run", id: "run-1" }, undefined);
    expect(withoutSession.querySelector(".meridian-nothing--not-loaded")).toBeNull();
    expect(withoutSession.querySelector(".meridian-nothing--empty")).toBeNull();
  });
});

describe("the inspector with an entity and a session", () => {
  it("hands the read to the addressed kind's record", () => {
    const store = new SessionStore({ sessionId: SESSION_ID });
    store.initialise({
      cursor: 1,
      entities: [{ kind: "run", id: "run-1", state: "running" }],
      participantJoinLog: [],
    });
    const container = renderPane({ kind: "run", id: "run-1" }, store);
    expect(container.querySelector(".meridian-entity-record")?.textContent).toContain("Run");
    expect(container.querySelector(".meridian-nothing--not-checked")).not.toBeNull();
  });

  it("wears the pane chrome, with the entity in the breadcrumb", () => {
    const store = new SessionStore({ sessionId: SESSION_ID });
    const pane = renderPane({ kind: "run", id: "run-1" }, store).querySelector(".meridian-pane");
    expect(pane?.getAttribute("aria-label")).toContain("run run-1");
    expect(pane?.getAttribute("aria-label")).toContain("Inspector");
  });
});

describe("the pane's registration", () => {
  it("claims the inspector kind and may be torn off into a window", () => {
    const registry = new ConsolePaneRegistry();
    registerInspectorPane(registry);
    expect(registry.descriptorFor("inspector")?.openInWindow).toBe(true);
  });

  it("negative control: it claims nothing else", () => {
    const registry = new ConsolePaneRegistry();
    registerInspectorPane(registry);
    expect(registry.registeredPaneKinds()).toStrictEqual(["inspector"]);
  });
});
