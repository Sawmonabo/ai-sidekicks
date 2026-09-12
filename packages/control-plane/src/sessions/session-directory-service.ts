// SessionDirectoryService — the shared session directory.
//
// Responsibilities:
//   * createSession  — a daemon-assigned UUID v7 lands in the shared
//                      directory; idempotent on retry (no silent fork on a
//                      second create with the same id), binding the owner at
//                      first create by trust-on-first-use.
//   * readSession    — point-lookup by sessionId, returns the snapshot
//                      shape the wire contract publishes.
//
// Ownership model: a session has exactly one owner, recorded in
// `sessions.owner_user_id` and bound at the first successful create. There is
// no membership table and no role ladder — the owner is the user, and every
// other actor on a session is one of that user's own devices or the system
// itself.
//
// What this service does NOT do:
//   * Session-event payload storage — the shared Postgres store holds
//     coordination metadata only; per-node local SQLite is authoritative for
//     the event log.
//   * Connection pool construction — production wiring composes a `Querier`
//     from `pg.Pool`. Typing against the `Querier` interface keeps the test
//     surface (in-process pglite) and the production surface (`pg.Pool`)
//     interchangeable.

import type { Pool, PoolClient } from "pg";

import type {
  ChannelSummary,
  EventCursor,
  UserId,
  SessionCreateResponse,
  SessionId,
  SessionReadResponse,
  SessionSnapshot,
  SessionState,
} from "@ai-sidekicks/contracts";
import { EventCursorSchema } from "@ai-sidekicks/contracts";

import type { Querier } from "./migration-runner.js";

// --------------------------------------------------------------------------
// Placeholder cursor returned by `readSession`. The SDK composition
// layer queries the daemon's local event service for the authoritative
// cursor and overrides this field. Consumers MUST NOT treat the value as a
// real cursor.
//
// We construct via `EventCursorSchema.parse(...)` rather than `as EventCursor`
// so that any future tightening of the schema (e.g. requiring a
// `<sequence>_<monotonic_ns>` shape) surfaces as an import-time validation
// failure instead of silently passing a malformed value through to consumers
// at runtime.
// --------------------------------------------------------------------------

const CONTROL_PLANE_PLACEHOLDER_CURSOR: EventCursor =
  EventCursorSchema.parse("control-plane:no-cursor");

// --------------------------------------------------------------------------
// Internal row shapes — the JSON-readable shape returned by `pg.Pool#query`
// and `PGlite#query`. Both drivers map column names to the keys below
// because Postgres column identifiers are folded to lowercase by default
// and the schema uses `snake_case` columns.
// --------------------------------------------------------------------------

interface SessionRow {
  readonly id: string;
  readonly owner_user_id: string;
  readonly state: string;
  readonly config: Record<string, unknown>;
  readonly metadata: Record<string, unknown>;
  readonly min_client_version: string | null;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
}

// --------------------------------------------------------------------------
// Public service surface
// --------------------------------------------------------------------------

/**
 * Input shape for `createSession`.
 *
 * `sessionId` is daemon-assigned UUID v7 — the daemon mints the id locally
 * and presents it on the create call. The `gen_random_uuid()` DEFAULT on
 * the schema column exists for the rare control-plane-originated row (admin
 * provisioning) the create path always supplies the id explicitly.
 *
 * `ownerUserId` is REQUIRED and lands verbatim in
 * `sessions.owner_user_id`. This service is a faithful Postgres adapter;
 * identity resolution belongs upstream, so the caller is responsible for
 * resolving identity to a userId before invoking it. The column carries
 * no DEFAULT, so an owner this service failed to supply would be rejected by
 * the database rather than materialize an ownerless session.
 *
 * Forward-declared columns (not in this input shape):
 *   * `min_client_version` — owns attach-flow enforcement. Column
 *     declared in `0001-initial.ts` so the schema is stable across
 *     plans, but this path does not write it; the column lands as NULL on
 *     every create. will pick up the input shape on the read+write side
 *     at the same time.
 */
export interface CreateSessionInput {
  readonly sessionId: SessionId;
  readonly ownerUserId: UserId;
  readonly config?: Record<string, unknown> | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

export class SessionDirectoryService {
  readonly #querier: Querier;

  constructor(querier: Querier) {
    this.#querier = querier;
  }

