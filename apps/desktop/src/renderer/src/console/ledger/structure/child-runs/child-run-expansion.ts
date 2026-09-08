// Expanding a child run in place — and what stays on screen when it cannot be.
//
// `Spec-013 §Default Behavior` summarizes child-run activity and expands it only when
// somebody asks; `Spec-013 §Fallback Behavior` fixes what a failed ask leaves behind:
// "the summary row visible and marked incomplete rather than disappearing". Both
// halves are here, and the second is the one that decides the shape — a state machine
// whose failure arm still carries the summary is a machine that cannot drop a row, and
// a boolean `isExpanded` beside a separate error would have let a caller render
// neither.
//
// THE CALL IS A REGISTERED WIRE, so it goes through the console's daemon call door
// and not through the growth port: `timeline.childRunExpand` is published in
// `@ai-sidekicks/contracts` in both directions, and the port's own rule is that it
// refuses what the corpus has NOT registered. The door parses the reply against the
// registered schema, so what reaches this module is either rows or a refusal — never
// an `unknown` that reads as success.
//
// WHAT IT DOES NOT DO. It pages nothing. `ChildRunExpandResponse` carries `hasMore`
// and a cursor, and one expansion here reads the first page and reports the rest as
// unread rather than looping: a renderer that drained a cursor would decide, on the
// reader's behalf, to pull an unbounded child run into a window with a cap on it.
// The unread remainder is carried on the outcome so the row can say so.
//
// STATE IS PER CHILD RUN AND PER SESSION. Per child run because two children expand
// independently; per session because the console holds session stores open across a
// navigation, so a mount-scoped holder would carry one session's expansions into the
// next one — the defect `useChapterDisclosure` records in its own header.

import { useCallback, useMemo } from "react";

import { type ChildRunExpandResponse, type RunId, type TimelineRow } from "@ai-sidekicks/contracts";

import {
  useConsoleBridge,
  callDaemon,
  type ConsoleBridge,
  type DaemonReply,
} from "../../../bridge/index.js";
import { type ConsoleRefusal } from "../../../core/index.js";
import { useSessionScopedState } from "../../../seats/index.js";
import {
  ReadScope,
  useSubjectScopedResource,
  type SubjectScopedDisposal,
} from "../../../store/index.js";

/**
 * Where one child run's expansion has got to.
 *
 * `expand-failed` is a first-class state rather than an absence, because it is the
 * one the fallback rule is about: the summary is still drawn and the row says the
 * expansion is incomplete.
 */
export type ChildRunExpansionStatus = "summarized" | "expanding" | "expanded" | "expand-failed";

/** One child run's expansion, as a surface reads it. */
export interface ChildRunExpansion {
  readonly status: ChildRunExpansionStatus;
  /** The entries the expansion returned, in the order the daemon sent them. */
  readonly entries: readonly TimelineRow[];
  /** Whether the daemon has more entries than this expansion read. */
  readonly hasUnreadEntries: boolean;
  /** Why the expansion failed, on the `expand-failed` arm only. */
  readonly refusal: ConsoleRefusal | undefined;
}

/** The state a child run starts in: summarized, with nothing read and nothing wrong. */
export const CHILD_RUN_SUMMARIZED: ChildRunExpansion = {
  status: "summarized",
  entries: [],
  hasUnreadEntries: false,
  refusal: undefined,
};

/**
 * Read one child run's entries, with the signal that stops the read.
 *
 * SEPARATE FROM THE STATE MACHINE ABOVE IT, on `repos/repo-reads.ts`' shape: the call
 * is one line over one registered pair, and what makes it a READ rather than an act is
 * that the signal is REQUIRED — there is no way to reach the door from here without
 * naming the thing that abandons it. Every parse, refusal code and rejection
 * normalization is still the bridge family's; nothing is re-authored here.
 */
async function readChildRunEntries(
  bridge: ConsoleBridge,
  childRunId: RunId,
  signal: AbortSignal,
): Promise<DaemonReply<ChildRunExpandResponse>> {
  return callDaemon(bridge, "timeline.childRunExpand", { runId: childRunId }, { signal });
}

