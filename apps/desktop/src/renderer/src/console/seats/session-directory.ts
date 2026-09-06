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
// stricter guard than the latch was. The publisher it hands out carries the
// addressing it was captured under, so an answer dispatched through a port that has
// since been replaced writes NOWHERE — which is the case the latch could not see at
// all, because it read an unmount and a re-address is not one. After an unmount the
// write lands in a holder React has already unsubscribed from, so nothing reaches a
// retired tree; either way the late answer is off the screen rather than on it, and
// neither arm has to remember to read a boolean first.
//
// AND THE READ HAS TWO CHANNELS, NOT ONE
//
// Every growth-port operation is typed to RESOLVE to an outcome, and every port in
// this build does. A promise carries a rejection channel regardless, and reading only
// the fulfilment arm is not a bet that the port keeps its word — it is a state
// machine with no transition out of `reading`, so a port that rejects for any reason
// at all leaves the surface saying "still reading" for the life of the mount, with
// nothing on screen that could ever say otherwise.
//
// SETTLED BY `bridge/readings/read-settlement.ts`, WHICH IS WHERE THAT ARM LIVES FOR
// EVERY READ ON THIS SEAM. This hook once attached its own rejection handler and
// built the refusal through the port's `growthUnavailableFromRejection`, which stamps
// the port's own `call-rejected` and composes a sentence around the daemon's. The
// three sibling reads a family up settle through the reading layer, which keeps the
// daemon's dotted code and its message verbatim — so one surface rendered
// `call-rejected` while another, one navigation later, rendered
// `workflow.session_not_found` for the same class of failure. Two vocabularies for
// one seam is exactly what the reading layer was written to end, and a directory read
// is not the exception: what a person acts on is what the daemon said.

import {
  useSettledGrowthRead,
  type GrowthPort,
  type GrowthSessionSummary,
  type SettledReadRefusal,
} from "../bridge/index.js";

/** What a surface knows about the node's sessions at one moment. */
export type SessionDirectoryState =
  | { readonly status: "reading" }
  | { readonly status: "served"; readonly sessions: readonly GrowthSessionSummary[] }
  | { readonly status: "unavailable"; readonly refusal: SettledReadRefusal };

/** What the directory read settles to, either kind. */
type SettledSessionDirectory = Awaited<ReturnType<GrowthPort["sessionList"]>> | SettledReadRefusal;

/**
 * The read this hook puts, which is always askable.
 *
 * `useSettledGrowthRead` lets a caller answer `undefined` where its wire's request
 * cannot be formed; the directory's request carries nothing, so there is always a
 * question and this always answers a promise. Written as a named function rather than
 * inline so the hook call below reads as the four decisions it is making.
 */
function readDirectory(growth: GrowthPort): ReturnType<GrowthPort["sessionList"]> {
  return growth.sessionList({});
}

/** The directory, given its one read's settlement. */
function settledDirectoryState(settlement: SettledSessionDirectory): SessionDirectoryState {
  return settlement.status === "served"
    ? { status: "served", sessions: settlement.value }
    : { status: "unavailable", refusal: settlement };
}

/**
 * Read the node's session directory once, for as long as the caller is mounted.
 *
 * The effect is keyed on the port, which is minted once per bridge and therefore
 * stable for the life of a window — so a re-render never re-reads, and a bridge
 * swapped underneath (the fixture's scenario switch) does. The holder is addressed
 * DURING the render that first sees a new port, so the pass that installs one already
 * reads `reading` and no committed frame carries the previous bridge's list under it;
 * the key is `undefined` because the port is the whole subject.
 */
export function useSessionDirectory(growth: GrowthPort): SessionDirectoryState {
  const { value: state } = useSettledGrowthRead<SettledSessionDirectory, SessionDirectoryState>(
    growth,
    undefined,
    () => readDirectory(growth),
    { unsettled: () => ({ status: "reading" }), settled: settledDirectoryState },
  );
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
