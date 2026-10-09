// The conversations a session left on its provider, over the `left_conversations` table in
// `session/daemon-schema.ts`: the one a fork moved it off, or the one a daemon restart's resume
// forked away from. Each row is written in the same write as the binding's new resume handle, so
// no conversation the session left is ever both unrecorded and unbound.

import { ProviderNameSchema, type ProviderName } from "@ai-sidekicks/contracts/provider/name";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import type { Database } from "better-sqlite3";

import type { WriteStatement } from "../database/statement.js";

/** A conversation a session moved off, on the account whose home holds it. */
export interface LeftConversation {
  readonly sessionId: SessionId;
  /** `undefined` on the node's default home. */
  readonly providerAccountId: string | undefined;
  /** The provider's own id: a Codex thread id or a Claude Code session id. */
  readonly conversationId: string;
}

/** A recorded left conversation, with the provider whose binding recorded it. */
interface LeftConversationRecord extends LeftConversation {
  readonly driverName: ProviderName;
  readonly leftAt: string;
}

// Lands only beside the binding update stamped `@left_at` in the same write, and takes the
// provider from that binding.
const INSERT_LEFT_CONVERSATION_SQL = `
  INSERT OR IGNORE INTO left_conversations
    (session_id, driver_name, provider_account_id, conversation_id, left_at)
  SELECT @session_id, driver_name, @provider_account_id, @conversation_id, @left_at
    FROM runtime_bindings
   WHERE id = @binding_id AND updated_at = @left_at`;

/**
 * The statement recording `conversation`, written after the update that stamped binding
 * `bindingId` with `leftAt`; it adds nothing when that update changed no row.
 */
export function composeLeftConversationInsert(
  bindingId: string,
  leftAt: string,
  conversation: LeftConversation,
): WriteStatement {
  return {
    sql: INSERT_LEFT_CONVERSATION_SQL,
    bindings: {
      binding_id: bindingId,
      left_at: leftAt,
      session_id: conversation.sessionId,
      provider_account_id: conversation.providerAccountId ?? null,
      conversation_id: conversation.conversationId,
    },
  };
}

interface LeftConversationRow {
  readonly session_id: string;
  readonly driver_name: string;
  readonly provider_account_id: string | null;
  readonly conversation_id: string;
  readonly left_at: string;
}

/**
 * Every conversation `sessionId` left on its providers, oldest first, for the whole-session purge,
 * which deletes each one from the provider: a Codex conversation through the service's own
 * `thread/delete` once the thread is unloaded, a Claude Code transcript from the account's config
 * folder.
 */
export function readLeftConversations(
  reader: Database,
  sessionId: SessionId,
): LeftConversationRecord[] {
  const rows = reader
    .prepare(
      `SELECT session_id, driver_name, provider_account_id, conversation_id, left_at
         FROM left_conversations
        WHERE session_id = ?
        ORDER BY left_at, conversation_id`,
    )
    .all(sessionId) as LeftConversationRow[];
  return rows.map((row) => ({
    sessionId: row.session_id as SessionId,
    driverName: ProviderNameSchema.parse(row.driver_name),
    providerAccountId: row.provider_account_id ?? undefined,
    conversationId: row.conversation_id,
    leftAt: row.left_at,
  }));
}
