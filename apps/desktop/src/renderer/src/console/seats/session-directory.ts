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

import { useEffect, useState } from "react";

import type { GrowthPort, GrowthSessionSummary, GrowthUnavailable } from "../bridge/index.js";

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
  const [state, setState] = useState<SessionDirectoryState>({ status: "reading" });
  useEffect(() => {
    // Reset on a port change rather than leaving the previous bridge's answer on
    // screen while the new one is read: a stale list under a fresh source reads as
    // a current one, and nothing about it says otherwise.
    setState({ status: "reading" });
    let isMounted = true;
    void growth.sessionList({}).then((outcome) => {
      if (!isMounted) {
        // The unmount already happened. Dropping the answer is the whole point:
        // `setState` on an unmounted caller is the leak this tier's endurance run
        // exists to catch, and a directory read outliving its surface by one
        // navigation is the ordinary case rather than the rare one.
        return;
      }
      setState(
        outcome.status === "served"
          ? { status: "served", sessions: outcome.value }
          : { status: "unavailable", refusal: outcome },
      );
    });
    return () => {
      isMounted = false;
    };
  }, [growth]);
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
