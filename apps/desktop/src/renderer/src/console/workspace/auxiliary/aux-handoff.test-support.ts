// The auxiliary-window plane both hand-off suites hand an `AuxiliaryHandoff`.
//
// One module rather than a copy in each: the three window operations it serves are
// the preconditions of every case in both files, and two spellings of "the shell
// works" would let one suite drift into testing a plane the other does not have.

import {
  auxiliaryPaneIdentity,
  type AuxiliaryWindowDetachRequest,
  type AuxiliaryWindowPaneError,
  type AuxiliaryWindowPaneReturn,
} from "@ai-sidekicks/contracts";

import type { AuxiliaryWindowOutcome } from "../../bridge/index.js";
import { WindowSignalStreams } from "../../bridge/window-signal-stream.js";
import { refuse } from "../../core/index.js";
import { type ConsoleAuxiliaryWindowPort } from "./aux-window-signal-watch.js";

/**
 * Every operation refused, as the base each plane below narrows.
 *
 * `shell-absent` because that is what a plane with nothing behind it answers, and
 * the same code the fixture's no-shell arm raises — so a case that forgets to serve
 * an operation reads the production refusal rather than one invented here.
 */
export function refusingPlane(): ConsoleAuxiliaryWindowPort {
  const refuseCall = async (): Promise<AuxiliaryWindowOutcome<never>> => ({
    status: "unavailable",
    ...refuse("aux-handoff-case-plane", "shell-absent", "no shell in this case"),
  });
  return {
    detachPane: refuseCall,
    focusAuxiliary: refuseCall,
    closeAuxiliary: refuseCall,
    subscribePaneErrors: refuseCall,
    subscribePaneReturns: refuseCall,
  };
}

/**
 * The window `servingPort` answers every detach with.
 *
 * Exported because a case that drives a window ENDING has to name the window the
 * detach opened, and a literal spelled again in the case would drift from the one
 * the port mints — silently, into a report about a window no record matches.
 */
export const SERVED_WINDOW_ID = "aux-window-1";

/** A plane that serves the three window operations and refuses everything else. */
export function servingPort(windowId: string = SERVED_WINDOW_ID): ConsoleAuxiliaryWindowPort {
  return {
    ...refusingPlane(),
    detachPane: async () => ({ status: "served", value: { windowId } }),
    focusAuxiliary: async () => ({ status: "served", value: undefined }),
    closeAuxiliary: async () => ({ status: "served", value: undefined }),
  };
}

/** What a rejecting wire says, so a case can read the sentence back off a refusal. */
export const WIRE_REJECTION_MESSAGE = "the auxiliary window channel closed";

/**
 * One rejecting call, shared by both ports below.
 *
 * The shape a shell takes when its transport is gone: the method exists and returns a
 * promise, and the promise rejects. It is the arm no fixture used to produce, which is
 * how four `await`s came to have no rejection path at all. The plane's production
 * adapter settles exactly this into `shell-refused`; these ports reject RAW, so the
 * hand-off's own backstop is what the cases drive.
 */
const rejectWireCall = async (): Promise<never> => {
  throw new Error(WIRE_REJECTION_MESSAGE);
};

/**
 * A shell, modelled: the window bookkeeping a real main process performs, in memory.
 *
 * IT LIVES IN TEST SCAFFOLDING RATHER THAN IN THE FIXTURE BRIDGE, and that placement
 * is the point. A model of the shell used to be the fixture's production answer, so a
 * detach in any fixture build reported a window that had been opened and the deck
 * suppressed the pane's body behind a placeholder with nothing behind it. The fixture
 * now uses the real shell where there is one and refuses where there is not; a model
 * is still exactly what a CASE about the deck's placeholder needs, and here it is
 * scaffolding rather than an answer any person is ever given.
 *
 * It mirrors `src/main/auxiliary-window-ipc.ts` in the two properties the cases above
 * depend on — one window per SESSION's pane, and a close that reports the return on
 * the signal rather than in its own reply — and in nothing else. The session half of
 * that first property is the shell's own rule and not a convenience here: every deck
 * mints `pane-N` from its own layout, so a model keyed on the bare pane id would hand
 * two sessions one window and no case could reach the shape where they differ.
 */
export class ModelledShell {
  readonly #windowIdByPaneIdentity = new Map<string, string>();
  readonly #heldByWindowId = new Map<string, HeldModelledWindow>();
  readonly #paneErrors = new WindowSignalStreams<AuxiliaryWindowPaneError>();
  readonly #paneReturns = new WindowSignalStreams<AuxiliaryWindowPaneReturn>();
  #mintedWindowCount = 0;
  /**
   * The reply every detach parks on while replies are held, and the release that
   * answers them.
   *
   * TWO FIELDS BECAUSE THE PROMISE AND ITS RESOLVE ARE ONE FACT WITH TWO HALVES, and a
   * case drives them from opposite ends: it holds before the detach and releases after
   * it has driven the window's ending. Absent is the ordinary shape — a detach that
   * awaits `undefined` answers on the next microtask, which is what every other case
   * here already depends on.
   */
  #heldDetachReplies: Promise<void> | undefined;
  #releaseHeldDetachReplies: (() => void) | undefined;

