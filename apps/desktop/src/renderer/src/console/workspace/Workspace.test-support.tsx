// What every workspace suite needs to mount one: the session, the registry, and the
// two shapes `AppFrame` mounts the surface in.
//
// ONE HOME RATHER THAN THREE COPIES. The suites split by subject — what the surface
// composes, the arrangement it persists, and the pane moved into a window of its own
// — and every one of them still renders the same component against the same fixture
// session. The mount shape is what they share, and it is the only thing here. Nothing
// in this module asserts.

import { render } from "@testing-library/react";
import { useContext } from "react";
import { expect } from "vitest";

import { DECK_RESTORED_PANE_CAP } from "../core/index.js";
import {
  SidekicksBridgeProvider,
  createFixtureBridge,
  type ConsoleBridge,
} from "../bridge/index.js";
import type { ConsoleScenario } from "../bridge/scenario-runtime/scenario.js";
import type { StoredRecord } from "../persistence/adapter.js";
import { DraftStore, UiStateStore } from "../persistence/index.js";
import { LiveAnnouncerProvider } from "../primitives/index.js";
import { MemoryPersistenceAdapter } from "../persistence/memory-adapter.js";
import { FrameStore, SessionStore } from "../store/index.js";
import { ConsolePaneRegistry, PaneControlsContext } from "../seats/index.js";
import { DeckLayout } from "./deck/deck-layout.js";
import { DECK_LAYOUT_RECORD_KEY } from "./layout/layout-persistence.js";
import { Workspace } from "./Workspace.js";

export const SESSION_ID = "session-workspace";

/**
 * The pane the workspace's fallback timeline lands in.
 *
 * The follow seat is keyed by pane, so a case that fills it has to name one.
 * `DeckLayout` mints `pane-1` for the first pane it opens and the workspace opens
 * exactly one — the fallback ledger — so this is that pane's id and not a guess. The
 * case that uses it asserts the deck holds a single pane first, which is what keeps
 * the derivation checkable rather than assumed.
 */
export const WORKSPACE_TIMELINE_PANE_ID = "pane-1";

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
 * The control is read off `PaneControlsContext`, which is the seam
 * `seats/ConsolePaneChrome` reads it from — so a case that presses it drives the
 * workspace through the same path a person does, rather than through a callback the
 * test invented. Through the context itself rather than the `usePaneControls` hook
 * beside it, because the hook is not a door line and a deep cross-family import is
 * one this file is not exempt from: the layering cruise excludes `*.test.*` and a
 * `.test-support` module is not one.
 */
function TestPaneBody(props: { readonly kind: string }): React.JSX.Element {
  const controls = useContext(PaneControlsContext);
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

/**
 * One opened session store — the family's one home for this role.
 *
 * The sidebar's own support module held this verbatim under the same name, and the
 * restore-order suite held the `UiStateStore` half under a third. AGENTS.md §Tests
 * puts one home per ROLE: two spellings of "an opened session" is two fixtures that
 * agree until one of them is corrected.
 */
export function sessionStore(sessionId: string = SESSION_ID): SessionStore {
  const store = new SessionStore({ sessionId });
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
    workspaceFor({ sessionId: SESSION_ID, store: store ?? sessionStore() }, uiStateStore, false),
  );
  return { container, uiStateStore };
}

/** One in-memory `UiStateStore` — the family's one home for this role. */
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
  // The provider carries the SAME bridge the surface is handed, because that is the
  // shape the frame mounts: one window, one transport, and one clock resolved off it
  // — the deck reads that clock for its rect tracker, and a provider carrying another
  // bridge would be two time bases in a window production only ever gives one.
  return (
    <SidekicksBridgeProvider bridge={bridge}>
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
    </SidekicksBridgeProvider>
  );
}

// The three scaffolding pieces below are shared rather than declared per suite: the
// store-swap suite drives the same gated adapter the navigation suite does, and a
// second copy of a write ledger is two ledgers that can disagree about what was asked.

/**
 * The memory adapter, plus a gate a test closes and a ledger of what was asked.
 *
 * Two things the plain adapter cannot give. The GATE holds a write open, which is
 * what puts a second arrangement in the writer's pending slot — the state a coalescing
 * writer spends a whole resize drag in, and the only state in which the partition it
 * files under can disagree with the one that asked. The LEDGER records the partition
 * every write NAMED, so the assertion is about where an arrangement was filed rather
 * than about which record happened to be written last.
 */
export class GatedPersistenceAdapter extends MemoryPersistenceAdapter {
  readonly asked: { readonly partition: string; readonly value: unknown }[] = [];
  #writeGate = new SettlementGate();
  #readGate = new SettlementGate();

  public holdWrites(): void {
    this.#writeGate.close();
  }

  public releaseWrites(): void {
    this.#writeGate.open();
  }

  /** Holds the arriving session's restore open, so the ordering is decided here. */
  public holdReads(): void {
    this.#readGate.close();
  }

  public releaseReads(): void {
    this.#readGate.open();
  }

  public override async read(partition: string, key: string): Promise<StoredRecord | undefined> {
    await this.#readGate.passed();
    return super.read(partition, key);
  }

  public override async write(record: StoredRecord): Promise<void> {
    this.asked.push({ partition: record.partition, value: record.value });
    await this.#writeGate.passed();
    await super.write(record);
  }
}

/** One gate a test opens and closes. Open by default, so nothing waits by accident. */
class SettlementGate {
  #held: Promise<void> | undefined;
  #open: (() => void) | undefined;

  public close(): void {
    this.#held = new Promise<void>((resolve) => {
      this.#open = resolve;
    });
  }

  public open(): void {
    this.#open?.();
    this.#open = undefined;
    this.#held = undefined;
  }

  public async passed(): Promise<void> {
    await this.#held;
  }
}

/** A saved arrangement for one session, written by the grammar that reads it back. */
export async function saveLayout(
  store: UiStateStore,
  partition: string,
  kinds: readonly ("timeline" | "runs")[],
): Promise<void> {
  const layout = new DeckLayout({ restoredPaneCap: DECK_RESTORED_PANE_CAP });
  for (const kind of kinds) {
    layout.open({ kind, entity: undefined });
  }
  const result = await store.write(
    partition,
    DECK_LAYOUT_RECORD_KEY,
    "layout",
    layout.toSnapshot(),
  );
  expect(result.outcome).toBe("written");
}
