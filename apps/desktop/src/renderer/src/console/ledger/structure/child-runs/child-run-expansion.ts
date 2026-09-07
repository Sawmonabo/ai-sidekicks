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

import { type RunId, type TimelineRow } from "@ai-sidekicks/contracts";

import { useConsoleBridge, callDaemon, type ConsoleBridge } from "../../../bridge/index.js";
import { type ConsoleRefusal } from "../../../core/index.js";
import { useSessionScopedState } from "../../../seats/index.js";

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
 * Every child run's expansion in one session.
 *
 * A class with private fields per `apps/desktop/AGENTS.md`: this is state with acts
 * that change it, and the acts have to be able to refuse without the caller having
 * to remember the fallback rule.
 */
export class ChildRunExpansionState {
  readonly #byChildRunId = new Map<RunId, ChildRunExpansion>();
  readonly #inFlightChildRunIds = new Set<RunId>();

  /** One child run's expansion. Summarized until something asks otherwise. */
  public expansionFor(childRunId: RunId): ChildRunExpansion {
    return this.#byChildRunId.get(childRunId) ?? CHILD_RUN_SUMMARIZED;
  }

  /** Every child run this session has expanded or tried to. */
  public get trackedChildRunIds(): ReadonlySet<RunId> {
    return new Set(this.#byChildRunId.keys());
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
   */
  public async expand(bridge: ConsoleBridge, childRunId: RunId): Promise<ChildRunExpansion> {
    if (this.#inFlightChildRunIds.has(childRunId)) {
      return this.expansionFor(childRunId);
    }
    this.#inFlightChildRunIds.add(childRunId);
    const held = this.expansionFor(childRunId);
    this.#byChildRunId.set(childRunId, { ...held, status: "expanding", refusal: undefined });
    try {
      const reply = await callDaemon(bridge, "timeline.childRunExpand", { runId: childRunId });
      // NO `catch` ARM, and its absence is the door's contract rather than an
      // omission: `callDaemon` answers `served` or `refused` for every outcome a
      // transport can have — a request the daemon would not accept, a rejected call,
      // a reply the registered schema does not admit — so a `catch` here would be a
      // branch nothing can reach, holding a refusal code nothing can render.
      const settled: ChildRunExpansion =
        reply.status === "served"
          ? {
              status: "expanded",
              entries: reply.value.entries,
              hasUnreadEntries: reply.value.hasMore,
              refusal: undefined,
            }
          : { ...held, status: "expand-failed", refusal: reply.refusal };
      this.#byChildRunId.set(childRunId, settled);
      return settled;
    } finally {
      this.#inFlightChildRunIds.delete(childRunId);
    }
  }

  /** Fold an expanded child run back to its summary, keeping nothing it read. */
  public collapse(childRunId: RunId): void {
    this.#byChildRunId.delete(childRunId);
  }
}

/** What one mounted ledger offers for a child-run summary row. */
export interface ChildRunDisclosure {
  readonly expansionFor: (childRunId: RunId) => ChildRunExpansion;
  /** Expand a summarized child run, or fold an expanded one back. */
  readonly toggle: (childRunId: RunId) => void;
}

/**
 * Hold one session's child-run expansions.
 *
 * The instance AND its published mirror are both session-scoped, for
 * `useChapterDisclosure`'s reason: they are one fact, and re-seeding the instance
 * alone would leave the mirror standing over a session it is not about.
 */
export function useChildRunDisclosure(sessionId: string): ChildRunDisclosure {
  const bridge = useConsoleBridge();
  const held = useSessionScopedState(bridge, sessionId, () => new ChildRunExpansionState());
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