  /**
   * Create (or idempotently re-create) a session.
   *
   * Invariant: the daemon mints UUID v7 for `sessionId` and presents it
   * here. The upsert pattern below is `ON CONFLICT (id) DO UPDATE SET
   * updated_at = sessions.updated_at` — note that `sessions.updated_at`
   * (the existing row's value) is assigned, NOT `now()`. This is a no-op
   * write that exists solely to make `RETURNING *` yield a row on every
   * attempt, letting the caller distinguish retry-after-crash from silent
   * write loss. `DO NOTHING` would skip RETURNING on conflict.
   *
   * On second create with the same `sessionId` and the SAME owner:
   *   * The existing row's `created_at`, `id`, and `owner_user_id` are
   *     preserved.
   *   * The `updated_at` value is preserved (the no-op assignment).
   *   * The response shape mirrors a first-create call so the caller's state
   *     machine doesn't need a retry-detect branch.
   *
   * On second create with the same `sessionId` but a DIFFERENT owner: throws.
   * Owner identity is bound at the first create and never rewritten.
   *
   * The guard is exact rather than advisory because the conflict clause does
   * not assign `owner_user_id` — so `RETURNING owner_user_id` yields the
   * PERSISTED owner, which is the row that was there before this call. A
   * mismatch between that value and the caller's `ownerUserId` is a
   * caller trying to take over someone else's session, and it is rejected
   * before the transaction commits.
   *
   * Concurrency: two transactions T1(sessionId=S, owner=P1) and
   * T2(sessionId=S, owner=P2) racing on the same `S` are serialized by the row
   * lock the `INSERT ... ON CONFLICT DO UPDATE` upsert itself acquires on the
   * `sessions` row. The loser observes the winner's committed `owner_user_id`
   * in its own `RETURNING` clause and throws. There is no read-then-write
   * window to lose, because the read IS the write's own output — which is why
   * collapsing the owner into a column on the session row removed a whole class
   * of race the separate-table shape needed an explicit `SELECT ... FOR UPDATE`
   * to close.
   *
   * The single statement runs inside `Querier.transaction(...)` so the mismatch
   * throw rolls back rather than leaving a half-applied create, and so the
   * pg.Pool adapter pins it to one checked-out connection.
   *
   * Why no error-handler around `transaction(...)`: PGlite's
   * `pg.transaction(fn)` (and the `pg`-side equivalent production wiring
   * composes for `pg.Pool`) auto-rolls-back on throw and re-raises the
   * underlying error. Adding a manual `ROLLBACK` here would race the
   * driver's auto-rollback path; the directory service relies on the
   * driver-supplied semantics.
   */
  async createSession(input: CreateSessionInput): Promise<SessionCreateResponse> {
    // The transaction callback receives a `Querier` bound to the same
    // connection so the routing concern (which connection to use) stays
    // encapsulated inside the adapter; the service body sees the same
    // surface as outside-transaction code.
    const sessionRow: SessionRow = await this.#querier.transaction(async (tx) => {
      // Idempotent session upsert — see method-level docstring for the
      // DO UPDATE-vs-DO NOTHING rationale.
      //
      // `config` and `metadata` are JSONB; pg + pglite both accept a JS
      // object directly (the driver serializes via JSON.stringify). The
      // `COALESCE(... , '{}'::jsonb)` lets the column DEFAULT apply when
      // the caller omits the field (we pass NULL in that case).
      //
      // `owner_user_id` is deliberately absent from the DO UPDATE assignment
      // list: an existing session's owner is never rewritten by a create.
      const sessionUpsert = await tx.query<SessionRow>(
        `INSERT INTO sessions (id, owner_user_id, config, metadata)
         VALUES ($1, $2, COALESCE($3, '{}'::jsonb), COALESCE($4, '{}'::jsonb))
         ON CONFLICT (id) DO UPDATE SET updated_at = sessions.updated_at
         RETURNING id, owner_user_id, state, config, metadata, min_client_version, created_at, updated_at`,
        [
          input.sessionId,
          input.ownerUserId,
          input.config !== undefined ? JSON.stringify(input.config) : null,
          input.metadata !== undefined ? JSON.stringify(input.metadata) : null,
        ],
      );
      const session: SessionRow | undefined = sessionUpsert.rows[0];
      if (session === undefined) {
        throw new Error(
          `SessionDirectoryService.createSession: session upsert returned no row for id=${String(input.sessionId)}`,
        );
      }

      // Owner-mismatch guard.
      //
      // RFC 9562 section 4 specifies UUIDs are case-insensitive, but Postgres stores
      // them in canonical lowercase form and returns them as lowercase
      // strings. A caller passing an id with uppercase hex digits — valid per
      // the brand's parser, which accepts both cases — would fail strict
      // string equality against the row value and falsely trip this throw on a
      // same-owner re-create. Both sides are normalized symmetrically: the row
      // side too, as defense against a future driver or substrate that does
      // not return the canonical form.
      if (session.owner_user_id.toLowerCase() !== input.ownerUserId.toLowerCase()) {
        throw new Error(
          `SessionDirectoryService.createSession: session ${String(input.sessionId)} already exists with a different owner; createSession is idempotent only when called with the same ownerUserId.`,
        );
      }

      return session;
    });

