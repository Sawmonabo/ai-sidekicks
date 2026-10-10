// The pane block's live arrangement: which panes are open, their order along the row, the side of
// the conversation the block stands on, where the terminal sits, and the widths a person set.
//
// One pane per kind: a second open of a kind focuses the pane already open and re-points it at
// the address's entity. The pane registry (`registries/panes/registry.ts`) enforces one pane per
// entity again structurally, so neither side trusts the other. The terminal is kept last in
// `panes`, so a row position is the same index in both.
//
// State lives in the class rather than React: every mutation publishes one new immutable
// `PaneLayoutState` that React reads through `useSyncExternalStore`, so `useState` never
// becomes a second source of truth.

import type { Unsubscribe } from "#shared/preload-api.js";
import { Emitter } from "#renderer/lib/emitter.js";
import { clampedRowIndex } from "#renderer/hooks/useWindowedRovingIndex.js";
import type { BlockPaneKind } from "#renderer/routing/panes/kinds.js";
import type { BlockPaneAddress, PaneLink } from "#renderer/routing/panes/address.js";
import { paneEntitiesAreEqual } from "#renderer/routing/panes/entity-record.js";
import {
  DEFAULT_PANE_BLOCK_SIDE,
  DEFAULT_TERMINAL_PLACE,
  highestOrdinal,
  rowPanes,
  terminalPane,
  type OpenedPane,
  type PaneLayoutState,
  type SessionPane,
  type TerminalPlace,
} from "./state.js";
import {
  decodePaneLayoutSnapshot,
  encodePaneLayoutSnapshot,
  type PaneLayoutRestoreReport,
  type PaneLayoutSnapshotRecord,
} from "./snapshot.js";

