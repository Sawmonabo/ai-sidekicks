// What the session-header suites build: a store standing in for a session, and the
// mount that hands back the header element.
//
// One module rather than a copy in each, because the suites assert against the SAME
// header — one about the readings it renders, the others about the absences it must not
// dress up — and two spellings of "a session in this state" would let one file pass
// against a header the others never build.

import { render } from "@testing-library/react";

import { SidekicksBridgeProvider, createFixtureBridge } from "../../bridge/index.js";
import { USER_YOU } from "../../bridge/scenario/flagship/flagship-cast.js";
import { SessionStore, type ConsoleEntity } from "../../store/index.js";
import type { ConsoleScenario } from "../../bridge/scenario/runtime/index.js";

export const SESSION_ID = "session-cast";

export interface TimelineRow {
  readonly sequence: number;
  readonly kind: string;
  readonly actorId: string;
  /** The event's own payload — where every correlation id lives. */
  readonly payload?: Readonly<Record<string, unknown>>;
}

/** What a case says about the read that established this store's window. */
export interface StoreWithOptions {
  /**
   * The position the read was performed FROM, where it submitted one.
   *
   * Present, the window opens partway through the log and the rows below it were
   * never delivered here — which is the whole subject of `SessionHeader.resumed-window.test.tsx`.
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
    userJoinLog: [USER_YOU],
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

/**
 * A scenario that answers none of the header's three reads.
 *
 * The header puts an identity read, a health read and a spend read the moment it mounts,
 * so every case here renders inside a bridge whether it is about those reads or not.
 * This is the one that keeps the other cases about what they are about: it scripts no
 * reply at all, so all three refuse, and a case that says nothing about a reading gets
 * a header whose readings are all honestly absent rather than one carrying a figure some
 * other suite's scenario happened to declare.
 *
 * `SessionHeader.readings.test.tsx` is where a scenario that DOES answer them lives.
 */
export const CAST_BAR_SILENT_SCENARIO: ConsoleScenario = {
  id: "session-header-silent",
  label: "Session header, nothing read",
  purpose: "A session whose identity, health and spend reads all refuse.",
  sessionId: SESSION_ID,
  userIdsInJoinOrder: [USER_YOU],
  startedAtIso: "2026-01-01T14:20:00.000Z",
  beats: [],
  replies: [],
};

export interface RenderBarOptions {
  /** Which scenario the header's reads are answered from. Silent by default. */
  readonly scenario?: ConsoleScenario;
}

export function renderBar(element: React.JSX.Element, options: RenderBarOptions = {}): HTMLElement {
  const scenario = options.scenario ?? CAST_BAR_SILENT_SCENARIO;
  const { container } = render(
    <SidekicksBridgeProvider bridge={createFixtureBridge({ scenario })}>
      {element}
    </SidekicksBridgeProvider>,
  );
  const bar = container.querySelector(".meridian-session-header");
  if (!(bar instanceof HTMLElement)) {
    throw new Error("SessionHeader rendered no header element");
  }
  return bar;
}
