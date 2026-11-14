// A session's standing notice, decoded at the bridge, so the session banners read the provider and
// what it reported from what this returns and never from the check.

import {
  validateSessionNoticePostedPayload,
  type SessionNoticePostedPayload,
} from "@ai-sidekicks/contracts/session/controls/events";

/** Read a `session.notice.posted` payload, or `undefined` where the wire's is off contract. */
export function readSessionNoticePostedPayload(
  payload: unknown,
): SessionNoticePostedPayload | undefined {
  return validateSessionNoticePostedPayload(payload) ? payload : undefined;
}
