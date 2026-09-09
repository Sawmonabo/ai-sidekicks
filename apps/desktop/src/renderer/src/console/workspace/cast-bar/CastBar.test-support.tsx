// What both cast-bar suites build: a store standing in for a session, the two beats
// that name a person and an agent, and the mount that hands back the bar element.
//
// One module rather than a copy in each, because the two suites assert against the
// SAME bar — one about the names it renders, the other about the absences it must not
// dress up — and two spellings of "a session with these members in it" would let one
// file pass against a bar the other never builds.

import { render } from "@testing-library/react";

import { SidekicksBridgeProvider, createFixtureBridge } from "../../bridge/index.js";
import { PARTICIPANT_PRIYA } from "../../bridge/scenario/flagship/flagship-cast.js";
import { SessionStore, type ConsoleEntity } from "../../store/index.js";
import type { ConsoleScenario } from "../../bridge/scenario/runtime/index.js";

export const SESSION_ID = "session-cast";

export interface TimelineRow {
  readonly sequence: number;
  readonly kind: string;
  readonly actorId: string;
  /** The event's own payload — where every label and every correlation id lives. */
  readonly payload?: Readonly<Record<string, unknown>>;
}

/** What a case says about the read that established this store's window. */
export interface StoreWithOptions {
  /**
   * The position the read was performed FROM, where it submitted one.
   *
   * Present, the window opens partway through the log and the rows below it were
   * never delivered here — which is the whole subject of `CastBar.resumed-window.test.tsx`.
   * Absent, the read opened at the beginning of the log, which is what every other
   * case in this family is written under.
   */
  readonly readFromCursor?: string;
  /** Entities the read carried, for a case about what the base state authoritatively holds. */
  readonly entities?: readonly ConsoleEntity[];
  /** Rows the store retains, so a case can drive the cap the way the ledger does. */
  readonly timelineCap?: number;
}

export function storeWith(
  participantIds: readonly string[],
  timeline: readonly TimelineRow[] = [],
  options: StoreWithOptions = {},
): SessionStore {
  const store = new SessionStore({
    sessionId: SESSION_ID,
    ...(options.timelineCap === undefined ? {} : { timelineCap: options.timelineCap }),
  });
  store.initialise({
    cursor: timeline.length,
    entities: options.entities ?? [],
    participantJoinLog: participantIds,
    ...(options.readFromCursor === undefined ? {} : { readFromCursor: options.readFromCursor }),
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

/**
 * A scenario that answers none of the bar's three reads.
 *
 * The bar puts an identity read, a health read and a spend read the moment it mounts,
 * so every case here renders inside a bridge whether it is about those reads or not.
 * This is the one that keeps the other cases about what they are about: it scripts no
 * reply at all, so all three refuse, and a case that says nothing about a reading gets
 * a bar whose readings are all honestly absent rather than one carrying a figure some
 * other suite's scenario happened to declare.
 *
 * `CastBar.readings.test.tsx` is where a scenario that DOES answer them lives.
 */
export const CAST_BAR_SILENT_SCENARIO: ConsoleScenario = {
  id: "cast-bar-silent",
  label: "Cast bar, nothing read",
  purpose: "A session whose identity, health and spend reads all refuse.",
  sessionId: SESSION_ID,
  participantIdsInJoinOrder: [PARTICIPANT_PRIYA],
  startedAtIso: "2026-01-01T14:20:00.000Z",
  beats: [],
  replies: [],
};

export interface RenderBarOptions {
  /** Which scenario the bar's reads are answered from. Silent by default. */
  readonly scenario?: ConsoleScenario;
}

export function renderBar(element: React.JSX.Element, options: RenderBarOptions = {}): HTMLElement {
  const scenario = options.scenario ?? CAST_BAR_SILENT_SCENARIO;
  const { container } = render(
    <SidekicksBridgeProvider bridge={createFixtureBridge({ scenario })}>
      {element}
    </SidekicksBridgeProvider>,
  );
  const bar = container.querySelector(".meridian-cast-bar");
  if (!(bar instanceof HTMLElement)) {
    throw new Error("CastBar rendered no bar element");
  }
  return bar;
}
