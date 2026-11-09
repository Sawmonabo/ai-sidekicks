// A session's shells as the pane reads them, kept current off the shell list for the session on
// screen, with the tab this pane shows. Opening the pane reads the shells the session really has,
// and a fresh shell is opened only when that first read finds none, once per visit, so closing the
// last tab leaves the pane empty rather than opening another.
//
// The active tab is this pane's own: the list's first on the first read; a shell this pane opened
// once the list carries it; the neighbor of a closed active tab; and a shell another device opened
// only when no tab was active.

import { useCallback, useEffect } from "react";

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
  /** Whether a shell this pane asked for is not yet on the list. */
  readonly isOpening: boolean;
  /** Why the list could not be opened again, or a shell could not be opened or closed. */
  readonly refusal: Refusal | undefined;
  readonly selectShell: (terminalId: TerminalId) => void;
  /** Open another shell and show it once the list carries it. */
  readonly openShell: () => void;
  /** Close a shell's tab and end its shell; the tab goes when the list drops it. */
  readonly closeShell: (terminalId: TerminalId) => void;
}

/** Follow the session's shells while the pane shows it, opening one when the first read has none. */
export function useSessionShells(bridge: PlatformBridge, sessionId: SessionId): SessionShells {
  const { value, publish } = useSubjectScopedState<SessionShellsState>(
    bridge,
    sessionId,
    () => UNREAD_SESSION_SHELLS,
  );

  const openShell = useCallback(() => {
    publish((current) => ({ ...current, openingCount: current.openingCount + 1 }));
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
          ? { ...settled, activeTerminalId: terminalId, refusal: undefined }
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
      }));
      if (isFirstRead && frame.terminals.length === 0) {
        openShell();
      }
      isFirstRead = false;
    });
  }, [bridge, openShell, publish, sessionId]);

  const selectShell = useCallback(
    (terminalId: TerminalId) => {
      publish((current) => ({ ...current, activeTerminalId: terminalId }));
    },
    [publish],
  );
  const closeShell = useCallback(
    (terminalId: TerminalId) => {
      void callDaemon(bridge, "terminal.close", { sessionId, terminalId }).then((reply) => {
        publish((current) => ({
          ...current,
          refusal: reply.status === "refused" ? reply.refusal : undefined,
        }));
      });
    },
    [bridge, publish, sessionId],
  );

  return {
    terminals: value.terminals,
    activeTerminalId: value.activeTerminalId,
    isOpening: value.openingCount > 0 || value.awaitedTerminalId !== undefined,
    refusal: value.refusal,
    selectShell,
    openShell,
    closeShell,
  };
}

/** What the hook holds: the list, the active tab, the opens this pane has out, and the refusal. */
interface SessionShellsState {
  readonly terminals: readonly TerminalListEntry[] | undefined;
  readonly activeTerminalId: TerminalId | undefined;
  /** A shell this pane opened that the list does not carry yet. */
  readonly awaitedTerminalId: TerminalId | undefined;
  readonly openingCount: number;
  readonly refusal: Refusal | undefined;
}

const UNREAD_SESSION_SHELLS: SessionShellsState = {
  terminals: undefined,
  activeTerminalId: undefined,
  awaitedTerminalId: undefined,
  openingCount: 0,
  refusal: undefined,
};

// A closed active tab hands over to the tab that took its place, else the one before it.
function activeShellAfter(
  current: SessionShellsState,
  terminals: readonly TerminalListEntry[],
): Pick<SessionShellsState, "activeTerminalId" | "awaitedTerminalId"> {
  const isListed = (terminalId: TerminalId | undefined): boolean =>
    terminals.some((shell) => shell.terminalId === terminalId);
  const { activeTerminalId, awaitedTerminalId } = current;
  if (awaitedTerminalId !== undefined && isListed(awaitedTerminalId)) {
    return { activeTerminalId: awaitedTerminalId, awaitedTerminalId: undefined };
  }
  if (isListed(activeTerminalId)) {
    return { activeTerminalId, awaitedTerminalId };
  }
  const closedIndex =
    current.terminals?.findIndex((shell) => shell.terminalId === activeTerminalId) ?? -1;
  const neighbor = terminals[Math.min(Math.max(closedIndex, 0), terminals.length - 1)];
  return { activeTerminalId: neighbor?.terminalId, awaitedTerminalId };
}