  /** The plane an `AuxiliaryHandoff` is handed. */
  public get plane(): ConsoleAuxiliaryWindowPort {
    return {
      detachPane: async (request) => {
        // THE WINDOW OPENS FIRST AND THE REPLY IS WHAT IS HELD, which is the whole
        // interleaving a held case is about: a real shell creates the window and then
        // answers, so a window can end while the renderer has not heard of it yet.
        const windowId = this.#openFor(request);
        await this.#heldDetachReplies;
        return { status: "served", value: { windowId } };
      },
      focusAuxiliary: async (request) => this.#servedForHeld(request.windowId),
      closeAuxiliary: async (request) => this.#close(request.windowId),
      subscribePaneErrors: async () => ({
        status: "served",
        value: this.#paneErrors.subscribe(),
      }),
      subscribePaneReturns: async () => ({
        status: "served",
        value: this.#paneReturns.subscribe(),
      }),
    };
  }

  /**
   * The window this shell opened for one pane, so a case can address it.
   *
   * Read back rather than scraped out of the deck's markup: the handle is the shell's
   * to mint, and a case that read it off an attribute would be asserting against
   * whatever the layout library happened to render.
   *
   * The session is asked for because it is half of what the window was filed under —
   * a lookup by the bare pane id would answer for whichever session detached first.
   */
  public windowFor(paneId: string, sessionId?: string): string | undefined {
    return this.#windowIdByPaneIdentity.get(auxiliaryPaneIdentity(sessionId, paneId));
  }

  /**
   * Hold every detach REPLY until {@link releaseDetachReplies}, opening the window as
   * usual. What a case about an ending before the fulfillment drives.
   */
  public holdDetachReplies(): void {
    this.#heldDetachReplies = new Promise<void>((resolve) => {
      this.#releaseHeldDetachReplies = resolve;
    });
  }

  /** Answer every held detach, and take replies off hold. */
  public releaseDetachReplies(): void {
    const release = this.#releaseHeldDetachReplies;
    this.#heldDetachReplies = undefined;
    this.#releaseHeldDetachReplies = undefined;
    release?.();
  }

  /** The window stopped being open without anybody asking. Drives the crash arm. */
  public reportWindowLost(windowId: string, reason: string): boolean {
    const held = this.#heldByWindowId.get(windowId);
    if (held === undefined) {
      return false;
    }
    this.#forget(windowId, held.paneIdentity);
    this.#paneErrors.report({ windowId, paneId: held.paneId, reason });
    return true;
  }

  #openFor(request: AuxiliaryWindowDetachRequest): string {
    const paneIdentity = auxiliaryPaneIdentity(request.sessionId, request.paneId);
    const open = this.#windowIdByPaneIdentity.get(paneIdentity);
    if (open !== undefined) {
      return open;
    }
    this.#mintedWindowCount += 1;
    const windowId = `aux-window-${String(this.#mintedWindowCount)}`;
    this.#windowIdByPaneIdentity.set(paneIdentity, windowId);
    this.#heldByWindowId.set(windowId, { paneIdentity, paneId: request.paneId });
    return windowId;
  }

  #servedForHeld(windowId: string): AuxiliaryWindowOutcome<void> {
    return this.#heldByWindowId.has(windowId)
      ? { status: "served", value: undefined }
      : {
          status: "unavailable",
          ...refuse("modelled-shell", "shell-refused", "no window under that handle"),
        };
  }

  #close(windowId: string): AuxiliaryWindowOutcome<void> {
    const held = this.#heldByWindowId.get(windowId);
    if (held === undefined) {
      return this.#servedForHeld(windowId);
    }
    this.#forget(windowId, held.paneIdentity);
    this.#paneReturns.report({ windowId, paneId: held.paneId });
    return { status: "served", value: undefined };
  }

  #forget(windowId: string, paneIdentity: string): void {
    this.#heldByWindowId.delete(windowId);
    this.#windowIdByPaneIdentity.delete(paneIdentity);
  }
}

/** A plane whose five window operations reject rather than answering. */
export function rejectingPort(): ConsoleAuxiliaryWindowPort {
  return {
    detachPane: rejectWireCall,
    focusAuxiliary: rejectWireCall,
    closeAuxiliary: rejectWireCall,
    subscribePaneErrors: rejectWireCall,
    subscribePaneReturns: rejectWireCall,
  };
}

/**
 * A plane that detaches for real and then rejects both controls a placeholder offers.
 *
 * The two operations only reachable AFTER a detach, so a case about them has to be
 * handed a wire that serves the detach and fails afterwards — which is also the real
 * sequence, since a window is what stops being reachable.
 */
export function detachingThenRejectingPort(): ConsoleAuxiliaryWindowPort {
  return {
    ...servingPort(),
    focusAuxiliary: rejectWireCall,
    closeAuxiliary: rejectWireCall,
  };
}

/** One window this model is holding: what it is filed under, and what it renders. */
interface HeldModelledWindow {
  readonly paneIdentity: string;
  readonly paneId: string;
}
