// What both cast-bar suites build: a store standing in for a session, the two beats
// that name a person and an agent, and the mount that hands back the bar element.
//
// One module rather than a copy in each, because the two suites assert against the
// SAME bar — one about the names it renders, the other about the absences it must not
// dress up — and two spellings of "a session with these members in it" would let one
// file pass against a bar the other never builds.

import { render } from "@testing-library/react";

import { SessionStore } from "../store/index.js";

export const SESSION_ID = "session-cast";

// UUID v7 values, spelled the way the wire spells them and minted at one instant —
// which is the whole of the naming problem: the two below share a fifteen-character
// prefix, and the chip's own ellipsis truncates both to the same visible string.
export const PARTICIPANT_PRIYA = "019b79ee-0280-79a4-8120-cca0117a0120";
export const AGENT_ARCHITECT = "019b79ee-0280-7a6e-8110-d1a4c1150001";

export interface TimelineRow {
  readonly sequence: number;
  readonly kind: string;
  readonly actorId: string;
  /** The event's own payload — where every label and every correlation id lives. */
  readonly payload?: Readonly<Record<string, unknown>>;
}

export function storeWith(
  participantIds: readonly string[],
  timeline: readonly TimelineRow[] = [],
): SessionStore {
  const store = new SessionStore({ sessionId: SESSION_ID });
  store.initialise({
    cursor: timeline.length,
    entities: [],
    participantJoinLog: participantIds,
    timeline: timeline.map((row) => ({
      id: `event-${String(row.sequence)}`,
      sessionId: SESSION_ID,
      sequence: row.sequence,
      kind: row.kind,
      occurredAt: "2026-01-01T14:20:00.000Z",
      actorId: row.actorId,
      ...(row.payload === undefined ? {} : { payload: row.payload }),
    })),
  });
  return store;
}

/** The membership beat that names a person, in the shape the wire registers. */
export function admittedMember(
  sequence: number,
  participantId: string,
  handle: string,
): TimelineRow {
  return {
    sequence,
    kind: "membership.created",
    actorId: participantId,
    payload: {
      membershipId: `membership-${String(sequence)}`,
      participantId,
      role: "collaborator",
      identityHandle: handle,
    },
  };
}

/**
 * The attach beat that names an agent.
 *
 * Its actor is the person who attached the agent and never the agent — which is why
 * the name has to be read off the payload's `agentId` rather than off the envelope.
 */
export function attachedAgent(sequence: number, agentId: string, name: string): TimelineRow {
  return {
    sequence,
    kind: "agent.attached",
    actorId: "participant-you",
    payload: { sessionId: SESSION_ID, agentId, name, state: "ready", actor: "participant-you" },
  };
}

export function renderBar(element: React.JSX.Element): HTMLElement {
  const { container } = render(element);
  const bar = container.querySelector(".meridian-cast-bar");
  if (!(bar instanceof HTMLElement)) {
    throw new Error("CastBar rendered no bar element");
  }
  return bar;
}