/** The live pane block of one session view; every mutation publishes one new state. */
export class PaneLayoutStore {
  readonly #changes = new Emitter<PaneLayoutState>("pane layout change");
  #state: PaneLayoutState = {
    panes: [],
    focusedPaneId: undefined,
    side: DEFAULT_PANE_BLOCK_SIDE,
    terminalPlace: DEFAULT_TERMINAL_PLACE,
    fullWidthPaneId: undefined,
    paneWidthsPx: {},
    terminalHeightPx: undefined,
    lastOpened: undefined,
    revision: 0,
  };
  #nextPaneOrdinal = 1;
  #openSerial = 0;

  /** The current state. Always the state the last notification carried. */
  public snapshot(): PaneLayoutState {
    return this.#state;
  }

  /** Subscribes to transitions; the `useSyncExternalStore` half. */
  public subscribe(listener: (state: PaneLayoutState) => void): Unsubscribe {
    return this.#changes.subscribe(listener);
  }

  /**
   * Opens a pane, or focuses the one of that kind already open and re-points it at the address's
   * entity, and returns its id. A main pane lands beside the pane it was opened from, else beside
   * the focused pane, else at the row's end; the terminal takes its place against the row. Either
   * way the pane is brought into view, and a pane holding the full width gives it up first.
   */
  public open(address: BlockPaneAddress, link?: PaneLink): string {
    const entity = "entity" in address ? address.entity : undefined;
    const { panes, focusedPaneId } = this.#state;
    const existing = panes.find((pane) => pane.kind === address.kind);
    if (existing !== undefined) {
      this.#commit({
        panes: paneEntitiesAreEqual(existing.entity, entity)
          ? panes
          : panes.map((pane) => (pane.paneId === existing.paneId ? { ...pane, entity } : pane)),
        focusedPaneId: existing.paneId,
        fullWidthPaneId: undefined,
        lastOpened: this.#nextOpened(existing.paneId),
      });
      return existing.paneId;
    }

    const paneId = this.#mintPaneId();
    const sourcePaneId = link?.linkedSourcePaneId;
    const pane: SessionPane = {
      paneId,
      kind: address.kind,
      entity,
      sourcePaneId,
      returnFocusPaneId: focusedPaneId,
    };
    const row = [...rowPanes(panes)];
    const terminal = terminalPane(panes);
    if (pane.kind === "terminal") {
      row.push(pane);
    } else {
      const besideSource = row.findIndex((candidate) => candidate.paneId === sourcePaneId);
      const besideFocus = row.findIndex((candidate) => candidate.paneId === focusedPaneId);
      const anchor = besideSource >= 0 ? besideSource : besideFocus;
      row.splice(anchor >= 0 ? anchor + 1 : row.length, 0, pane);
      if (terminal !== undefined) {
        row.push(terminal);
      }
    }
    this.#commit({
      panes: row,
      focusedPaneId: paneId,
      fullWidthPaneId: undefined,
      lastOpened: this.#nextOpened(paneId),
    });
    return paneId;
  }

  /**
   * Closes one pane, leaving every other where it stands. Focus goes back to the pane that was
   * focused when the closed one opened, while it is still open; a pane holding the full width
   * gives it up first.
   */
  public close(paneId: string): void {
    const { panes, focusedPaneId } = this.#state;
    const closing = panes.find((pane) => pane.paneId === paneId);
    if (closing === undefined) {
      return;
    }
    const survivors = panes.filter((pane) => pane !== closing);
    const isOpen = (candidate: string | undefined): candidate is string =>
      survivors.some((pane) => pane.paneId === candidate);
    let nextFocus = survivors[survivors.length - 1]?.paneId;
    if (focusedPaneId === paneId && isOpen(closing.returnFocusPaneId)) {
      nextFocus = closing.returnFocusPaneId;
    } else if (isOpen(focusedPaneId)) {
      nextFocus = focusedPaneId;
    }
    this.#commit({ panes: survivors, focusedPaneId: nextFocus, fullWidthPaneId: undefined });
  }

  /** Focuses a pane. A pane id the layout does not hold changes nothing. */
  public focus(paneId: string): void {
    if (
      this.#state.focusedPaneId === paneId ||
      !this.#state.panes.some((pane) => pane.paneId === paneId)
    ) {
      return;
    }
    this.#commit({ focusedPaneId: paneId });
  }

  /** Focuses the next or previous pane, the row first and the terminal after it, wrapping. */
  public focusAdjacent(step: 1 | -1): void {
    const { panes, focusedPaneId } = this.#state;
    if (panes.length === 0) {
      return;
    }
    const current = panes.findIndex((pane) => pane.paneId === focusedPaneId);
    const next =
      (((current < 0 ? 0 : current + step) % panes.length) + panes.length) % panes.length;
    const target = panes[next];
    if (target !== undefined) {
      this.focus(target.paneId);
    }
  }

  /**
   * Moves a main pane one place along the row, the keyboard's move. Past the row's end that faces
   * the conversation the whole block moves to the conversation's other side, its order kept; past
   * the end at the window's edge nothing moves.
   */
  public movePane(paneId: string, step: 1 | -1): void {
    const { panes, side } = this.#state;
    const row = rowPanes(panes);
    const from = row.findIndex((pane) => pane.paneId === paneId);
    if (from < 0) {
      return;
    }
    const to = from + step;
    if (to >= 0 && to < row.length) {
      this.#commit({ panes: withRowOrder(panes, from, to) });
      return;
    }
    // The conversation sits left of a block on the right, so the row's first pane faces it.
    const isPastConversation = side === "right" ? to < 0 : to >= row.length;
    if (isPastConversation) {
      this.#commit({ side: side === "right" ? "left" : "right" });
    }
  }

  /** Drops a main pane at a place in the row, the pointer's move; clamped, never refused. */
  public reorderPane(paneId: string, toRowPosition: number): void {
    const { panes } = this.#state;
    const row = rowPanes(panes);
    const from = row.findIndex((pane) => pane.paneId === paneId);
    if (from < 0) {
      return;
    }
    const to = clampedRowIndex(toRowPosition, row.length);
    if (to !== from) {
      this.#commit({ panes: withRowOrder(panes, from, to) });
    }
  }

  /**
   * Moves the whole block to the conversation's other side, a main pane dragged past it landing
   * at the row's end on the far side of the conversation from where it was.
   */
  public moveBlockAcross(paneId: string): void {
    const { panes, side } = this.#state;
    const row = rowPanes(panes);
    const from = row.findIndex((pane) => pane.paneId === paneId);
    if (from < 0) {
      return;
    }
    const nextSide = side === "right" ? "left" : "right";
    this.#commit({
      panes: withRowOrder(panes, from, nextSide === "left" ? 0 : row.length - 1),
      side: nextSide,
    });
  }

  /** Puts the terminal above or below the row; nothing moves with no row beside it. */
  public placeTerminal(place: TerminalPlace): void {
    const { panes, terminalPlace } = this.#state;
    if (
      place === terminalPlace ||
      terminalPane(panes) === undefined ||
      rowPanes(panes).length === 0
    ) {
      return;
    }
    this.#commit({ terminalPlace: place });
  }

  /** Gives one open pane the whole width, or gives the width back with `undefined`. */
  public setFullWidth(paneId: string | undefined): void {
    if (
      this.#state.fullWidthPaneId === paneId ||
      (paneId !== undefined && !this.#state.panes.some((pane) => pane.paneId === paneId))
    ) {
      return;
    }
    this.#commit({ fullWidthPaneId: paneId });
  }

  /** Sets one kind's width in CSS px, or returns it to its default with `undefined`. */
  public setPaneWidth(kind: BlockPaneKind, widthPx: number | undefined): void {
    if (this.#state.paneWidthsPx[kind] === widthPx) {
      return;
    }
    const paneWidthsPx = { ...this.#state.paneWidthsPx };
    if (widthPx === undefined) {
      delete paneWidthsPx[kind];
    } else {
      paneWidthsPx[kind] = widthPx;
    }
    this.#commit({ paneWidthsPx });
  }

  /** Sets the stacked terminal's height in CSS px, or returns it to a third with `undefined`. */
  public setTerminalHeight(heightPx: number | undefined): void {
    if (this.#state.terminalHeightPx !== heightPx) {
      this.#commit({ terminalHeightPx: heightPx });
    }
  }

  /** The record stored under the `layout` value class. */
  public toSnapshot(): PaneLayoutSnapshotRecord {
    return encodePaneLayoutSnapshot(this.#state);
  }

  /**
   * Adopts a snapshot wholesale, dropping what this build cannot interpret. For a layout the
   * person has not touched; one arranged during a slow read uses {@link adoptBeneath}.
   */
  public restore(snapshot: unknown): PaneLayoutRestoreReport {
    const decoded = decodePaneLayoutSnapshot(snapshot);
    this.#nextPaneOrdinal = highestOrdinal(decoded.panes) + 1;
    this.#commit({
      panes: terminalLast(decoded.panes),
      focusedPaneId: decoded.focusedPaneId,
      side: decoded.side,
      terminalPlace: decoded.terminalPlace,
      fullWidthPaneId: undefined,
    });
    return { restoredPaneCount: decoded.panes.length, refusals: decoded.refusals };
  }

  /**
   * Adopts a snapshot beneath an arrangement the person already made while a slow read ran.
   *
   * The layout on screen wins for every kind it holds (ids, order). The record adds only the
   * kinds the layout lacks, minus `retiredKinds`, the kinds closed during the read, since a close
   * leaves nothing in a snapshot; they get fresh ids, since the record's collide with the live
   * ones, and land in front, since they were open first. A side or terminal place the person set
   * during the read stands; otherwise the record's is taken. A layout focusing nothing takes the
   * first adopted pane.
   */
  public adoptBeneath(
    snapshot: unknown,
    retiredKinds: ReadonlySet<BlockPaneKind>,
  ): PaneLayoutRestoreReport {
    const decoded = decodePaneLayoutSnapshot(snapshot);
    const live = this.#state;
    const adopted = decoded.panes
      .filter(
        (pane) =>
          !retiredKinds.has(pane.kind) && !live.panes.some((each) => each.kind === pane.kind),
      )
      .map((pane) => ({ ...pane, paneId: this.#mintPaneId() }));
    const side = live.side === DEFAULT_PANE_BLOCK_SIDE ? decoded.side : live.side;
    const terminalPlace =
      live.terminalPlace === DEFAULT_TERMINAL_PLACE ? decoded.terminalPlace : live.terminalPlace;
    if (adopted.length > 0 || side !== live.side || terminalPlace !== live.terminalPlace) {
      this.#commit({
        panes: terminalLast([...adopted, ...live.panes]),
        focusedPaneId: live.focusedPaneId ?? adopted[0]?.paneId,
        side,
        terminalPlace,
      });
    }
    return { restoredPaneCount: adopted.length, refusals: decoded.refusals };
  }

  /** The next pane id this layout has not used. */
  #mintPaneId(): string {
    const paneId = `pane-${String(this.#nextPaneOrdinal)}`;
    this.#nextPaneOrdinal += 1;
    return paneId;
  }

  #nextOpened(paneId: string): OpenedPane {
    this.#openSerial += 1;
    return { paneId, serial: this.#openSerial };
  }

  #commit(change: Partial<PaneLayoutState>): void {
    this.#state = { ...this.#state, ...change, revision: this.#state.revision + 1 };
    this.#changes.emit(this.#state);
  }
}

/** The panes with the row's pane at `from` moved to `to`, the terminal staying last. */
function withRowOrder(
  panes: readonly SessionPane[],
  from: number,
  to: number,
): readonly SessionPane[] {
  const row = [...rowPanes(panes)];
  const [moved] = row.splice(from, 1);
  if (moved === undefined) {
    return panes;
  }
  row.splice(to, 0, moved);
  const terminal = terminalPane(panes);
  return terminal === undefined ? row : [...row, terminal];
}

/** The panes with the terminal listed last, the row's order kept. */
function terminalLast(panes: readonly SessionPane[]): readonly SessionPane[] {
  const terminal = terminalPane(panes);
  return terminal === undefined ? panes : [...rowPanes(panes), terminal];
}
