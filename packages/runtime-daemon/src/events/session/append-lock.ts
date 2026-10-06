// The per-session append lock. It guarantees only the order of a session's writes: a caller holding
// a session queues its writes before any other caller's on that session. It does not make a read
// and a later write one step, because an append lets the lock go once its row is queued, before
// the commit, so a read taken under the lock may miss a queued row. Every read that decides a
// write therefore goes inside that write as a guarded statement, with the row count it expects.
//
// - The scope is one session, so a long hold on one session never blocks another.
// - The lock is process-local. Two daemon processes on one database file are caught only by the
//   unique sequence constraint, which fails loudly instead of duplicating a sequence.
// - It is reentrant, so a producer holding a session can call `EventLogService.append`, which
//   takes the same lock.
// - The module imports only contracts and the lock itself, never its consumers, so the module
//   graph stays a tree and the shared instance is initialized before anything reads it.

import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import { canonicalizeUuid } from "@ai-sidekicks/contracts/uuid-canonical";

import { KeyedLock } from "../../keyed-lock.js";

/**
 * The per-session append lock, shared by every service over the daemon's database. A session id
 * spelled in either hex case takes one lock.
 */
export const sessionAppendLock: KeyedLock<SessionId> = new KeyedLock<SessionId>(canonicalizeUuid);
