// How every suite over `CreateChannelDraft` drives one, in one place.
//
// A ROLE AND NOT A SECOND HARNESS. `create-channel.test-support.tsx` renders the form
// and hands back its controls; this drives the CLASS and reads the request it composes,
// which is what the three draft suites beside it do and what no rendered case can see.
// It exists because there are three of them: the wire suite, the turn-policy suite it
// was split from on this package's size gate, and the reset suite — and `namedDraft`
// was already written out twice before the third arrived.
//
// THE CONTEXT IS BUILT HERE FOR THE SAME REASON THE DRAFT DOES NOT HOLD IT. The three
// reads a readiness answer depends on are the caller's, so a case that departs from the
// ordinary session passes its own and the departure is visible in the case rather than
// buried in a default nobody reads.

import type { ChannelCreateRequest } from "./channel-writes.js";
import { CreateChannelDraft, type CreateChannelContext } from "./create-channel-draft.js";
import { PARTICIPANT_OTHER, PARTICIPANT_YOU, SESSION_ID } from "./channels.test-support.js";

/** Everybody this session holds, unless a case says otherwise. */
export const BOTH_PARTICIPANTS: readonly string[] = [PARTICIPANT_YOU, PARTICIPANT_OTHER];

/**
 * The three reads a readiness answer depends on, named rather than positional.
 *
 * The live set defaults to the whole session because most cases are about a general
 * channel, where it decides nothing — and the cases it DOES decide say so by passing
 * their own.
 */
export function contextWith(
  viewerParticipantId: string | undefined,
  liveParticipantIds: readonly string[] = BOTH_PARTICIPANTS,
): CreateChannelContext {
  return { sessionId: SESSION_ID, viewerParticipantId, liveParticipantIds };
}

/** The request this draft composes, or a failure naming what it is still missing. */
export function requestOf(
  draft: CreateChannelDraft,
  viewerParticipantId?: string,
): ChannelCreateRequest {
  const readiness = draft.readiness(contextWith(viewerParticipantId ?? PARTICIPANT_YOU));
  if (readiness.status !== "ready") {
    throw new Error(`the draft is still missing: ${readiness.missing.join(", ")}`);
  }
  return readiness.request;
}

/** What the draft says it is still waiting on. */
export function missingFrom(
  draft: CreateChannelDraft,
  viewerParticipantId?: string,
  liveParticipantIds?: readonly string[],
): readonly string[] {
  const readiness = draft.readiness(contextWith(viewerParticipantId, liveParticipantIds));
  return readiness.status === "incomplete" ? readiness.missing : [];
}

/** A named general draft, which is the shortest thing that composes a request. */
export function namedDraft(name = "review"): CreateChannelDraft {
  const draft = new CreateChannelDraft();
  draft.setName(name);
  return draft;
}
