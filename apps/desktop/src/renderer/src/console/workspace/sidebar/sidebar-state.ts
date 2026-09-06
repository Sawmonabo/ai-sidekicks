// The sidebar's state, and the record it survives a restart through.
//
// A class rather than a bag of `useState` calls, for the reason the deck's layout is
// one: the width, the collapse, and the open section are one arrangement, and three
// independent pieces of component state would be three places a restore has to write
// and three chances to write only two of them. The component subscribes and
// dispatches; it holds none of this.
//
// THE RESTORE HAPPENS ONCE AND THE SAVE WAITS FOR IT. Exactly the ordering
// `layout-persistence.ts` states for the deck, and for the same failure: a save that
// fired before the restore completed would file the sidebar's opening defaults over
// the arrangement it was about to read, and the result looks identical to a first run.
//
// AND THE SAVE COALESCES THROUGH THE SAME WRITER THE DECK USES. Dragging the sidebar's
// separator commits a width per frame; one durable write per frame would spend the
// store's whole budget on a gesture.

import { useEffect, useState, useSyncExternalStore } from "react";

import { type ConsoleRefusal, type Unsubscribe } from "../../core/index.js";
import { type UiStateStore } from "../../persistence/index.js";
import { type SidebarSectionId } from "../../seats/index.js";
import { useSubjectScopedResource, useSubjectScopedState } from "../../store/index.js";
import { RestoreProgress, refuseWorkspace } from "../layout/layout-persistence.js";
import {
  CoalescingLayoutWriter,
  WRITER_RETIREMENT,
  type PersistedLayoutRecord,
} from "../layout/layout-writer.js";
import {
  INITIAL_SIDEBAR_LAYOUT_STATE,
  SIDEBAR_LAYOUT_RECORD_KEY,
  adoptOverActs,
  chooseSectionOnPress,
  clampSidebarWidthPercent,
  decodeSidebarLayout,
  encodeSidebarLayout,
  sidebarLayoutStatesMatch,
  type SidebarLayoutState,
} from "./sidebar-model.js";

/** Everything the sidebar's surface reads off its state in one render. */
export interface SidebarLayoutSnapshot {
  readonly state: SidebarLayoutState;
  /** What the restore dropped, rendered in the sidebar rather than swallowed. */
  readonly restoreRefusals: readonly ConsoleRefusal[];
  /** Whether the record has been read — the moment the surface announces once. */
  readonly hasSettled: boolean;
}

export class SidebarLayout {
  #snapshot: SidebarLayoutSnapshot = {
    state: INITIAL_SIDEBAR_LAYOUT_STATE,
    restoreRefusals: [],
    hasSettled: false,
  };
  readonly #listeners = new Set<() => void>();

  public snapshot(): SidebarLayoutSnapshot {
    return this.#snapshot;
  }

  public subscribe(listener: () => void): Unsubscribe {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /**
   * Adopt what the record held, and mark the sidebar settled either way.
   *
   * Settled is set even where nothing was saved: "nobody has arranged this sidebar
   * yet" is an answer, and a surface that waited for a record that will never exist
   * would announce nothing on every first visit.
   */
  public adopt(state: SidebarLayoutState, restoreRefusals: readonly ConsoleRefusal[]): void {
    this.#commit({ state, restoreRefusals, hasSettled: true });
  }

  /** Press a section header: open it, or close it where it is already open. */
  public pressSection(sectionId: SidebarSectionId): void {
    this.#commitState({
      ...this.#snapshot.state,
      chosenSectionId: chooseSectionOnPress(sectionId, this.#snapshot.state.chosenSectionId),
    });
  }

  public setCollapsed(isCollapsed: boolean): void {
    this.#commitState({ ...this.#snapshot.state, isCollapsed });
  }

  public toggleCollapsed(): void {
    this.setCollapsed(!this.#snapshot.state.isCollapsed);
  }

  /**
   * Adopt the width the resize settled on.
   *
   * A no-op where the clamped width is the one already held, so a group that reports
   * the same layout on every commit does not queue a durable write per commit.
   */
  public recordWidthPercent(widthPercent: number): void {
    const clamped = clampSidebarWidthPercent(widthPercent);
    if (clamped === this.#snapshot.state.widthPercent) {
      return;
    }
    this.#commitState({ ...this.#snapshot.state, widthPercent: clamped });
  }

  #commitState(state: SidebarLayoutState): void {
    this.#commit({ ...this.#snapshot, state });
  }

  #commit(snapshot: SidebarLayoutSnapshot): void {
    this.#snapshot = snapshot;
    for (const listener of this.#listeners) {
      listener();
    }
  }
}

export interface SidebarPersistenceOptions {
  readonly uiStateStore: UiStateStore;
  /** `undefined` on a route that names no session, where nothing is kept. */
  readonly sessionId: string | undefined;
  readonly onSaveRefused: (refusal: ConsoleRefusal) => void;
}

/**
 * One sidebar arrangement per surface, restored once and kept saved.
 *
 * Returns the layout and its current snapshot together, because every caller needs
 * both — the acts to dispatch and the state to render — and handing back only the
 * object would make each caller subscribe for itself.
 */
