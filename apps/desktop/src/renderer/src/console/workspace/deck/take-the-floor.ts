// The deck's half of "Step in": put the run's execution root on the deck, and address
// the composer at that run.
//
// The pause is the run control's and reaches the daemon directly. These two acts are
// the deck's, because which panes are open and which one is focused are facts about
// the deck and about nothing else. `seats/slots/take-the-floor-seat.ts` carries the request
// across the family boundary; this module is what fills that seat.
//
// TWO RESOLUTIONS, AND NEITHER IS A GUESS.
//
//   • **Which agent's pane addresses this run.** The run's own entity body carries the
//     binding, wire-verbatim, and a run this store has never seen names no agent — in
//     which case the composer stays on the channel path rather than being pointed at a
//     target picked from the newest row.
//   • **Which checkout the run executes in.** `repo.worktreeStatusRead` is the only
//     registered read that names a worktree at all, and its rows carry
//     `createdByRunId`. A retired record is not a checkout a person can be sent to, so
//     it is filtered out; more than one live record naming one run is refused rather
//     than resolved by picking whichever the read listed first.
//
// THE ORDER IS THE POINT. The worktree pane opens FIRST and the agent's pane second,
// so the focused pane at the end of the act is the one the composer resolves its
// address from. Opening them the other way round would leave the composer addressed
// to a worktree inspector — the channel path — which is the one outcome that would
// make "you have the floor" false.
//
// NO READ RUNS UNTIL SOMEBODY PRESSES. This is a press-time resolution, not a
// subscription: the deck holds no worktree projection and wants none, and a read kept
// warm for a control most sessions never press would be a poll with extra steps.

import { useCallback, useEffect } from "react";

import type { SessionId, WorktreeStatusReadResponse } from "@ai-sidekicks/contracts";

import { callDaemon, type ConsoleBridge } from "../../bridge/index.js";
import { readWireString } from "../../core/index.js";
import {
  registerTakeTheFloorHandler,
  unregisterTakeTheFloorHandler,
  type FloorWorktreeDisposition,
  type TakeTheFloorHandler,
  type TakeTheFloorOutcome,
} from "../../seats/index.js";
import {
  isReadAbandoned,
  useReadScope,
  type ReadRound,
  type SessionStore,
} from "../../store/index.js";
import type { DeckLayout } from "./model/deck-layout.js";

/** The owner string the seat's refusal names. Reads as the surface, never as a task. */
export const TAKE_THE_FLOOR_SEAT_OWNER = "workspace-deck";

/** One worktree row of the execution-root read, spelled once. */
type WorktreeStatusRecord = WorktreeStatusReadResponse["worktrees"][number];

/**
 * The state a worktree record has to be OUT of to be a place a person can be sent.
 *
 * One value rather than a set of live states: `retired` is the daemon saying it will
 * not bind this checkout again, and every other state — including `failed`, which
 * arrives on a status re-read rather than as an event — is a record whose detail is
 * worth reading.
 */
const RETIRED_WORKTREE_STATE = "retired";

/**
 * Which live checkout this run created, or why there is not exactly one.
 *
 * Exported because it is the whole decision and it is checkable without a deck, a
 * bridge, or a React tree.
 */
export function resolveRunWorktreeId(
  worktrees: readonly WorktreeStatusRecord[],
  runId: string,
): { readonly disposition: FloorWorktreeDisposition; readonly worktreeId?: string } {
  const named = worktrees.filter(
    (worktree) => worktree.createdByRunId === runId && worktree.state !== RETIRED_WORKTREE_STATE,
  );
  const only = named.length === 1 ? named[0] : undefined;
  if (only === undefined) {
    return { disposition: named.length === 0 ? "unnamed" : "ambiguous" };
  }
  return { disposition: "opened", worktreeId: only.worktreeId };
}

/** The agent this run is bound to, read off the run's own entity body. */
function agentOfRun(sessionStore: SessionStore | undefined, runId: string): string | undefined {
  return readWireString(sessionStore?.snapshot().partitions.run[runId]?.body?.["agentId"]);
}

