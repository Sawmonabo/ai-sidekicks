// The sessions on this node, as a surface can honestly know them.
//
// Every surface that has to OFFER sessions asks the same question — the sessions
// destination lists them, the auxiliary context picker asks which one a window should
// follow, the workflows destination asks which one its definitions resolve from — and
// until this hook none of them could ask it at all. The only session set the renderer
// could name was the set this window happens to have open, which is a different
// question with a different answer: a node with six sessions and a window that has
// opened none of them is not an empty node. The callers are deliberately not counted
// here: a count is a claim that goes stale the first time a surface is added without
// it.
//
// WHY IT LIVES IN `bridge/`
//
// It reads the growth port, so `bridge/` is the lowest family on the console's DAG
// that owns its inputs — `store/` sits BELOW `bridge/` precisely so a store cannot
// reach a wire, and `frame/`, where this hook was written, sits above every surface
// that asks the question. It lived there while the frame held its only two callers,
// and a third caller in a view family could then reach it only by deep-importing
// past a door it cannot import at all: the frame's door composes the view families,
// so a view family importing it closes a cycle. Hoisting the hook to the family that
// owns the port is what makes the question askable through one door.
//
// `useOpenSessionIds` stays where it is and stays the seam for what this WINDOW
// holds; this is its neighbour, not its replacement, and each surface composes them
// through `offeredSessionIds` below.
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
// the refusal, which a surface renders as `not-checked`: the console did not ask,
// because no wire answers. Collapsing any two of them is exactly the conflation
// `Spec-023 §Console Design (Meridian)`'s five kinds of nothing exist to prevent.
//
// THE STATE IS HELD AGAINST THE PORT IT IS ABOUT, so a bridge swapped underneath is
// settled during the render that brings it rather than in an effect after the commit.
// This hook held its answer in a `useState` and cleared it from a mount effect, which
// narrows that window rather than closing it: the first COMMITTED render under the new
// port still carried the old one's session list, and a click landing in that frame
// chose a session the new bridge has never heard of. `store/subject-scoped-holder.ts`
// is the console's one answer to that, and the three workflow reads on this same seam
// were bound onto it; this one — which the scope picker's choice list depends on — was
// not. The port is the whole subject: the directory read is addressed by nothing else.
//
// THE READ IS SETTLED RATHER THAN MERELY AWAITED. Two different failures reach this
// hook and both are refusals a person should read: the port's own `wire-unregistered`
// outcome, and a DAEMON refusal, which the scripted-reply seam throws verbatim rather
// than folding into the outcome union — deliberately, so a fixture never paraphrases a
// daemon's `{code, message}` into a growth vocabulary. A fulfilment handler alone left
// the second one unhandled and the picker in `reading` for the life of the window,
// offering nothing and promising an answer that had already arrived.
// `read-settlement.ts` next door turns every ending into one value.

import { useEffect } from "react";

import { useSubjectScopedState } from "../store/index.js";
import type { GrowthPort } from "./growth-port.js";
import type { GrowthSessionSummary } from "./growth-values/sessions.js";
import { settleGrowthRead, type SettledReadRefusal } from "./read-settlement.js";

/** What a surface knows about the node's sessions at one moment. */
export type SessionDirectoryState =
  | { readonly status: "reading" }
  | { readonly status: "served"; readonly sessions: readonly GrowthSessionSummary[] }
  | { readonly status: "unavailable"; readonly refusal: SettledReadRefusal };

/**
 * Read the node's session directory once, for as long as the caller is mounted.
 *
 * Keyed on the port and nothing else, which is the whole of what this read is
 * addressed by: the port is minted once per bridge and is stable for the life of a
 * window, so a re-render never re-reads, while a bridge swapped underneath — the
 * fixture's scenario switch — re-seeds during the render that brings it and reads
 * again.
 */
export function useSessionDirectory(growth: GrowthPort): SessionDirectoryState {
  const { value: state, publish } = useSubjectScopedState<SessionDirectoryState>(
    growth,
    undefined,
    () => ({ status: "reading" }),
  );
  useEffect(() => {
    // No reset here, and no mount flag beside the settlement. The holder above put
    // this read back at `reading` during the render that changed the port, and
    // `publish` carries the addressing it was captured under — so an answer arriving
    // after the port moved, or after the surface went away, writes nowhere. Both were
    // stated by hand before, one commit too late and with nothing holding them to the
    // holder's own reading of when a value stops belonging to its subject.
    void settleGrowthRead(growth.sessionList({})).then((outcome) => {
      publish(
        outcome.status === "served"
          ? { status: "served", sessions: outcome.value }
          : { status: "unavailable", refusal: outcome },
      );
    });
    // `publish` re-identifies exactly when the holder is re-addressed, so it is both the
    // guard on this read's answer and the whole of what tells this effect to run again.
  }, [growth, publish]);
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