    // Channels are NOT a control-plane concern — channel metadata is
    // owned by the per-daemon local event log (see
    // `packages/runtime-daemon/src/session/session-projector.ts`). The
    // wire contract requires a `channels: ChannelSummary[]` field; this
    // service returns an empty array as the canonical "control plane has no
    // channel metadata" signal. The SDK composition layer merges the daemon's
    // projected channels with this empty list — the merge step is what
    // produces the user-visible channel list.
    const channels: ChannelSummary[] = [];

    return {
      sessionId: sessionRow.id as SessionId,
      state: sessionRow.state as SessionState,
      channels,
    };
  }

  /**
   * Point-lookup by sessionId. Returns `null` for unknown sessions.
   *
   * `timelineCursors.latest` is intentionally a placeholder string: the
   * control plane has no event log, so it cannot synthesize a real
   * cursor. The SDK composition layer queries the daemon's local
   * event service for the real cursor and overrides this field. Returning
   * a placeholder rather than throwing keeps the wire shape inhabited so
   * consumers don't need to special-case this path.
   *
   * The placeholder is NOT a wire-stable value — the SDK composition step
   * is the authoritative cursor source. Tests that exercise the wire
   * shape directly (P3 in this PR) intentionally do NOT assert on this
   * field's contents.
   */
  async readSession(sessionId: SessionId): Promise<SessionReadResponse | null> {
    const probe = await this.#querier.query<SessionRow>(
      `SELECT id, owner_user_id, state, config, metadata, min_client_version, created_at, updated_at
         FROM sessions
        WHERE id = $1`,
      [sessionId],
    );
    const row: SessionRow | undefined = probe.rows[0];
    if (row === undefined) {
      return null;
    }
    // `owner_user_id` and `min_client_version` are both read here and both
    // absent from the published snapshot: the row shape mirrors the table so
    // one hydration path serves every reader, and the wire shape is narrower
    // than the row on purpose.
    const session: SessionSnapshot = hydrateSessionSnapshot(row);
    return {
      session,
      timelineCursors: {
        // The value passes EventCursorSchema (min/max length) but is
        // NOT a wire-stable cursor; the SDK composition layer
        // overrides this field with the daemon's authoritative cursor.
        latest: CONTROL_PLANE_PLACEHOLDER_CURSOR,
      },
    };
  }
}

// --------------------------------------------------------------------------
// Row hydration
// --------------------------------------------------------------------------
//
// Postgres `TIMESTAMPTZ` columns are hydrated as a JS `Date` by BOTH drivers'
// default parsers — `pg` (pg-types OID 1184) and PGlite (`types.ts` date
// parser); the string arm keeps normalization total under custom parser
// configs. The wire contract requires ISO 8601
// per `SessionSnapshotSchema.createdAt` (`z.iso.datetime({ offset: true })`).
//
// `JSONB` columns are returned as plain JS objects (both drivers parse the
// JSON server-side and hydrate). No JSON.parse is needed at this boundary.

function toIsoString(value: Date | string): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  return value;
}