/** What the handler is composed from. One value, so the hook and the act agree. */
interface FloorDeck {
  readonly layout: DeckLayout;
  readonly bridge: ConsoleBridge;
  readonly sessionStore: SessionStore | undefined;
}

/**
 * Perform the deck's two acts and say which of them landed.
 *
 * THE PREREQUISITE READ IS ON THE ACT'S OWN ROUND, and what that buys is the two panes
 * this act opens. A workspace that unmounted while the execution-root read was on the
 * wire has no deck to move, and a second Step in supersedes the first — in both cases
 * the answer belongs to nobody, so it opens nothing and reports `no-deck` rather than
 * moving a deck on the strength of a read another act has already replaced. That is
 * the seat's own distinction used as it was written: "there was no deck to ask" is
 * exactly the receipt for an act whose deck is gone by the time the answer arrives.
 */
async function handOverTheFloor(
  deck: FloorDeck,
  runId: string,
  round: ReadRound,
): Promise<TakeTheFloorOutcome> {
  const worktree = await readRunWorktree(deck, runId, round.signal);
  if (isReadAbandoned(round.signal)) {
    return { status: "no-deck" };
  }
  if (worktree.worktreeId !== undefined) {
    deck.layout.open({ kind: "inspector", entity: { kind: "worktree", id: worktree.worktreeId } });
  }
  const agentId = agentOfRun(deck.sessionStore, runId);
  if (agentId !== undefined) {
    deck.layout.open({ kind: "agent-console", entity: { kind: "agent", id: agentId } });
  }
  return {
    status: "moved",
    composerAddressed: agentId !== undefined,
    worktree: worktree.disposition,
  };
}

/**
 * Run the execution-root read, and read the refusal as its own disposition.
 *
 * The signal is REQUIRED rather than optional, so there is no way to make this read
 * from outside a round: the act that presses for it has an owner who may leave, and
 * this is the one call on that path that reaches the daemon.
 */
async function readRunWorktree(
  deck: FloorDeck,
  runId: string,
  signal: AbortSignal,
): Promise<{ readonly disposition: FloorWorktreeDisposition; readonly worktreeId?: string }> {
  const sessionId = deck.sessionStore?.sessionId;
  if (sessionId === undefined) {
    // No session, so no session-scoped read to make. The composer half still runs, and
    // it will find no agent either — which is the same honest answer twice.
    return { disposition: "unreadable" };
  }
  // The store holds the identifier as the plain string the wire sent; `SessionId` is a
  // compile-time marker over that same opaque value, and the console never mints one.
  const reply = await callDaemon(
    deck.bridge,
    "repo.worktreeStatusRead",
    { sessionId: sessionId as SessionId },
    { signal },
  );
  if (reply.status === "refused") {
    return { disposition: "unreadable" };
  }
  return resolveRunWorktreeId(reply.value.worktrees, runId);
}

/**
 * Fill the floor seat for as long as this workspace is mounted.
 *
 * Withdrawn on unmount rather than left standing: the handler closes over one deck,
 * one transport and one session's store, and a handler outliving them would move a
 * deck that is no longer on screen.
 *
 * AND THE READ LINE IS WITHDRAWN WITH IT. Withdrawing the handler stops the NEXT act
 * from being asked for and does nothing about the one already on the wire, so the
 * line is addressed at the same `(bridge, sessionId)` pairing the handler is composed
 * from: unmounting it, or re-addressing the workspace at another session, abandons the
 * execution-root read this act was waiting on instead of leaving it to be parsed for a
 * deck that has gone.
 */
export function useTakeTheFloorSeat(deck: FloorDeck): void {
  const { layout, bridge, sessionStore } = deck;
  const readScope = useReadScope(bridge, sessionStore?.sessionId);
  const handle = useCallback<TakeTheFloorHandler>(
    (request) =>
      handOverTheFloor({ layout, bridge, sessionStore }, request.runId, readScope.openRound()),
    [layout, bridge, sessionStore, readScope],
  );
  useEffect(() => {
    registerTakeTheFloorHandler(TAKE_THE_FLOOR_SEAT_OWNER, handle);
    return () => {
      unregisterTakeTheFloorHandler();
    };
  }, [handle]);
}
