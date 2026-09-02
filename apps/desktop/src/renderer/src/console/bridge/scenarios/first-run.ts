// The first-run scenario: a console with nothing in it yet.
//
// This is the scenario the screenshot baseline pins, because the emptiest state is
// the one most likely to look unfinished and the product bar is that it does not.
// `Spec-023 §Console Design (Meridian)` §The five kinds of nothing is the whole
// design problem here: a fresh install has no sessions, and "no sessions yet" is
// the EMPTY kind — a stated fact with a next action — not the "not loaded" kind and
// not an error.
//
// It scripts exactly one beat, the session the participant is about to create not
// existing yet, and the replies the frame's opening reads need. Everything else the
// first-run frame shows comes from the growth port refusing, which is the honest
// rendering of a console whose onboarding wire is not registered.
//
// Its beat and its replies are held to the shipped wire contract by
// `scenarios/wire-truth.ts`, exactly as the flagship's are; that file's header
// carries the reasoning, and the two consequences visible here are the same two:
// the identifiers are the UUIDs the branded id types declare, and `session.created`
// carries `{sessionId, config, metadata}` — the registered payload — rather than a
// title, which its `.strict()` schema rejects.

import type { ConsoleScenario } from "../scenario.js";

export const FIRST_RUN_SCENARIO_ID = "first-run";

const SESSION_ID = "019b78c9-0a80-75e5-8510-ada11a5a22a5";
const PARTICIPANT_YOU = "019b78c9-0a80-79a4-8110-cca0117a0220";

export const FIRST_RUN_SCENARIO: ConsoleScenario = {
  id: FIRST_RUN_SCENARIO_ID,
  label: "First run",
  purpose:
    "A freshly installed console with no sessions, no agents, and no history — the state the empty-state design and the screenshot baseline are pinned against.",
  sessionId: SESSION_ID,
  participantIdsInJoinOrder: [PARTICIPANT_YOU],
  // The sole member, and this window is them. A fresh install has exactly one
  // participant, so the identity is not in doubt — which is why it is stated: a
  // first-run surface that could not resolve its own participant would render the
  // invite affordance as unavailable on the one screen whose whole job is to offer it.
  viewingParticipantId: PARTICIPANT_YOU,
  // And their role, without which the identity above answers into an empty roster:
  // the invite affordance this screen exists to offer is owner-gated, so a first-run
  // console whose sole member resolved to no role would render the one control the
  // whole surface is for as unavailable.
  membershipRoleByParticipantId: { [PARTICIPANT_YOU]: "owner" },
  startedAtIso: "2026-01-01T09:00:00.000Z",
  beats: [
    {
      atMs: 0,
      event: {
        // The daemon's own opaque row id for this event. Spelled as a UUID v7
        // like every other identifier in this file, so a rendered id has the
        // width a real one does.
        id: "019b78c9-0a80-7ea1-8110-e5e0d1150001",
        sessionId: SESSION_ID,
        sequence: 1,
        kind: "session.created",
        occurredAt: "2026-01-01T09:00:00.000Z",
        actorId: PARTICIPANT_YOU,
        payload: { sessionId: SESSION_ID, config: {}, metadata: {} },
      },
    },
  ],
  replies: [
    {
      // A session read that answers `provisioning`, which is what a session being
      // created reads as before it is admitted — the honest first-run answer, and
      // a state the console has to render as well as `active`.
      call: "session.read",
      result: {
        session: {
          id: SESSION_ID,
          state: "provisioning",
          config: {},
          metadata: {},
          createdAt: "2026-01-01T09:00:00.000Z",
          updatedAt: "2026-01-01T09:00:00.000Z",
        },
        timelineCursors: { latest: "first-run-cursor-1" },
      },
    },
    { call: "agent.list", result: { agents: [] } },
  ],
};
