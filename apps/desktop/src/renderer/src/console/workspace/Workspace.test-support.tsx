// What every workspace suite needs to mount one: the session, the registry, and the
// two shapes `AppFrame` mounts the surface in.
//
// ONE HOME RATHER THAN THREE COPIES. The suites split by subject — what the surface
// composes, the arrangement it persists, and the pane moved into a window of its own
// — and every one of them still renders the same component against the same fixture
// session. The mount shape is what they share, and it is the only thing here. Nothing
// in this module asserts.

import { render } from "@testing-library/react";

import { createFixtureBridge, type ConsoleBridge } from "../bridge/index.js";
import type { ConsoleScenario } from "../bridge/scenario.js";
import { DraftStore, UiStateStore } from "../persistence/index.js";
import { LiveAnnouncerProvider } from "../primitives/index.js";
import { MemoryPersistenceAdapter } from "../persistence/memory-adapter.js";
import { FrameStore, SessionStore } from "../store/index.js";
import { ConsolePaneRegistry } from "../seats/index.js";
import { Workspace } from "./Workspace.js";
import { usePaneControls } from "./deck/pane-controls.js";

export const SESSION_ID = "session-workspace";

export const SCENARIO: ConsoleScenario = {
  id: "workspace",
  label: "Workspace",
  purpose: "Drives the workspace surface's composition.",
  sessionId: SESSION_ID,
  participantIdsInJoinOrder: ["participant-you"],
  startedAtIso: "2026-01-01T09:00:00.000Z",
  beats: [],
  replies: [],
};

/**
 * A body that says which kind it is, and offers the host's own detach control.
 *
 * The control is read off `usePaneControls`, which is the seam a real pane header
 * reads it from — so a case that presses it drives the workspace through the same
 * path a person does, rather than through a callback the test invented.
 */
function TestPaneBody(props: { readonly kind: string }): React.JSX.Element {
  const controls = usePaneControls();
  return (
    <p data-body={props.kind}>
      {props.kind} body
      {controls?.onOpenInWindow === undefined ? null : (
        <button type="button" data-detach={props.kind} onClick={controls.onOpenInWindow}>
          Open in a window
        </button>
      )}
    </p>
  );
}

/** A registry whose bodies say which kind they are, so a pane is identifiable. */
export function testRegistry(): ConsolePaneRegistry {
  const registry = new ConsolePaneRegistry();
  for (const kind of ["timeline", "runs"] as const) {
    registry.register({
      kind,
      owner: "workspace-test",
      render: () => <TestPaneBody kind={kind} />,
    });
  }
  return registry;
}

export function sessionStore(): SessionStore {
  const store = new SessionStore({ sessionId: SESSION_ID });
  store.initialise({ cursor: 0, entities: [], participantJoinLog: ["participant-you"] });
  return store;
}

/** One session the workspace can be pointed at, with the store it renders. */
export interface WorkspaceSession {
  readonly sessionId: string;
  readonly store: SessionStore;
}

export const SESSION_B_ID = "session-workspace-b";

/**
 * The workspace under the window's announcer, which is where `AppFrame` mounts it.
 *
 * The deck inside reads `useAnnounce` to say what a pane drop settled on, and that
 * hook throws outside the provider by design — so this wrapper is the production
 * mount shape rather than test scaffolding.
 */
export function renderWorkspace(
  uiStateStore: UiStateStore,
  store?: SessionStore,
): { readonly container: HTMLElement; readonly uiStateStore: UiStateStore } {
  const { container } = render(
    <LiveAnnouncerProvider>
      <Workspace
        bridge={createFixtureBridge({ scenario: SCENARIO })}
        frameStore={new FrameStore({ initialRoute: { kind: "workspace", sessionId: SESSION_ID } })}
        sessionStore={store ?? sessionStore()}
        uiStateStore={uiStateStore}
        draftStore={new DraftStore()}
        route={{ kind: "workspace", sessionId: SESSION_ID }}
        registry={testRegistry()}
      />
    </LiveAnnouncerProvider>,
  );
  return { container, uiStateStore };
}

export function memoryStore(): UiStateStore {
  return new UiStateStore({ adapter: new MemoryPersistenceAdapter() });
}

/** A second session, with a store of its own — never the first one's. */
export function otherSession(): WorkspaceSession {
  const store = new SessionStore({ sessionId: SESSION_B_ID });
  store.initialise({ cursor: 0, entities: [], participantJoinLog: ["participant-you"] });
  return { sessionId: SESSION_B_ID, store };
}

/** The workspace for one session, in the shape `AppFrame` mounts it in. */
export function workspaceFor(
  session: WorkspaceSession,
  uiStateStore: UiStateStore,
  isKeyed: boolean,
  bridge: ConsoleBridge = createFixtureBridge({ scenario: SCENARIO }),
): React.JSX.Element {
  return (
    <LiveAnnouncerProvider>
      <Workspace
        {...(isKeyed ? { key: session.sessionId } : {})}
        bridge={bridge}
        frameStore={
          new FrameStore({ initialRoute: { kind: "workspace", sessionId: session.sessionId } })
        }
        sessionStore={session.store}
        uiStateStore={uiStateStore}
        draftStore={new DraftStore()}
        route={{ kind: "workspace", sessionId: session.sessionId }}
        registry={testRegistry()}
      />
    </LiveAnnouncerProvider>
  );
}
