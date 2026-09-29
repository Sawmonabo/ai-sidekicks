// What every session screen suite needs to mount one: the session, the registry, and the shape
// `AppFrame` mounts the surface in.
//
// ONE HOME RATHER THAN A COPY PER SUITE. The suites split by subject — what the surface
// composes and the arrangement it persists — and every one of them renders the same
// component against the same fixture session. The mount shape is what they share.

import { render } from "@testing-library/react";
import { expect } from "vitest";

import { PANE_LAYOUT_RESTORED_PANE_CAP } from "./pane-layout/pane-layout-store.js";
import { MAXIMUM_LIVE_DRAFT_COUNT } from "@renderer/store/persistence-caps.js";
import { PlatformBridgeProvider } from "@renderer/services/platform/PlatformBridgeProvider.js";
import { createFixtureBridge } from "@renderer/services/platform/platform-bridge.fixture.js";
import { type PlatformBridge } from "@renderer/services/platform/platform-bridge.js";
import type { Scenario } from "../../../../../fixtures/scenario.js";
import type { StoredRecord } from "@renderer/store/persistence/persistence-adapter.js";
import { DraftStore } from "@renderer/store/draft-store.js";
import { UiStateStore } from "@renderer/store/persistence/ui-state-store.js";
import { LiveAnnouncerProvider } from "@renderer/console/primitives/index.js";
import { MemoryPersistenceAdapter } from "@renderer/store/persistence/memory-persistence-adapter.js";
import { WindowStore } from "@renderer/store/window/window-store.js";
import { SessionStore } from "@renderer/store/session/session-store.js";
import { PaneRegistry } from "@renderer/console/seats/index.js";
import { PaneLayoutStore } from "./pane-layout/pane-layout-store.js";
import { PANE_LAYOUT_RECORD_KEY } from "./pane-layout/layout-persistence.js";
import { SessionScreen } from "./SessionScreen.js";

export const SESSION_ID = "session-screen";

export const SCENARIO: Scenario = {
  id: "session-screen",
  label: "Session screen",
  purpose: "Drives the session screen's composition.",
  sessionId: SESSION_ID,
  userIdsInJoinOrder: ["user-you"],
  startedAtIso: "2026-01-01T09:00:00.000Z",
  beats: [],
  replies: [],
};

/** One session the session screen can be pointed at, with the store it renders. */
export interface SessionWithStore {
  readonly sessionId: string;
  readonly store: SessionStore;
}

/** A registry whose bodies say which kind they are, so a pane is identifiable. */
export function testRegistry(): PaneRegistry {
  const registry = new PaneRegistry();
  for (const kind of ["transcript", "terminal"] as const) {
    registry.register({
      kind,
      owner: "session-screen-test",
      render: () => <TestPaneBody kind={kind} />,
    });
  }
  return registry;
}

/**
 * One opened session store — the family's one home for this role.
 *
 * The test rules in `apps/desktop/AGENTS.md` put one home per ROLE: two spellings of "an
 * opened session" is two fixtures that agree until one of them is corrected.
 */
export function sessionStore(sessionId: string = SESSION_ID): SessionStore {
  const store = new SessionStore({ sessionId });
  store.initialize({ cursor: 0, entities: [] });
  return store;
}

/** A body that says which kind it is, so a pane is identifiable in the rendered pane layout. */
function TestPaneBody(props: { readonly kind: string }): React.JSX.Element {
  return <p data-body={props.kind}>{props.kind} body</p>;
}

export const SESSION_B_ID = "session-screen-b";

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

/**
 * The session screen under the window's providers, which is where `AppFrame` mounts it.
 *
 * The pane layout inside reads `useAnnounce` to say what a pane drop settled on, and that
 * hook throws outside the provider by design — so this wrapper is the production
 * mount shape rather than test scaffolding.
 */
export function renderSessionScreen(
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
export function otherSession(): SessionWithStore {
  const store = new SessionStore({ sessionId: SESSION_B_ID });
  store.initialize({ cursor: 0, entities: [] });
  return { sessionId: SESSION_B_ID, store };
}

/**
 * The session screen for one session, in the shape `AppFrame` mounts it in.
 *
 * The provider carries the SAME bridge the surface is handed, because that is what the
 * frame does: one window, one transport, and one clock resolved off it — the pane layout reads
 * that clock for its rect tracker.
 */
export function workspaceFor(
  session: SessionWithStore,
  uiStateStore: UiStateStore,
  isKeyed: boolean,
  bridge: PlatformBridge = createFixtureBridge({ scenario: SCENARIO }),
): React.JSX.Element {
  return (
    <PlatformBridgeProvider bridge={bridge}>
      <LiveAnnouncerProvider>
        <SessionScreen
          {...(isKeyed ? { key: session.sessionId } : {})}
          bridge={bridge}
          frameStore={
            new WindowStore({ initialRoute: { kind: "session", sessionId: session.sessionId } })
          }
          sessionStore={session.store}
          uiStateStore={uiStateStore}
          draftStore={new DraftStore({ maximumDraftCount: MAXIMUM_LIVE_DRAFT_COUNT })}
          route={{ kind: "session", sessionId: session.sessionId }}
          paneRegistry={testRegistry()}
        />
      </LiveAnnouncerProvider>
    </PlatformBridgeProvider>
  );
}

/** A saved arrangement for one session, written by the grammar that reads it back. */
export async function saveLayout(
  store: UiStateStore,
  partition: string,
  kinds: readonly ("transcript" | "terminal")[],
): Promise<void> {
  const layout = new PaneLayoutStore({ restoredPaneCap: PANE_LAYOUT_RESTORED_PANE_CAP });
  for (const kind of kinds) {
    layout.open({ kind });
  }
  const result = await store.write(
    partition,
    PANE_LAYOUT_RECORD_KEY,
    "layout",
    layout.toSnapshot(),
  );
  expect(result.outcome).toBe("written");
}
