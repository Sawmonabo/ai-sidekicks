// A session's shells as the pane reads them, kept current off the shell list for the session on
// screen, with the tab this pane shows. Opening the pane reads the shells the session really has,
// and a fresh shell is opened only when that first read finds none, once per visit, so closing the
// last tab leaves the pane empty rather than opening another.
//
// The active tab is this pane's own: the list's first on the first read; a shell this pane opened
// once the list carries it, whose body then takes the focus; the neighbor of a closed active tab;
// and a shell another device opened only when no tab was active.
//
// A close of a shell another of the person's devices holds is asked first: the shells held
// elsewhere wait on the person's answer and go with `force` once they confirm. A close the daemon
// refuses because another device took the shell meanwhile is asked the same way.

import { useCallback, useEffect } from "react";

import type { RefusalCode } from "@ai-sidekicks/contracts/jsonrpc/refusal";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import type { TerminalId, TerminalListEntry } from "@ai-sidekicks/contracts/terminal";

import { useSubjectScopedState } from "#renderer/hooks/subject-scoped/useSubjectScopedState.js";
import type { Refusal } from "#renderer/lib/refusal/contract.js";
import { callDaemon } from "#renderer/services/daemon/reply.js";
import { followShellList } from "#renderer/services/daemon/terminal/list.js";
import type { PlatformBridge } from "#renderer/services/platform/bridge.js";

/** The session's shells in tab order and the one shown, with the acts the tab strip sends. */
export interface SessionShells {
  /** The shells in tab order, `undefined` until the list is read. */
  readonly terminals: readonly TerminalListEntry[] | undefined;
  /** The shell the pane shows, `undefined` while no tab is active. */
  readonly activeTerminalId: TerminalId | undefined;
  /** A shell this pane opened and now shows, whose body takes the focus as it appears. */
  readonly openedTerminalId: TerminalId | undefined;
  /** Whether a shell this pane asked for is not yet on the list. */
  readonly isOpening: boolean;
  /** Whether this pane sent the newest close, so an emptied strip hands the focus to its `+`. */
  readonly hasClosedHere: boolean;
  /** The shells another device holds whose close waits on the person's answer. */
  readonly heldShellsAsked: readonly TerminalListEntry[];
  /** Why the list could not be opened again, or a shell could not be opened, closed or moved. */
  readonly refusal: Refusal | undefined;
  readonly selectShell: (terminalId: TerminalId) => void;
  /** Open another shell and show it once the list carries it. */
  readonly openShell: () => void;
  /**
   * Close the shells' tabs and end their shells; a tab goes when the list drops it. Shells another
   * device holds are asked about first.
   */
  readonly closeShells: (terminalIds: readonly TerminalId[]) => void;
  /** The person's answer to the close question: close the held shells, or keep them. */
  readonly answerCloseQuestion: (isConfirmed: boolean) => void;
  /** Move a shell to `toIndex` in the list without it, answering the refusal if it is refused. */
  readonly reorderShell: (terminalId: TerminalId, toIndex: number) => Promise<Refusal | undefined>;
}

/**
 * Follow the session's shells while the pane shows it, opening one when the first read has none.
 * `thisDeviceId` tells another device's hold from this device's; until it is known a close is sent
 * unasked and a refusal for another device's hold asks then.
 */
