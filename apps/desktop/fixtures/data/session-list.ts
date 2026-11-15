// What a scenario's session list opens with: the two running sessions the MCP servers page's
// inventory names as its legs' sessions, both chats.

import type { SubscriptionId } from "@ai-sidekicks/contracts/jsonrpc/streaming";
import type {
  SessionListEntry,
  SessionSubscribeResponse,
} from "@ai-sidekicks/contracts/session/directory";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import type { ScenarioOpeningNotice } from "#renderer/services/daemon/scenario/reply.fixture.js";

/** The running chat the session list names `Fix login`. */
export const FIX_LOGIN_SESSION_ID = "019b79ee-0280-75e5-8510-ada11a5a21a5" as SessionId;

/** The running chat the session list names `Refresh-token expiry`. */
export const TOKEN_EXPIRY_SESSION_ID = "019b79ee-0280-75e5-8510-ada11a5a22a5" as SessionId;

/** When each listed session last moved. */
const LAST_ACTIVITY_AT = "2026-01-01T08:55:00.000Z";

/**
 * The frame `session.subscribe` opens with: the list as it stands, naming the two running sessions,
 * both chats, so the daemon counts two.
 */
export const SESSION_LIST_OPENING_NOTICES: readonly ScenarioOpeningNotice[] = [
  {
    stream: "session.subscribe",
    payloadAtOpen: (): SessionSubscribeResponse => ({
      subscriptionId: "019b79ee-0280-7d11-8510-ada11a5a2300" as SubscriptionId,
      sessions: [
        runningChat(FIX_LOGIN_SESSION_ID, "Fix login"),
        runningChat(TOKEN_EXPIRY_SESSION_ID, "Refresh-token expiry"),
      ],
      chatCount: 2,
      isComplete: true,
    }),
  },
];

function runningChat(sessionId: SessionId, name: string): SessionListEntry {
  return {
    sessionId,
    name,
    shape: "chat",
    state: "active",
    activity: "running",
    activityRenewedAt: LAST_ACTIVITY_AT,
    muted: false,
    lastActivityAt: LAST_ACTIVITY_AT,
  };
}
