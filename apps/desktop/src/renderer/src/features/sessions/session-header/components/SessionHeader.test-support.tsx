// What the session-header suites build: a store standing in for a session, and the
// mount that hands back the header element.
//
// One module rather than a copy in each, because the suites assert against the SAME
// header, and two spellings of "a session in this state" would let one file pass against
// a header the others never build.

import { render } from "@testing-library/react";

import { DesktopBridgeProvider } from "@renderer/console/bridge/BridgeProvider.js";
import { createFixtureBridge } from "@renderer/console/bridge/fixture/call-plane/bridge.js";
import { USER_YOU } from "@renderer/console/bridge/scenario/flagship/flagship-cast.js";
import { SessionStore } from "@renderer/store/session/session-store.js";
import { type ConsoleEntity } from "@renderer/store/session/entities/entities.js";
import type { ConsoleScenario } from "@renderer/console/bridge/scenario/runtime/index.js";

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
   * never delivered here. Absent, the read opened at the beginning of the log.
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
 * A scenario that scripts no reply at all.
 *
 * The header reads nothing through the bridge, but the mount still needs one, so every
 * case renders inside a bridge whose scenario declares no answer.
 */
export const CAST_BAR_SILENT_SCENARIO: ConsoleScenario = {
  id: "session-header-silent",
  label: "Session header, nothing scripted",
  purpose: "A session with no scripted replies.",
  sessionId: SESSION_ID,
  userIdsInJoinOrder: [USER_YOU],
  startedAtIso: "2026-01-01T14:20:00.000Z",
  beats: [],
  replies: [],
};

export interface RenderBarOptions {
  /** Which scenario the bridge is built from. Silent by default. */
  readonly scenario?: ConsoleScenario;
}

export function renderBar(element: React.JSX.Element, options: RenderBarOptions = {}): HTMLElement {
  const scenario = options.scenario ?? CAST_BAR_SILENT_SCENARIO;
  const { container } = render(
    <DesktopBridgeProvider bridge={createFixtureBridge({ scenario })}>
      {element}
    </DesktopBridgeProvider>,
  );
  const bar = container.querySelector(".meridian-session-header");
  if (!(bar instanceof HTMLElement)) {
    throw new Error("SessionHeader rendered no header element");
  }
  return bar;
}
