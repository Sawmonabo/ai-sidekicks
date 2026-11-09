// A scenario's `session.read` reply: the record the frame reads before the session streams. The
// renderer reads a session through `session.read` and never through `session.list`, and its event
// stream waits on the log positions the record names, so a scenario whose session has a screen
// scripts one. The record is the one a read before any beat lands holds: no run has begun and no
// standing event has landed; the fixture daemon reads the newest position and the standing events
// from the delivered log.

import type {
  SessionReadResponse,
  SessionShape,
  SessionState,
} from "@ai-sidekicks/contracts/session/methods";
import { encodeEventCursor } from "@ai-sidekicks/contracts/session/event-cursor";
import {
  START_OF_LOG_POSITION,
  type EventCursor,
  type SessionId,
} from "@ai-sidekicks/contracts/session/id";

import type { ScenarioReply } from "#renderer/services/daemon/scenario/reply.fixture.js";
import type { ScenarioBeat } from "../scenario.js";
import { findBeatCursor } from "./script-entries.js";

/** What one scenario's session record says beyond its log. */
export interface SessionRecordInput {
  readonly sessionId: string;
  readonly state: SessionState;
  readonly shape: SessionShape;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** The script whose newest beat the record's `latest` names; empty for a session with none. */
  readonly beats: readonly ScenarioBeat[];
}

/** The `session.read` reply for one scenario's session. */
export function sessionReadReply(input: SessionRecordInput): ScenarioReply {
  return {
    call: "session.read",
    result: {
      session: {
        id: input.sessionId as SessionId,
        state: input.state,
        shape: input.shape,
        muted: false,
        pendingWorkingFolder: null,
        createdAt: input.createdAt,
        updatedAt: input.updatedAt,
        heldDraft: { draft: { text: "", extras: {} }, revision: 0 },
        attachments: [],
        permissionLevel: "ask",
        sessionMode: "build",
        addresses: [{ address: `/tmp/sidekicks/inbox/${input.sessionId}` }],
        tags: [],
      },
      transcriptCursors: {
        earliest: encodeEventCursor(START_OF_LOG_POSITION),
        latest:
          input.beats.length === 0
            ? encodeEventCursor(START_OF_LOG_POSITION)
            : (findBeatCursor(input.beats, input.beats.length - 1) as EventCursor),
      },
      liveRuns: [],
      standingEvents: [],
    } satisfies SessionReadResponse,
  };
}
