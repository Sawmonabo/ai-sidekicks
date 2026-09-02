// Which ledger a command acts on — the seam between a chord and a mounted feed.
//
// The ledger's commands are contributed when the console is COMPOSED, before any
// window has rendered and long before a session is open. The acts they perform
// belong to a mounted feed: opening find, walking its matches, scrolling its tail.
// Something has to join the two, and it cannot be a closure — the command is built
// once per window and the feed comes and goes with the route.
//
// So the feed ADOPTS this seat while it is mounted, and every command resolves its
// target at press time. Three properties follow, and each is the reason for the
// shape below:
//
//   • **The newest mount is the target.** The deck will hold more than one pane,
//     and two timeline panes in one window are two feeds. The most recently mounted
//     is the one a chord acts on — a choice this file makes honestly rather than
//     inventing a focus model no surface publishes.
//   • **Release is by identity.** A pane unmounting drops ITS adoption and not
//     whichever happens to be last, so a strict-mode double mount and a route
//     change cannot leave the seat holding a feed that is gone.
//   • **An empty seat is a refusal, not a silence.** `perform` answers with the
//     refusal rather than raising it: this module knows nothing about banners, and
//     the caller that contributed the command is the one that knows where its
//     refusals are rendered.
//
// MODULE SCOPE IS WINDOW SCOPE here, as it is for the command registry: an
// auxiliary window is its own renderer process, so the seat below is per window by
// construction and two windows share nothing.

import { useEffect, useMemo, useRef } from "react";

import { refuse, type ConsoleRefusal, type Unsubscribe } from "../../core/index.js";

/**
 * The acts a mounted ledger offers. One function per command, named for the act
 * rather than for the control that triggers it.
 *
 * Declared HERE rather than beside the commands that consume it, because the seat
 * is what holds one and the command list is what asks for one: with the type on
 * the command side, the two modules would import each other and the layering gate
 * counts a type edge like any other.
 */
export interface LedgerStructureActs {
  readonly openFind: () => void;
  readonly stepFindNext: () => void;
  readonly stepFindPrevious: () => void;
  readonly clearFilters: () => void;
  readonly scrollToTail: () => void;
  readonly collapseAllTerminalChapters: () => void;
  readonly toggleReplay: () => void;
  readonly jumpToNextSeam: () => void;
}

/** One act, by name. Every member is a niladic call, so the name is the whole request. */
export type LedgerActName = keyof LedgerStructureActs;

/** What asking the seat to perform an act produced. */
export type LedgerActOutcome =
  | { readonly status: "performed"; readonly act: LedgerActName }
  | { readonly status: "refused"; readonly refusal: ConsoleRefusal };

/**
 * What an act says when no ledger is mounted.
 *
 * One value rather than one per act: a person pressing a ledger chord from the
 * settings page needs to know the ledger is not here, and naming which of the eight
 * acts they reached for would answer a question they did not ask.
 */
export const LEDGER_NOT_MOUNTED_REFUSAL: ConsoleRefusal = refuse(
  "ledger",
  "ledger.no_mounted_ledger",
  "No ledger is open in this window. Open a session and try again.",
);

/**
 * The mounted feeds, in mount order.
 *
 * A class rather than a module-level array: the adoption list is state, and the
 * console's rule is that state lives behind private fields with the acts that
 * change it.
 */
export class MountedLedgerSeat {
  readonly #adopted: LedgerStructureActs[] = [];

  /** Take the seat for a mount's lifetime. The return value releases exactly this one. */
  public adopt(acts: LedgerStructureActs): Unsubscribe {
    this.#adopted.push(acts);
    return () => {
      const position = this.#adopted.lastIndexOf(acts);
      if (position >= 0) {
        this.#adopted.splice(position, 1);
      }
    };
  }

  /** The ledger a command acts on, or `undefined` while none is mounted. */
  public current(): LedgerStructureActs | undefined {
    return this.#adopted[this.#adopted.length - 1];
  }

  /** How many mounts hold the seat. Read by tests and by the diagnostics surface. */
  public get mountedCount(): number {
    return this.#adopted.length;
  }

  /** Perform one act on the mounted ledger, or answer why it could not be. */
  public perform(act: LedgerActName): LedgerActOutcome {
    const acts = this.current();
    if (acts === undefined) {
      return { status: "refused", refusal: LEDGER_NOT_MOUNTED_REFUSAL };
    }
    acts[act]();
    return { status: "performed", act };
  }
}

/** This window's seat. */
export const mountedLedger: MountedLedgerSeat = new MountedLedgerSeat();

/**
 * Hold the seat for as long as this component is mounted.
 *
 * The acts are read at ACT time through a ref rather than adopted directly: a feed
 * rebuilds its callbacks on every render, and adopting the object itself would
 * either re-seat the ledger on each pass or leave the seat holding the callbacks
 * the first render produced — the same reason the frame's own commands read the
 * retained session at run time instead of closing over it.
 */
export function useMountedLedger(
  acts: LedgerStructureActs,
  seat: MountedLedgerSeat = mountedLedger,
): void {
  const actsRef = useRef(acts);
  actsRef.current = acts;
  const forwarding = useMemo(() => forwardingActs(() => actsRef.current), []);
  useEffect(() => seat.adopt(forwarding), [seat, forwarding]);
}

/** An act set that reads the live one on every call and holds none of it. */
function forwardingActs(read: () => LedgerStructureActs): LedgerStructureActs {
  return {
    openFind: () => {
      read().openFind();
    },
    stepFindNext: () => {
      read().stepFindNext();
    },
    stepFindPrevious: () => {
      read().stepFindPrevious();
    },
    clearFilters: () => {
      read().clearFilters();
    },
    scrollToTail: () => {
      read().scrollToTail();
    },
    collapseAllTerminalChapters: () => {
      read().collapseAllTerminalChapters();
    },
    toggleReplay: () => {
      read().toggleReplay();
    },
    jumpToNextSeam: () => {
      read().jumpToNextSeam();
    },
  };
}