export function useSidebarLayout(options: SidebarPersistenceOptions): {
  readonly layout: SidebarLayout;
  readonly snapshot: SidebarLayoutSnapshot;
} {
  const { uiStateStore, sessionId, onSaveRefused } = options;
  const [layout] = useState(() => new SidebarLayout());
  // Held per store, for the reason `layout-persistence.ts` states about the deck's:
  // the `UiStateStore` handed down is replaced on a reconnect without remounting this
  // surface, and a writer that closed over the first one would go on filing the
  // sidebar's width into a store nothing reads again.
  const { value: writer } = useSubjectScopedResource<CoalescingLayoutWriter<PersistedLayoutRecord>>(
    uiStateStore,
    undefined,
    () =>
      new CoalescingLayoutWriter<PersistedLayoutRecord>({
        write: async (partition, snapshot) => {
          const result = await uiStateStore.write(
            partition,
            SIDEBAR_LAYOUT_RECORD_KEY,
            "layout",
            snapshot,
          );
          if (result.outcome === "refused") {
            onSaveRefused(result.refusal);
          }
        },
        onFailed: () => {
          onSaveRefused(
            refuseWorkspace(
              "layout-save-failed",
              "This window's sidebar arrangement could not be saved. It is still on screen, and it will be saved again on the next change.",
            ),
          );
        },
      }),
    // The terminal arm: `flushAndClose` is ONE-WAY, and the reading beside it is how
    // the holder tells a retired writer from a live one after React's double-mount
    // rather than re-committing a writer that drops every later request in silence.
    WRITER_RETIREMENT,
  );

  // Once per `(sidebar, session)`, for the reason `layout-persistence.ts` states: the
  // store is replaced under a live surface and `adopt` replaces the width, the collapse
  // and the open section wholesale, so a gate re-armed by that replacement would put the
  // saved arrangement back over the one the person is looking at.
  const { value: restore } = useSubjectScopedState(layout, sessionId, () => new RestoreProgress());

  useEffect(() => {
    if (sessionId === undefined || !restore.isUnstarted) {
      return;
    }
    restore.start();
    let superseded = false;
    void (async () => {
      // WHAT THE SIDEBAR HELD WHEN THE READ STARTED, so an act the person makes while
      // it is in flight can be told from the arrangement being read. On a navigation
      // between two open sessions this is the previous session's arrangement rather
      // than the opening defaults, which is exactly why it is captured and not assumed.
      const stateBeforeRead = layout.snapshot().state;
      const record = await uiStateStore.read(sessionId, SIDEBAR_LAYOUT_RECORD_KEY);
      if (superseded) {
        return;
      }
      const decoded =
        record === undefined
          ? { state: INITIAL_SIDEBAR_LAYOUT_STATE, refusals: [] }
          : decodeSidebarLayout(record.value);
      // Per axis, so a collapse made during the read is not paid for with the width
      // and the open section the record still holds the person's answer for.
      const adopted = adoptOverActs({
        restored: decoded.state,
        beforeRead: stateBeforeRead,
        live: layout.snapshot().state,
      });
      layout.adopt(adopted, decoded.refusals);

      // OPENED ONLY NOW, WHICH IS THE DECK'S ORDERING AND NOT A SECOND ONE.
      // `adopt` commits unconditionally — it has no equality guard, because the three
      // axes it replaces are the restore's whole job — so a gate opened above it fired
      // this hook's own listener with the record it had just read, and every session a
      // person opened spent a durable write echoing that record back. Where the decode
      // had dropped an axis it wrote the NARROWED value over the record, so what a
      // later build could have read was gone.
      restore.settle();
      if (!sidebarLayoutStatesMatch(adopted, decoded.state)) {
        // ONCE, and only where what the person is looking at is not what the record
        // held: their act during the read, or an arrangement the decode narrowed.
        writer.request(sessionId, encodeSidebarLayout(adopted));
      }
    })();
    return () => {
      superseded = true;
      restore.abandon();
    };
  }, [layout, restore, sessionId, uiStateStore, writer]);

  useEffect(() => {
    if (sessionId === undefined) {
      return;
    }
    return layout.subscribe(() => {
      // Nothing is written before the restore has landed, which is the ordering the
      // deck's own persistence states: a save from the opening defaults would file
      // them over the record this effect is still reading.
      //
      // THE SESSION-SCOPED GATE, NEVER THE LAYOUT'S OWN. `SidebarLayout.hasSettled`
      // is set once by `adopt` on an object held for the mount, so it stays true
      // across a navigation between two open sessions — and in the window where the
      // NEW session's read is still in flight, a divider drag filed the previous
      // session's width and open section under the arriving session's partition,
      // clobbering the record being read. `restore` re-arms per session, so this
      // closes when the session changes and opens again when that session's own
      // record has landed. The layout's `hasSettled` stays what it is for: the
      // announcement its surface makes.
      if (!restore.hasSettled) {
        return;
      }
      writer.request(sessionId, encodeSidebarLayout(layout.snapshot().state));
    });
  }, [layout, restore, sessionId, writer]);

  const snapshot = useSyncExternalStore(
    (listener) => layout.subscribe(listener),
    () => layout.snapshot(),
  );

  return { layout, snapshot };
}