function hydrateSessionSnapshot(row: SessionRow): SessionSnapshot {
  return {
    id: row.id as SessionId,
    state: row.state as SessionState,
    config: row.config,
    metadata: row.metadata,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

// --------------------------------------------------------------------------
// pg.Pool -> Querier adapter
// --------------------------------------------------------------------------
//
// Production wiring composes a `Querier` from a `pg.Pool` so the same
// `SessionDirectoryService` body (typed against `Querier`) can run against
// shared Postgres in deployment AND against an in-process PGlite instance
// in test. Phase 4 shipped the service driver-agnostic; this adapter is the
// production-side concretion.
//
// Why a free function and not a class: the Querier interface is the only
// surface this composition exposes — it has no per-instance state beyond
// the Pool reference itself, and consumers never need to extend or
// subclass it. A factory keeps the call site one-liner
// (`createSessionDirectoryServiceFromPool(pool)`) without the noise of a
// constructable wrapper.
//
// The three Querier methods map onto three distinct pg.Pool affordances:
//
//   * `query()` -> `pool.query(sql, params)`. pg.Pool's parameterized
//     query helper internally `connect()`s, issues the statement over the
//     extended query protocol, and `release()`s the client back to the
//     pool. One round-trip, automatic checkout management. This is the
//     right primitive for stateless out-of-transaction reads/writes —
//     using `pool.connect()` here would force every Querier consumer to
//     manage release manually, leak connections on caller-side throws,
//     and add a checkout/release round-trip the pool already optimizes
//     away for the one-shot case.
//
//   * `exec()` -> `pool.query(sql)` (no params). Without a values array,
//     pg's `Client#query()` falls through to the simple query protocol
//     which permits multi-statement batches (`BEGIN; ...; COMMIT;`). This
//     is what the migration runner's `INITIAL_MIGRATION_SQL` body needs.
//     Same auto-checkout-and-release semantics as `query()`. The Querier
//     contract returns `void`; we discard the QueryResult.
//
//   * `transaction(fn)` -> `pool.connect()` + manual BEGIN/COMMIT. This
//     is the load-bearing concretion. See `createPgPoolQuerier` docstring
//     for the full mechanism.
//
// Why no error-handler wrapping pool errors: pg propagates `DatabaseError`
// (`pg-protocol`) instances on SQL failures and `Error` instances on
// transport failures; both bubble through unchanged so the service body
// sees the same surface as it would under PGlite (which throws on SQL
// failures from `pg.query()` too). Adding a translation layer here would
// only obscure the underlying driver error in stack traces.

/**
 * Wrap a `pg.Pool` so it satisfies the `Querier` contract.
 *
 * Pool-checkout-and-release semantics:
 *
 *   * `query()` and `exec()` route through `pool.query()`, which
 *     internally checks out a pooled client, runs the statement, and
 *     releases the client on the same call. Two consecutive `query()`
 *     calls MAY land on different pooled connections — that is fine for
 *     stateless statements, but is precisely why `transaction(fn)`
 *     cannot use the same pattern.
 *
 *   * `transaction(fn)` checks out ONE client via `pool.connect()`, holds
 *     it across `BEGIN` / inner statements / `COMMIT`, and releases on
 *     every exit path (commit success, application error, Postgres-side
 *     error during COMMIT, ROLLBACK error). Without a held client, each
 *     inner statement would check out a different pooled connection;
 *     `BEGIN` would land on one client, the inner statements on others,
 *     and `COMMIT` on yet another — the transaction would dissolve, AND
 *     any session-scoped state (advisory locks acquired via
 *     `pg_advisory_xact_lock`, `FOR UPDATE` row locks taken by the
 *     `createSession` ordering, server-side prepared statements) would
 *     not survive across statements.
 *
 *     The inner `Querier` passed to `fn` routes ALL THREE methods —
 *     `query`, `exec`, and `transaction` — through the held client, not
 *     back through the pool. Routing the inner `query()` through the pool
 *     instead of the held client would defeat the entire point of the
 *     transaction substrate (the lock would land on the wrong connection,
 *     or no specific connection at all). The nested-`transaction` call
 *     throws because Postgres has no native nested transactions without
 *     SAVEPOINTs and has no SAVEPOINT requirement — the throw matches the
 *     PGlite adapter's behavior so the failure mode is identical across
 *     substrates.
 *
 * Rollback behavior:
 *
 *   * On error inside `fn`, the adapter issues `ROLLBACK` and re-raises
 *     the underlying error. Unlike PGlite's `pg.transaction(fn)` (which
 *     auto-rolls-back internally), pg.Pool has no auto-rollback — without
 *     this manual ROLLBACK, an aborted transaction would stay open on the
 *     client until release, the client would return to the pool in an
 *     aborted state, and the next checkout would receive a client in a
 *     `25P02 current transaction is aborted` state. The ROLLBACK call is
 *     wrapped in its own try/catch so that a ROLLBACK failure (e.g., the
 *     underlying connection was already terminated) does NOT mask the
 *     original error — we still re-raise the original `fn` error, which
 *     is what the caller actually needs to diagnose.
 *
 *   * On success, `COMMIT` is issued. If COMMIT itself throws (e.g.,
 *     deferred constraint violation surfacing only at commit time), the
 *     adapter does NOT issue ROLLBACK after — at that point the
 *     transaction has already been rolled back server-side by Postgres
 *     in response to the failed COMMIT, and a follow-up ROLLBACK on a
 *     non-existent transaction would itself error. We re-raise the
 *     COMMIT error.
 *
 *   * `client.release()` always runs in the `finally` block so the
 *     connection returns to the pool whether the path terminated in
 *     commit success, application error + ROLLBACK, COMMIT-time error,
 *     or ROLLBACK error itself. Without the `finally`, any throw between
 *     `connect()` and `release()` would leak the connection — the pool
 *     would slowly deplete under any sustained error rate.
 *
 *   * Broken-client detection. A `'error'` event listener is attached
 *     at acquire-time; if the underlying socket breaks (ECONNRESET,
 *     server disconnect) mid-transaction the listener trips a `tainted`
 *     flag. The `finally` then calls `client.release(error)` instead of
 *     `client.release()` — node-postgres treats a truthy first arg as
 *     "disconnect and destroy" rather than "return to idle pool". The
 *     swallowed ROLLBACK catch also taints, because a failed ROLLBACK
 *     after a successful `fn` is invariably the connection dying
 *     mid-`fn`. Statement-position classification alone (BEGIN/COMMIT
 *     threw → tainted) is unreliable: a perfectly healthy client can
 *     fail COMMIT on a deferred-constraint violation, and a broken
 *     client can surface only via the listener after the in-flight
 *     query rejected.
 */
export function createPgPoolQuerier(pool: Pool): Querier {
  return {
    query: async <T>(
      sql: string,
      params?: ReadonlyArray<unknown>,
    ): Promise<{ rows: ReadonlyArray<T> }> => {
      // pg's `query()` parameter array is typed as `unknown[]` (mutable),
      // not `ReadonlyArray<unknown>`. The spread copy decouples the
      // mutability claim at the type boundary without copying parameter
      // values themselves. Mirrors the PGlite adapter pattern in the
      // session-directory-service test file.
      const mutableParams: unknown[] = params === undefined ? [] : [...params];
      // Substrate-vs-surface generic-shape mismatch. `pool.query<R extends
      // QueryResultRow>` constrains `R` to `{ [column: string]: any }`,
      // but the Querier surface (`migration-runner.ts:111`) is generic on
      // a free `T` so the service body can declare row shapes that don't
      // match the substrate's index-signature constraint. We take the cast
      // because preserving the Querier-side generic is what keeps the
      // service body interchangeable across substrates — narrowing the
      // surface to `<T extends Record<string, unknown>>` would propagate
      // the pg-specific constraint into the migration-runner Querier
      // contract and into the PGlite test adapter, breaking both. The
      // PGlite test adapter takes the same lateral cast for the same
      // reason (see `wrap()` in the test file).
      const result = await pool.query<Record<string, unknown>>(sql, mutableParams);
      return { rows: result.rows as ReadonlyArray<T> };
    },
    exec: async (sql: string): Promise<void> => {
      // No params -> simple query protocol -> multi-statement batches
      // permitted. See file-level docstring for the protocol rationale.
      await pool.query(sql);
    },
    transaction: async <T>(fn: (tx: Querier) => Promise<T>): Promise<T> => {
      // Hold ONE client across BEGIN/COMMIT — see method docstring for
      // the connection-affinity rationale.
      const client = await pool.connect();
      // Connection-level fault detection. pg's `PoolClient` emits
      // `'error'` when the underlying socket breaks (ECONNRESET, server
      // disconnect, etc.). When that fires we must NOT return the
      // client to the idle pool — node-postgres docs say `release(true)`
      // disconnects+destroys instead. Statement-position-based
      // classification (BEGIN/COMMIT/ROLLBACK threw) is unreliable:
      // a healthy client can fail COMMIT on a deferred-constraint
      // violation, and a broken client can surface only via the
      // 'error' event after the in-flight query rejected. The
      // listener pattern is the canonical broken-client signal.
      let tainted = false;
      const onError = (): void => {
        tainted = true;
      };
      client.on("error", onError);
      try {
        await client.query("BEGIN");
        let result: T;
        try {
          result = await fn(createPoolClientQuerier(client));
        } catch (originalError) {
          // Application error inside `fn`. Issue ROLLBACK and re-raise
          // the original error. The ROLLBACK is wrapped in its own
          // try/catch so a ROLLBACK failure does NOT mask the caller-
          // facing original error.
          try {
            await client.query("ROLLBACK");
          } catch {
            // Original error is what the caller needs to diagnose; the
            // ROLLBACK throw is suppressed. A ROLLBACK that fails after
            // a successful `fn` invariably means the connection died
            // mid-`fn` (the in-flight ROLLBACK couldn't reach the
            // server), so taint the client even if the 'error' event
            // hasn't propagated yet — belt-and-braces against the
            // race between the rejected query and the listener fire.
            tainted = true;
          }
          throw originalError;
        }
        await client.query("COMMIT");
        return result;
      } finally {
        // Detach the listener BEFORE release so a late-arriving
        // 'error' event doesn't leak a closure reference. Then
        // release: destroy on tainted (truthy first arg per
        // node-postgres docs), otherwise return to the idle pool.
        client.removeListener("error", onError);
        if (tainted) {
          client.release(new Error("transaction client tainted by connection-level fault"));
        } else {
          client.release();
        }
      }
    },
  };
}

/**
 * Adapt a held `PoolClient` to the `Querier` interface for use inside a
 * `transaction(fn)` callback.
 *
 * All three methods route through the SAME held client so the transaction
 * boundary and any session-scoped state (advisory locks, FOR UPDATE row
 * locks, prepared statements) survive across inner statements. Nested
 * `transaction()` calls throw — Postgres has no native nested transactions
 * without SAVEPOINTs and has no SAVEPOINT requirement. The throw matches
 * the PGlite test adapter's behavior so the failure mode is identical
 * across substrates.
 *
 * This factory is internal-only: callers should reach `pg.Pool` through
 * `createPgPoolQuerier`, which constructs this inner Querier on every
 * `transaction()` entry.
 */
function createPoolClientQuerier(client: PoolClient): Querier {
  return {
    query: async <T>(
      sql: string,
      params?: ReadonlyArray<unknown>,
    ): Promise<{ rows: ReadonlyArray<T> }> => {
      const mutableParams: unknown[] = params === undefined ? [] : [...params];
      // Cast rationale identical to `createPgPoolQuerier`'s `query` — see
      // the substrate-vs-surface generic-shape comment there. `client.query`
      // shares the `R extends QueryResultRow` constraint with `pool.query`,
      // so the same lateral cast applies on the held-client path.
      const result = await client.query<Record<string, unknown>>(sql, mutableParams);
      return { rows: result.rows as ReadonlyArray<T> };
    },
    exec: async (sql: string): Promise<void> => {
      await client.query(sql);
    },
    transaction: <T>(_fn: (tx: Querier) => Promise<T>): Promise<T> => {
      // Postgres has no native nested transactions without SAVEPOINTs.
      // has no SAVEPOINT requirement; the throw matches the PGlite test
      // adapter's behavior so the failure mode is identical across
      // substrates. A future plan that needs nested-transaction semantics
      // MUST extend the Querier contract (add a `savepoint(fn)` method)
      // rather than overloading `transaction()` with a substrate-specific
      // shape.
      return Promise.reject(
        new Error(
          "Querier.transaction(): nested transactions are not supported on this substrate.",
        ),
      );
    },
  };
}

/**
 * Compose a `SessionDirectoryService` from a `pg.Pool`.
 *
 * Convenience one-liner for production wiring: the SDK and the
 * control-plane host get a fully-constructed service in one call instead
 * of the two-step `new SessionDirectoryService(createPgPoolQuerier(pool))`.
 */
export function createSessionDirectoryServiceFromPool(pool: Pool): SessionDirectoryService {
  return new SessionDirectoryService(createPgPoolQuerier(pool));
}
