// The auxiliary-window plane both hand-off suites hand an `AuxiliaryHandoff`.
//
// One module rather than a copy in each: the three window operations it serves are
// the preconditions of every case in both files, and two spellings of "the shell
// works" would let one suite drift into testing a plane the other does not have.

import type { AuxiliaryWindowPaneError, AuxiliaryWindowPaneReturn } from "@ai-sidekicks/contracts";

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

/** A plane that serves the three window operations and refuses everything else. */
export function servingPort(windowId = "aux-window-1"): ConsoleAuxiliaryWindowPort {
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
 * depend on — one window per pane, and a close that reports the return on the signal
 * rather than in its own reply — and in nothing else.
 */
export class ModelledShell {
  readonly #windowIdByPaneId = new Map<string, string>();
  readonly #paneIdByWindowId = new Map<string, string>();
  readonly #paneErrors = new WindowSignalStreams<AuxiliaryWindowPaneError>();
  readonly #paneReturns = new WindowSignalStreams<AuxiliaryWindowPaneReturn>();
  #mintedWindowCount = 0;

  /** The plane an `AuxiliaryHandoff` is handed. */
  public get plane(): ConsoleAuxiliaryWindowPort {
    return {
      detachPane: async (request) => ({
        status: "served",
        value: { windowId: this.#openFor(request.paneId) },
      }),
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
   */
  public windowFor(paneId: string): string | undefined {
    return this.#windowIdByPaneId.get(paneId);
  }

  /** The window stopped being open without anybody asking. Drives the crash arm. */
  public reportWindowLost(windowId: string, reason: string): boolean {
    const paneId = this.#paneIdByWindowId.get(windowId);
    if (paneId === undefined) {
      return false;
    }
    this.#forget(windowId, paneId);
    this.#paneErrors.report({ paneId, reason });
    return true;
  }

  #openFor(paneId: string): string {
    const open = this.#windowIdByPaneId.get(paneId);
    if (open !== undefined) {
      return open;
    }
    this.#mintedWindowCount += 1;
    const windowId = `aux-window-${String(this.#mintedWindowCount)}`;
    this.#windowIdByPaneId.set(paneId, windowId);
    this.#paneIdByWindowId.set(windowId, paneId);
    return windowId;
  }

  #servedForHeld(windowId: string): AuxiliaryWindowOutcome<void> {
    return this.#paneIdByWindowId.has(windowId)
      ? { status: "served", value: undefined }
      : {
          status: "unavailable",
          ...refuse("modelled-shell", "shell-refused", "no window under that handle"),
        };
  }

  #close(windowId: string): AuxiliaryWindowOutcome<void> {
    const paneId = this.#paneIdByWindowId.get(windowId);
    if (paneId === undefined) {
      return this.#servedForHeld(windowId);
    }
    this.#forget(windowId, paneId);
    this.#paneReturns.report({ windowId, paneId });
    return { status: "served", value: undefined };
  }

  #forget(windowId: string, paneId: string): void {
    this.#paneIdByWindowId.delete(windowId);
    this.#windowIdByPaneId.delete(paneId);
  }
}
