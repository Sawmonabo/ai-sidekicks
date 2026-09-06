// The sessions on this node, as a surface can honestly know them.
//
// Two surfaces ask the same question — the sessions destination lists them, the
// auxiliary context picker offers them — and until this hook neither could ask it
// at all. The only session set the renderer could name was the set this window
// happens to have open, which is a different question with a different answer: a
// node with six sessions and a window that has opened none of them is not an empty
// node.
//
// WHY IT LIVES IN `seats/`, AND NEITHER IN `store/` NOR IN `frame/`
//
// It reads the growth port, and `store/` sits BELOW `bridge/` in the console's
// family DAG precisely so a store cannot reach a wire. `useOpenSessionIds` stays
// where it is and stays the seam for what this WINDOW holds; this is its
// neighbour, not its replacement, and the two surfaces compose them.
//
// That argument puts a floor under it and not a ceiling, and it was authored in
// `frame/` because the frame was its only reader. `seats/` is the LOWEST family
// above `bridge/`, so it is the floor exactly, and the difference matters now that a
// view family lists the node's sessions too: a view family can reach neither
// `frame/session-directory.js`, which is a cross-family deep import, nor
// `frame/index.js`, whose `ConsoleRoot` composes every view family through
// `families.ts` and closes a cycle on the way back.
//
// ONE READ PER MOUNT, AND NO POLLING
//
// The read is issued from a mount effect and never repeated on a timer. A
// directory that refreshed itself would be a second source of session truth
// running against the event stream the console already subscribes to, and the
// cheapest way to have two answers to one question is to keep asking it. A
// navigation back to the surface remounts and re-reads, which is the moment a
// person actually expects a fresh list.
//
// THE THREE STATES ARE THE THREE FACTS, AND NO OTHERS
//
// `reading` is a read in flight — the `not-loaded` kind of nothing. `served` is an
// answer, and an answer with no rows is genuinely `empty`. `unavailable` carries
// the port's refusal, which a surface renders as `not-checked`: the console did not
// ask, because no wire answers. Collapsing any two of them is exactly the
// conflation `Spec-023 §Console Design (Meridian)`'s five kinds of nothing exist to
// prevent.
//
// THE STATE IS SUBJECT-SCOPED, AND THE SUBJECT IS THE PORT
//
// A port is minted once per bridge, so a new one is a new source of session truth —
// the fixture's scenario switch, a reconnect, a second window's own instance — and
// the answer read through the previous one stops being an answer at that instant. A
// hook that cleared its own state from the effect would clear it one commit late:
// the render that installs the new port commits with the previous bridge's list
// still held, and both surfaces paint that list under the new source for exactly one
// frame. A stale list under a fresh source reads as a current one, and nothing about
// it says otherwise.
//
// So the state is held by the console's one subject-scoped holder, addressed DURING
// the render that first sees a new port, and the seed it re-addresses to is
// `reading` — which is the truth about a new source nobody has asked yet. The key
// within the subject is `undefined` because there is none: the port IS the whole
// subject, and one port carries one directory.
//
// The holder also replaces the mounted latch this hook used to carry, and it is a
// stricter guard than the latch was. `settle()` hands back a publisher bound to the
// visit ON SCREEN when it is called, so an answer dispatched through a port that has
// since been replaced is REFUSED — which is the case the latch could not see at all,
// because it read an unmount and a re-address is not one. After an unmount the write
// lands in a holder React has already unsubscribed from, so nothing reaches a retired
// tree; either way the late answer is off the screen rather than on it, and neither
// arm has to remember to read a boolean first.
//
// AND THE READ HAS TWO CHANNELS, NOT ONE
//
// Every growth-port operation is typed to RESOLVE to an outcome, and every port in
// this build does. A promise carries a rejection channel regardless, and reading only
// the fulfilment arm is not a bet that the port keeps its word — it is a state
// machine with no transition out of `reading`, so a port that rejects for any reason
// at all leaves the surface saying "still reading" for the life of the mount, with
// nothing on screen that could ever say otherwise. The arm is therefore the guard and
// not an expectation: it settles `unavailable`, carrying a refusal the PORT mints, so
// this hook does not become a second author of growth refusals.

import { useEffect } from "react";

import {
  growthUnavailableFromRejection,
  type GrowthPort,
  type GrowthSessionSummary,
  type GrowthUnavailable,
} from "../bridge/index.js";
import { useSubjectScopedState } from "../store/index.js";

/** What a surface knows about the node's sessions at one moment. */
export type SessionDirectoryState =
  | { readonly status: "reading" }
  | { readonly status: "served"; readonly sessions: readonly GrowthSessionSummary[] }
  | { readonly status: "unavailable"; readonly refusal: GrowthUnavailable };

/**
 * Read the node's session directory once, for as long as the caller is mounted.
 *
 * The effect is keyed on the port, which is minted once per bridge and therefore
 * stable for the life of a window — so a re-render never re-reads, and a bridge
 * swapped underneath (the fixture's scenario switch) does.
 */
export function useSessionDirectory(growth: GrowthPort): SessionDirectoryState {
  // Addressed during the render, so the pass that first sees a new port already
  // reads `reading` and no committed frame carries the previous bridge's list under
  // it. The key is `undefined` because the port is the whole subject.
  const { value: state, settle } = useSubjectScopedState<SessionDirectoryState>(
    growth,
    undefined,
    () => ({ status: "reading" }),
  );
  useEffect(() => {
    // Captured after the commit, so it names the visit on screen — this port's. A
    // later port is a later visit, and this publisher refuses every write into it.
    const publish = settle();
    void growth.sessionList({}).then(
      (outcome) => {
        publish(
          outcome.status === "served"
            ? { status: "served", sessions: outcome.value }
            : { status: "unavailable", refusal: outcome },
        );
      },
      // The rejection handler rides `then` rather than a `.catch` tail, and the
      // difference is which failures it answers for: a tail would also catch a throw
      // from the fulfilment arm above — a publish fault, a bad render queued by it —
      // and report it as the port refusing, which is a false author on a failure
      // that was this hook's. This arm sees the port's rejection and nothing else.
      (rejection: unknown) => {
        // Never read, never stringified here: the value is unestablished, and the one
        // total reading of one lives behind the port's own builder.
        publish({
          status: "unavailable",
          refusal: growthUnavailableFromRejection("sessionList", rejection),
        });
      },
    );
  }, [growth, settle]);
  return state;
}

/**
 * The session ids a surface should offer, directory first and this window's own
 * open sessions after.
 *
 * A union rather than a replacement, because the two sets answer to different
 * authorities and either can hold what the other does not. The directory is the
 * node's answer and may not yet name a session this window created a moment ago;
 * the open set is this window's and names nothing it has not opened. Dropping
 * either would make a session disappear from a list it is genuinely on.
 *
 * Order is directory-first so the list a person reads is the node's, with anything
 * only this window knows about appended rather than interleaved — an ordering
 * that stays stable as the directory grows.
 */
export function offeredSessionIds(
  directory: SessionDirectoryState,
  openSessionIds: readonly string[],
): readonly string[] {
  if (directory.status !== "served") {
    return openSessionIds;
  }
  const offered = directory.sessions.map((session) => session.sessionId);
  const alreadyOffered = new Set(offered);
  return [...offered, ...openSessionIds.filter((sessionId) => !alreadyOffered.has(sessionId))];
}