export function useSessionShells(
  bridge: PlatformBridge,
  sessionId: SessionId,
  thisDeviceId: string | undefined,
): SessionShells {
  const { value, publish } = useSubjectScopedState<SessionShellsState>(
    bridge,
    sessionId,
    () => UNREAD_SESSION_SHELLS,
  );

  const openShell = useCallback(() => {
    publish((current) => ({
      ...current,
      openingCount: current.openingCount + 1,
      hasClosedHere: false,
    }));
    void callDaemon(bridge, "terminal.open", {
      sessionId,
      clientIdempotencyKey: crypto.randomUUID(),
    }).then((reply) => {
      publish((current) => {
        const settled = { ...current, openingCount: current.openingCount - 1 };
        if (reply.status === "refused") {
          return { ...settled, refusal: reply.refusal };
        }
        const { terminalId } = reply.value;
        // The list frame and the reply race; whichever comes second makes the tab active.
        return current.terminals?.some((shell) => shell.terminalId === terminalId) === true
          ? { ...settled, ...shownAfterOpen(terminalId), refusal: undefined }
          : { ...settled, awaitedTerminalId: terminalId, refusal: undefined };
      });
    });
  }, [bridge, publish, sessionId]);

  useEffect(() => {
    let isFirstRead = true;
    return followShellList(bridge, sessionId, (frame) => {
      if (frame.kind === "reopenRefusal") {
        publish((current) => ({ ...current, refusal: frame.refusal }));
        return;
      }
      publish((current) => ({
        ...current,
        ...activeShellAfter(current, frame.terminals),
        terminals: frame.terminals,
        heldTerminalIdsAsked: current.heldTerminalIdsAsked.filter((asked) =>
          frame.terminals.some((shell) => shell.terminalId === asked),
        ),
      }));
      if (isFirstRead && frame.terminals.length === 0) {
        openShell();
      }
      isFirstRead = false;
    });
  }, [bridge, openShell, publish, sessionId]);

  const selectShell = useCallback(
    (terminalId: TerminalId) => {
      publish((current) => ({
        ...current,
        activeTerminalId: terminalId,
        openedTerminalId: undefined,
      }));
    },
    [publish],
  );

  const sendClose = useCallback(
    (terminalId: TerminalId, isForced: boolean) => {
      void callDaemon(bridge, "terminal.close", {
        sessionId,
        terminalId,
        ...(isForced ? { force: true } : {}),
      }).then((reply) => {
        publish((current) => {
          if (reply.status === "served") {
            return { ...current, refusal: undefined };
          }
          // Another device took the shell after the list was read: ask, as for a listed hold.
          return reply.refusal.code === HELD_BY_OTHER_DEVICE && !isForced
            ? { ...current, heldTerminalIdsAsked: [...current.heldTerminalIdsAsked, terminalId] }
            : { ...current, refusal: reply.refusal };
        });
      });
    },
    [bridge, publish, sessionId],
  );
  const terminals = value.terminals;
  const closeShells = useCallback(
    (terminalIds: readonly TerminalId[]) => {
      const held = terminalIds.filter((terminalId) =>
        isHeldByAnotherDevice(
          terminals?.find((shell) => shell.terminalId === terminalId),
          thisDeviceId,
        ),
      );
      publish((current) => ({
        ...current,
        hasClosedHere: true,
        heldTerminalIdsAsked: held,
      }));
      for (const terminalId of terminalIds) {
        if (!held.includes(terminalId)) {
          sendClose(terminalId, false);
        }
      }
    },
    [publish, sendClose, terminals, thisDeviceId],
  );
  const heldTerminalIdsAsked = value.heldTerminalIdsAsked;
  const answerCloseQuestion = useCallback(
    (isConfirmed: boolean) => {
      publish((current) => ({ ...current, heldTerminalIdsAsked: [] }));
      if (isConfirmed) {
        for (const terminalId of heldTerminalIdsAsked) {
          sendClose(terminalId, true);
        }
      }
    },
    [heldTerminalIdsAsked, publish, sendClose],
  );

  const reorderShell = useCallback(
    async (terminalId: TerminalId, toIndex: number): Promise<Refusal | undefined> => {
      const others = (terminals ?? [])
        .map((shell) => shell.terminalId)
        .filter((listed) => listed !== terminalId);
      // The moved shell is always in the order, so it is never empty.
      const terminalIds = [...others.slice(0, toIndex), terminalId, ...others.slice(toIndex)] as [
        TerminalId,
        ...TerminalId[],
      ];
      const reply = await callDaemon(bridge, "terminal.reorder", { sessionId, terminalIds });
      return reply.status === "refused" ? reply.refusal : undefined;
    },
    [bridge, sessionId, terminals],
  );

  return {
    terminals,
    activeTerminalId: value.activeTerminalId,
    openedTerminalId: value.openedTerminalId,
    isOpening: value.openingCount > 0 || value.awaitedTerminalId !== undefined,
    hasClosedHere: value.hasClosedHere,
    heldShellsAsked: (terminals ?? []).filter((shell) =>
      heldTerminalIdsAsked.includes(shell.terminalId),
    ),
    refusal: value.refusal,
    selectShell,
    openShell,
    closeShells,
    answerCloseQuestion,
    reorderShell,
  };
}

/** The refusal the daemon gives an unforced close of a shell another device holds. */
const HELD_BY_OTHER_DEVICE: RefusalCode = "terminal.control.heldByOther";

/** What the hook holds: the list, the tabs it shows and asks about, its opens, and the refusal. */
interface SessionShellsState {
  readonly terminals: readonly TerminalListEntry[] | undefined;
  readonly activeTerminalId: TerminalId | undefined;
  /** A shell this pane opened that the list does not carry yet. */
  readonly awaitedTerminalId: TerminalId | undefined;
  readonly openedTerminalId: TerminalId | undefined;
  readonly openingCount: number;
  readonly hasClosedHere: boolean;
  readonly heldTerminalIdsAsked: readonly TerminalId[];
  readonly refusal: Refusal | undefined;
}

const UNREAD_SESSION_SHELLS: SessionShellsState = {
  terminals: undefined,
  activeTerminalId: undefined,
  awaitedTerminalId: undefined,
  openedTerminalId: undefined,
  openingCount: 0,
  hasClosedHere: false,
  heldTerminalIdsAsked: [],
  refusal: undefined,
};

// A run's hold refuses the close outright, so only a device's hold that is not this one is asked.
function isHeldByAnotherDevice(
  shell: TerminalListEntry | undefined,
  thisDeviceId: string | undefined,
): boolean {
  const holder = shell?.holder ?? null;
  return (
    holder !== null &&
    holder.holderRunId === undefined &&
    thisDeviceId !== undefined &&
    holder.holderDeviceId !== thisDeviceId
  );
}

function shownAfterOpen(
  terminalId: TerminalId,
): Pick<SessionShellsState, "activeTerminalId" | "awaitedTerminalId" | "openedTerminalId"> {
  return {
    activeTerminalId: terminalId,
    awaitedTerminalId: undefined,
    openedTerminalId: terminalId,
  };
}

// A closed active tab hands over to the tab that took its place, else the one before it.
function activeShellAfter(
  current: SessionShellsState,
  terminals: readonly TerminalListEntry[],
): Pick<SessionShellsState, "activeTerminalId" | "awaitedTerminalId" | "openedTerminalId"> {
  const isListed = (terminalId: TerminalId | undefined): boolean =>
    terminals.some((shell) => shell.terminalId === terminalId);
  const { activeTerminalId, awaitedTerminalId, openedTerminalId } = current;
  if (awaitedTerminalId !== undefined && isListed(awaitedTerminalId)) {
    return shownAfterOpen(awaitedTerminalId);
  }
  if (isListed(activeTerminalId)) {
    return { activeTerminalId, awaitedTerminalId, openedTerminalId };
  }
  const closedIndex =
    current.terminals?.findIndex((shell) => shell.terminalId === activeTerminalId) ?? -1;
  const neighbor = terminals[Math.min(Math.max(closedIndex, 0), terminals.length - 1)];
  return { activeTerminalId: neighbor?.terminalId, awaitedTerminalId, openedTerminalId: undefined };
}