/**
 * Every child run's expansion in one session.
 *
 * A class with private fields per `apps/desktop/AGENTS.md`: this is state with acts
 * that change it, and the acts have to be able to refuse without the caller having
 * to remember the fallback rule.
 *
 * ONE READ LINE PER CHILD RUN AND NOT ONE PER SESSION, which is the same reason the
 * single-flight guard is per child run: two children expand independently, so a shared
 * line would have the second press abort the first child's read and leave that row
 * saying "expanding" for the rest of the session. The lines are held here rather than
 * at the render for the ordinary holder reason — this object outlives any one mount of
 * the rows that press it — and they end together through {@link abandonReads}, which
 * `useChildRunDisclosure` hands its holder as the disposal.
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
   * End every read line: outstanding expansions stop, and no later one is live.
   *
   * The expansions themselves are left as they stand — a holder handing this object
   * back recognises the corpse through `isAbandoned` and mints a fresh one, so nothing
   * here is ever read again.
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
   * SINGLE-FLIGHT PER CHILD RUN. A second press while one is in flight is answered
   * with the state already on screen rather than with a second call: the control is
   * on a row a person can press repeatedly, and two expansions of one child would
   * race to write the same slot.
   *
   * The failure arm never clears `entries`, so a re-expansion that fails leaves the
   * rows an earlier one delivered on screen and marks them incomplete — which is the
   * fallback rule applied to the case the rule does not spell out.
   *
   * AND AN ABANDONED EXPANSION IS PUT BACK RATHER THAN LEFT `expanding`. Nobody is
   * waiting for the answer, so nothing installs — but a row frozen mid-press is a
   * control that can never be pressed again, so the state this press replaced is
   * restored: the expansion did not happen, and the row says exactly that.
   */
  public async expand(bridge: ConsoleBridge, childRunId: RunId): Promise<ChildRunExpansion> {
    const held = this.expansionFor(childRunId);
    // THE IN-FLIGHT FACT IS THE STATE ITSELF, not a second register beside it: this
    // act raises `expanding` synchronously and every terminal arm below leaves it,
    // so a set of in-flight ids would have been a second source of truth for one
    // reading — and the two could disagree only by being wrong.
    if (held.status === "expanding") {
      return held;
    }
    this.#byChildRunId.set(childRunId, { ...held, status: "expanding", refusal: undefined });
    // OPENED AFTER THE GUARD, because opening a round IS the supersession: a round
    // opened for a press this act drops would abort the expansion already in flight.
    const round = this.#readLineFor(childRunId).openRound();
    const reply = await readChildRunEntries(bridge, childRunId, round.signal);
    // NO `catch` ARM, and its absence is the door's contract rather than an
    // omission: `callDaemon` answers `served` or `refused` for every outcome a
    // transport can have — a request the daemon would not accept, a rejected call,
    // a reply the registered schema does not admit — so a `catch` here would be a
    // branch nothing can reach, holding a refusal code nothing can render.
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

  /**
   * Put back exactly the state a press replaced, tracking included.
   *
   * A row that was never expanded goes back to being untracked rather than to a stored
   * `summarized` entry, so an abandoned press leaves no trace at all — which is what
   * "the expansion did not happen" means for {@link trackedChildRunIds} too.
   */
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

  /**
   * This child run's read line, minted on the first press it takes.
   *
   * A line minted after {@link abandonReads} is born over, which is the fail-closed
   * answer for a press that reaches a disclosure nothing is rendering any more.
   */
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

/** What one mounted ledger offers for a child-run summary row. */
export interface ChildRunDisclosure {
  readonly expansionFor: (childRunId: RunId) => ChildRunExpansion;
  /** Expand a summarized child run, or fold an expanded one back. */
  readonly toggle: (childRunId: RunId) => void;
}

/**
 * How a session's expansions end, stated once so the render hands over a stable pair.
 *
 * TERMINAL RATHER THAN RELEASING: the object holds one read line per child run, and a
 * line that was let go of is not a line the next render may open a round on.
 * `isAbandoned` is what makes React's double-mount survivable — the disposed object is
 * recognised and a fresh one minted, rather than every later press being born over.
 */
const CHILD_RUN_EXPANSION_DISPOSAL: SubjectScopedDisposal<ChildRunExpansionState> = {
  dispose: (expansions: ChildRunExpansionState): void => {
    expansions.abandonReads();
  },
  isClosed: (expansions: ChildRunExpansionState): boolean => expansions.isAbandoned,
};

/**
 * Hold one session's child-run expansions.
 *
 * The instance AND its published mirror are both session-scoped, for
 * `useChapterDisclosure`'s reason: they are one fact, and re-seeding the instance
 * alone would leave the mirror standing over a session it is not about.
 *
 * The instance is a RESOURCE and the mirror is a value, which is the one asymmetry
 * here: the mirror is a map a re-address simply replaces, and the instance owns read
 * lines that a re-address has to END — otherwise the session left behind goes on
 * decoding expansions for rows nothing is rendering.
 */
export function useChildRunDisclosure(sessionId: string): ChildRunDisclosure {
  const bridge = useConsoleBridge();
  const held = useSubjectScopedResource(
    bridge,
    sessionId,
    () => new ChildRunExpansionState(),
    CHILD_RUN_EXPANSION_DISPOSAL,
  );
  const mirror = useSessionScopedState<ReadonlyMap<RunId, ChildRunExpansion>>(
    bridge,
    sessionId,
    () => new Map<RunId, ChildRunExpansion>(),
  );
  const expansionState = held.value;
  const publishMirror = mirror.publish;
  const publish = useCallback(() => {
    publishMirror(
      new Map(
        [...expansionState.trackedChildRunIds].map((childRunId) => [
          childRunId,
          expansionState.expansionFor(childRunId),
        ]),
      ),
    );
  }, [expansionState, publishMirror]);
  const toggle = useCallback(
    (childRunId: RunId) => {
      if (expansionState.expansionFor(childRunId).status === "expanded") {
        expansionState.collapse(childRunId);
        publish();
        return;
      }
      publish();
      void expansionState.expand(bridge, childRunId).then(publish, publish);
    },
    [bridge, expansionState, publish],
  );
  const expansions = mirror.value;
  const expansionFor = useCallback(
    (childRunId: RunId) => expansions.get(childRunId) ?? CHILD_RUN_SUMMARIZED,
    [expansions],
  );
  return useMemo(() => ({ expansionFor, toggle }), [expansionFor, toggle]);
}
