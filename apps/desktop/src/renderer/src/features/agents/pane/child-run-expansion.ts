// Expanding a child run in place, and what stays on screen when it cannot be. A failed expansion
// leaves the summary row visible and marked incomplete rather than dropping it, so the failure
// arm still carries the summary. One expansion reads the first page only and reports the rest as
// unread: draining the cursor would pull an unbounded child run into a capped window. State is
// per child run (children expand independently) and per session (session stores outlive a
// navigation, so a mount-scoped holder would carry one session's expansions into the next).

import type { ChildRunExpandResponse } from "@ai-sidekicks/contracts/transcript/operations";
import type { RunId } from "@ai-sidekicks/contracts/run/id";
import type { TranscriptReadRow } from "@ai-sidekicks/contracts/transcript/row";

import { callDaemon, type DaemonReply } from "#renderer/services/daemon/reply.js";
import { type PlatformBridge } from "#renderer/services/platform/bridge.js";
import { type Refusal } from "#renderer/lib/refusal/contract.js";
import { ReadScope } from "#renderer/lib/reads/scope.js";

/**
 * Where one child run's expansion has got to. `expand-failed` is a state, not an absence: the
 * summary is still drawn and the row says the expansion is incomplete.
 */
export type ChildRunExpansionStatus = "summarized" | "expanding" | "expanded" | "expand-failed";

/** One child run's expansion, as a view reads it. */
export interface ChildRunExpansion {
  readonly status: ChildRunExpansionStatus;
  /** The entries the expansion returned, in the order the daemon sent them. */
  readonly entries: readonly TranscriptReadRow[];
  /** Whether the daemon has more entries than this expansion read. */
  readonly hasUnreadEntries: boolean;
  /** Why the expansion failed, on the `expand-failed` arm only. */
  readonly refusal: Refusal | undefined;
}

/** The state a child run starts in: summarized, with nothing read and nothing wrong. */
export const CHILD_RUN_SUMMARIZED: ChildRunExpansion = {
  status: "summarized",
  entries: [],
  hasUnreadEntries: false,
  refusal: undefined,
};

/**
 * What one mounted transcript offers for a child-run summary row.
 *
 * @consumedBy opening a child in the agents pane
 */
export interface ChildRunDisclosure {
  readonly expansionFor: (childRunId: RunId) => ChildRunExpansion;
  /** Expand a summarized child run, or fold an expanded one back. */
  readonly toggle: (childRunId: RunId) => void;
}

/**
 * Every child run's expansion in one session. A class because its acts must refuse without the
 * caller remembering the fallback rule.
 *
 * Each child run has its own read line: a shared one would let the second press abort the first
 * child's read and leave that row saying "expanding" for good. The lines end together through
 * {@link abandonReads}, which `useChildRunDisclosure` hands its holder as the disposal.
 */
export class ChildRunExpansionState {
  readonly #byChildRunId = new Map<RunId, ChildRunExpansion>();
  readonly #readLineByChildRunId = new Map<RunId, ReadScope>();
  #isAbandoned = false;

  /** One child run's expansion. Summarized until something asks otherwise. */
  public expansionFor(childRunId: RunId): ChildRunExpansion {
    return this.#byChildRunId.get(childRunId) ?? CHILD_RUN_SUMMARIZED;
  }

  /** Every child run this session has expanded or tried to. */
  public get trackedChildRunIds(): ReadonlySet<RunId> {
    return new Set(this.#byChildRunId.keys());
  }

  /** Whether every read line here is over. True once and never false again. */
  public get isAbandoned(): boolean {
    return this.#isAbandoned;
  }

  /**
   * End every read line: outstanding expansions stop and no later one is live. Expansions are
   * left as they stand; the holder sees `isAbandoned` and mints a fresh object.
   */
  public abandonReads(): void {
    this.#isAbandoned = true;
    for (const readLine of this.#readLineByChildRunId.values()) {
      readLine.abandon();
    }
  }

  /**
   * Ask the daemon for one child run's entries.
   *
   * Single-flight per child run: a second press while one is in flight returns the state
   * already on screen, since two expansions of one child would race to write its state.
   * A failure never clears `entries`, so a failed re-expansion keeps earlier rows and marks
   * them incomplete. An abandoned expansion restores the state its press replaced, so a row
   * is never frozen at `expanding`.
   */
  public async expand(bridge: PlatformBridge, childRunId: RunId): Promise<ChildRunExpansion> {
    const held = this.expansionFor(childRunId);
    // The in-flight fact is the `expanding` state itself; a separate set of ids would be a
    // second source of truth.
    if (held.status === "expanding") {
      return held;
    }
    this.#byChildRunId.set(childRunId, { ...held, status: "expanding", refusal: undefined });
    // Opened after the guard: opening a round supersedes, and a dropped press must not abort
    // the expansion already in flight.
    const round = this.#readLineFor(childRunId).openRound();
    const reply = await readChildRunEntries(bridge, childRunId, round.signal);
    // No `catch`: `callDaemon` answers `served` or `refused` for every transport outcome.
    if (!round.isCurrent) {
      this.#restore(childRunId, held);
      return held;
    }
    const settled = this.#settlementOf(held, reply);
    this.#byChildRunId.set(childRunId, settled);
    return settled;
  }

  /** Fold an expanded child run back to its summary, keeping nothing it read. */
  public collapse(childRunId: RunId): void {
    this.#byChildRunId.delete(childRunId);
  }

  /** Put back exactly the state a press replaced; a never-expanded row goes back to untracked. */
  #restore(childRunId: RunId, held: ChildRunExpansion): void {
    if (held.status === "summarized") {
      this.#byChildRunId.delete(childRunId);
      return;
    }
    this.#byChildRunId.set(childRunId, held);
  }

  /** What the daemon's answer leaves on screen, over the state the press replaced. */
  #settlementOf(
    held: ChildRunExpansion,
    reply: DaemonReply<ChildRunExpandResponse>,
  ): ChildRunExpansion {
    if (reply.status === "refused") {
      return { ...held, status: "expand-failed", refusal: reply.refusal };
    }
    return {
      status: "expanded",
      entries: reply.value.entries,
      hasUnreadEntries: reply.value.hasMore,
      refusal: undefined,
    };
  }

  /** This child run's read line, minted on first press; one minted after abandon is born over. */
  #readLineFor(childRunId: RunId): ReadScope {
    const held = this.#readLineByChildRunId.get(childRunId);
    if (held !== undefined) {
      return held;
    }
    const readLine = new ReadScope();
    if (this.#isAbandoned) {
      readLine.abandon();
    }
    this.#readLineByChildRunId.set(childRunId, readLine);
    return readLine;
  }
}

/**
 * Read one child run's entries with the signal that stops the read. The signal is required, so
 * no call reaches `callDaemon` without naming what abandons it.
 */
async function readChildRunEntries(
  bridge: PlatformBridge,
  childRunId: RunId,
  signal: AbortSignal,
): Promise<DaemonReply<ChildRunExpandResponse>> {
  return callDaemon(bridge, "transcript.childRunExpand", { runId: childRunId }, { signal });
}
