// The links the daemon records from events: written inside the producing event's own write, so a
// link exists exactly when its event does, and named by session id, so a rename changes none.

import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import type { SessionLinkKind } from "@ai-sidekicks/contracts/session/links";

import type { WriteStatement } from "../../database/statement.js";

/** A link kind an event records; none of them is ever removed. */
export type RecordedSessionLinkKind = Exclude<SessionLinkKind, "related">;

// A repeat of the same pair and kind is one more use: `messaged` counts the messages traded.
const RECORD_LINK_SQL = `INSERT INTO session_links
    (source_session_id, target_session_id, kind, use_count, first_at, last_at)
  VALUES (@sourceSessionId, @targetSessionId, @kind, 1, @occurredAt, @occurredAt)
  ON CONFLICT (source_session_id, target_session_id, kind)
  DO UPDATE SET use_count = use_count + 1, last_at = excluded.last_at`;

/**
 * The statement an event's producer puts in that event's write prelude to record its link, or
 * count one more use of it. Once the write commits, the producer asks the related ranking to
 * re-score around the two sessions.
 */
export function recordedSessionLinkStatement(link: {
  readonly sourceSessionId: SessionId;
  readonly targetSessionId: SessionId;
  readonly kind: RecordedSessionLinkKind;
  readonly occurredAt: string;
}): WriteStatement {
  return { sql: RECORD_LINK_SQL, bindings: link };
}
