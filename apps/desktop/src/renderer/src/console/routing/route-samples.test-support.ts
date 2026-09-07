// One list of routes per family, read by both routing suites.
//
// SHARED BECAUSE BOTH HALVES WALK THE SAME SET. The grammar suite round-trips every
// main-window route and the reader suite asks each predicate about every route of
// every kind, so a kind added to one list has to reach both — and a second list beside
// this one is the arm that gets forgotten, which shows up as a predicate nobody ever
// asked about the new kind. `.test-support` rather than an export from `routes.ts`:
// these are cases, and a production module publishing its own test corpus would be a
// shipping symbol nothing ships.

import type { ConsoleRoute } from "./routes.js";

/** Main-window routes, including the arms that carry an optional segment. */
export const MAIN_WINDOW_ROUTES: readonly ConsoleRoute[] = [
  { kind: "sessions" },
  { kind: "workspace", sessionId: "session-1" },
  { kind: "workflows" },
  { kind: "settings", page: undefined },
  { kind: "settings", page: "providers" },
  // The paged arm carrying its page's own selection — the deep link a provider row
  // hands the frame store. Listed here so both suites are asked about it.
  { kind: "settings", page: "accounts", selection: "codex" },
  // The fixture-only arm. `parseRoute` produces it exactly where
  // `__SIDEKICKS_CONSOLE_FIXTURES__` is true, which the `console-unit` project
  // substitutes as it does for every console tier — so the round trip that walks this
  // list is testing the same build the fixture console runs.
  { kind: "pane-harness", paneKind: "terminal", sessionId: "session-1" },
  { kind: "not-found", attempted: "#/nowhere" },
];

/** Auxiliary routes as values, for the predicates. Never parsed from a hash here. */
export const AUXILIARY_ROUTES: readonly ConsoleRoute[] = [
  { kind: "auxiliary", route: "timeline" },
  { kind: "auxiliary", route: "timeline", sessionId: "session-1" },
  { kind: "auxiliary", route: "agent-console", sessionId: "session-1", agentId: "agent-1" },
];

export const EVERY_KIND: readonly ConsoleRoute[] = [...MAIN_WINDOW_ROUTES, ...AUXILIARY_ROUTES];
