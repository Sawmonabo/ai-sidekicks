// One list of routes per route kind, shared by both routing suites so a kind added here reaches
// the grammar round trip and the reader predicates alike.

import type { AppRoute } from "./routes.js";

/** Main-window routes, including the arms that carry an optional segment. */
export const MAIN_WINDOW_ROUTES: readonly AppRoute[] = [
  { kind: "sessions" },
  { kind: "session", sessionId: "session-1" },
  // The same arm carrying its optional focus, listed beside the bare session address.
  {
    kind: "session",
    sessionId: "session-1",
    workflowPhase: { workflowRunId: "run-1", phaseId: "review" },
  },
  { kind: "workflows" },
  { kind: "settings", page: undefined },
  { kind: "settings", page: "providers" },
  // The paged arm carrying its page's own selection.
  { kind: "settings", page: "providers", selection: "codex" },
  // The pane harness a fixture launch registers.
  { kind: "pane-harness", paneKind: "terminal", sessionId: "session-1" },
  { kind: "not-found", attempted: "#/nowhere" },
];
