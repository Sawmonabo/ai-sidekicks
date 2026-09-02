// The browser scenario — a session an agent is browsing in.
//
// WHAT IT CAN SCRIPT, AND WHY THAT IS SO LITTLE. A scenario's beats are session
// events, and the browser namespace is unregistered — `Plan-023 §Console growth
// slate` rows 1, 2, and 4 — so there is no page-opened event type, no navigation
// event type, and no tool-call event type to script. Inventing one here would put a
// wire string in the fixture that no document owns, and the fixture's whole value
// is that it is shape-identical to something real.
//
// So this scenario scripts the session AROUND the browsing: the participant, the
// agent that will do the browsing, and the run it does it under. What the pane
// itself shows stays the growth port's refusal, which is the honest rendering of a
// console whose browser wire is not registered — and the day rows 1, 2, and 4 land,
// the page beats are appended here rather than a second scenario being minted.
//
// The replies are the two the frame's opening reads make, matching `first-run.ts`.
// A reply for a browser call would name a method string this corpus has not
// registered, which is the same fabrication the beats avoid.

import type { ConsoleScenario } from "../scenario.js";

export const BROWSER_SCENARIO_ID = "browser";

const SESSION_ID = "session-browser";

export const BROWSER_SCENARIO: ConsoleScenario = {
  id: BROWSER_SCENARIO_ID,
  label: "Browsing agent",
  purpose:
    "A session whose agent works in the embedded browser. The surrounding session lands here; the page beats are appended once the browser namespace, the tool relay, and the dev-server probe are registered.",
  sessionId: SESSION_ID,
  // Join order IS hue order (`Spec-023 §Console Design (Meridian)` rule 2), so a
  // screenshot baseline depends on this list. One person and one agent: the pane's
  // whole design question is what a human sees of what an agent is doing, and a
  // second agent would only add a hue.
  participantIdsInJoinOrder: ["participant-you", "agent-scout"],
  startedAtIso: "2026-01-01T11:05:00.000Z",
  beats: [
    {
      atMs: 0,
      event: {
        sessionId: SESSION_ID,
        sequence: 1,
        kind: "session.created",
        occurredAt: "2026-01-01T11:05:00.000Z",
        actorParticipantId: "participant-you",
        payload: { title: "Check the staging build" },
      },
    },
    {
      atMs: 80,
      event: {
        sessionId: SESSION_ID,
        sequence: 2,
        kind: "agent.attached",
        occurredAt: "2026-01-01T11:05:00.080Z",
        actorParticipantId: "agent-scout",
        payload: { agentId: "agent-scout", displayName: "Scout" },
      },
    },
    {
      atMs: 240,
      event: {
        sessionId: SESSION_ID,
        sequence: 3,
        kind: "run.queued",
        occurredAt: "2026-01-01T11:05:00.240Z",
        actorParticipantId: "agent-scout",
        payload: { runId: "run-browse-staging" },
      },
    },
    {
      atMs: 320,
      event: {
        sessionId: SESSION_ID,
        sequence: 4,
        kind: "run.running",
        occurredAt: "2026-01-01T11:05:00.320Z",
        actorParticipantId: "agent-scout",
        payload: { runId: "run-browse-staging" },
      },
    },
  ],
  replies: [
    { call: "session.list", result: { sessions: [{ sessionId: SESSION_ID }] } },
    { call: "agent.list", result: { agents: [{ agentId: "agent-scout" }] } },
  ],
};
