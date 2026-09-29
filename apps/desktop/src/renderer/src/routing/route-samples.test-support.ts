// One list of routes per route kind, read by both routing suites.
//
// SHARED BECAUSE BOTH HALVES WALK THE SAME SET. The grammar suite round-trips every
// main-window route and the reader suite asks each predicate about every route of
// every kind, so a kind added to one list has to reach both — and a second list beside
// this one is the arm that gets forgotten, which shows up as a predicate nobody ever
// asked about the new kind. `.test-support` rather than an export from `routes.ts`:
// these are cases, and a production module publishing its own test corpus would be a
// shipping symbol nothing ships.

import type { AppRoute } from "./routes.js";

/** Main-window routes, including the arms that carry an optional segment. */
export const MAIN_WINDOW_ROUTES: readonly AppRoute[] = [
  { kind: "sessions" },
  { kind: "session", sessionId: "session-1" },
  // The same arm carrying its optional focus — the phase deep link a park banner
  // hands out. Listed beside the bare session screen so both suites are asked about the
  // pair rather than about whichever one somebody remembered.
  {
    kind: "session",
    sessionId: "session-1",
    workflowPhase: { workflowRunId: "run-1", phaseId: "review" },
  },
  { kind: "workflows" },
  { kind: "settings", page: undefined },
  { kind: "settings", page: "providers" },
  // The paged arm carrying its page's own selection — the deep link a provider row
  // hands the frame store. Listed here so both suites are asked about it.
  { kind: "settings", page: "providers", selection: "codex" },
  // The pane harness a fixture launch registers; `parseRoute` produces it in every
  // window.
  { kind: "pane-harness", paneKind: "terminal", sessionId: "session-1" },
  { kind: "not-found", attempted: "#/nowhere" },
];
