// ChannelListProjection.
//
// Responsibilities:
//   * list — the `ChannelList` read-only projection. Given a
//     `ChannelListRequest {sessionId}`, return the channels that currently
//     exist for the session as a strict-shaped `ChannelListResponse`. There is
//     no per-caller filter: the one user sees every channel in the session.
//
// What this projection synthesizes, and why it does NOT read a channels table:
//
//   The bootstrap "main" channel is a PROJECTED STRUCTURAL INVARIANT: exactly
//   one per session, 1:1 with the session, its id a PURE FUNCTION of the
//   session id (`deriveMainChannelId(sessionId)` — the shared derivation in
//   `@ai-sidekicks/contracts`, byte-identical to the daemon's projected id). It
//   is NOT born from a `ChannelCreated` event; it exists logically the instant
//   a session exists.
//
//   The control plane has NO channels table and NO channel event store — it
//   stores coordination metadata only, and the per-daemon local SQLite event
//   log is authoritative for the event stream.
//   `SessionDirectoryService.createSession` returns an EMPTY `channels` array
//   precisely because channel metadata is not a control-plane concern.
//
//   The projection projects whatever channels currently exist regardless of
//   who created them; because the bootstrap main channel always exists
//   logically for any session that exists, this projection SYNTHESIZES exactly
//   that one channel from the control plane's OWN data (the `sessions` row's
//   existence plus the membership count) and stamps its id with the shared
//   `deriveMainChannelId`. It does not — and must not — add a channels table
//   or depend on `@ai-sidekicks/runtime-daemon`; runtime channel creation
//   (`ChannelCreate`, additional channels) is owned by the daemon.
//
// Idiom: this mirrors `SessionDirectoryService` (session-directory-service.ts)
//   — a class with a constructor-injected `Querier` so the same body runs
//   against an in-process PGlite in test and a `pg.Pool`-backed `Querier` in
//   production wiring (the same driver-agnostic seam the session core
//   established).

import { deriveMainChannelId, MAIN_CHANNEL_NAME } from "@ai-sidekicks/contracts";
import type {
  ChannelListRequest,
  ChannelListResponse,
  ChannelListResponseChannel,
  ChannelState,
  MembershipState,
} from "@ai-sidekicks/contracts";

import type { Querier } from "../sessions/migration-runner.js";

// --------------------------------------------------------------------------
// Bootstrap channel constants
// --------------------------------------------------------------------------
//
// The bootstrap channel always carries the canonical name `MAIN_CHANNEL_NAME`
// ("main") imported from `@ai-sidekicks/contracts` — the single source of truth
// for the bootstrap channel's name, byte-identical to the name the daemon
// projects for the same channel (both surfaces import the same const). The wire
// contract makes `name` optional ("key absent" encodes the unnamed case), but
// the bootstrap channel is never unnamed, so we always
// emit `name: MAIN_CHANNEL_NAME`.

// The bootstrap channel is the live default channel, so its state is "active".
// `ChannelState` is `"active" | "muted" | "archived"`; "muted"/"archived" are
// runtime mutations, never the bootstrap default.
// The `: ChannelState` annotation is a compile-time tripwire — a typo or a
// future 4th channel state fails compile at this declaration (mirroring the
// `PRESENCE_PROGRESSION` rationale in the presence service).
const MAIN_CHANNEL_STATE: ChannelState = "active";

// The bootstrap channel's id is the shared `deriveMainChannelId(sessionId)`
// from `@ai-sidekicks/contracts` — the single source of truth for the main
// channel's identity, byte-identical to the daemon's projected id (it mixes a
// `${sessionId}:main` suffix into the hash input so a session id and its
// derived channel id never collide).

/**
 * Membership-state filter for `participantCount`.
 *
 * The count reflects participants ACTUALLY present in the channel, so it
 * counts only `active` memberships. `createSession` inserts the owner row with
 * `state = 'active'`; any non-`active` row is not present in the channel, so
 * `state = 'active'` is the correct "currently present" predicate.
 */
const ACTIVE_MEMBERSHIP_STATE: MembershipState = "active";

// --------------------------------------------------------------------------
// Internal row shapes
// --------------------------------------------------------------------------

interface SessionExistenceRow {
  readonly id: string;
}

interface ParticipantCountRow {
  // `SELECT COUNT(*)::int AS n` — the `::int` cast keeps the value a JS number
  // (Postgres returns BIGINT for COUNT(*), which `pg` would otherwise hydrate
  // as a string).
  readonly n: number;
}

export class ChannelListProjection {
  readonly #querier: Querier;

  constructor(querier: Querier) {
    this.#querier = querier;
  }

  /**
   * Project the channels for a session.
   *
   * Returns `null` for a nonexistent session — mirroring `readSession`'s
   * null-on-absent convention. The tRPC router maps that `null` to a
   * `session.not_found` envelope;
   * returning `null` rather than throwing keeps the not-found path uniform
   * with the rest of the directory surface.
   *
   * For an existing session, returns EXACTLY ONE channel — the bootstrap
   * "main" channel synthesized from the control plane's own data (see the
   * file header for why no channels table is read).
   */
  async list(request: ChannelListRequest): Promise<ChannelListResponse | null> {
    // 1. Session-existence probe. Mirrors `readSession`'s
    //    `SELECT ... FROM sessions WHERE id = $1` probe and its
    //    null-on-absent return.
    const sessionProbe = await this.#querier.query<SessionExistenceRow>(
      "SELECT id FROM sessions WHERE id = $1",
      [request.sessionId],
    );
    const sessionRow: SessionExistenceRow | undefined = sessionProbe.rows[0];
    if (sessionRow === undefined) {
      return null;
    }

    // 2. Count participants actually present in the channel. `state = 'active'`
    //    — see `ACTIVE_MEMBERSHIP_STATE` docstring for the filter rationale.
    const countProbe = await this.#querier.query<ParticipantCountRow>(
      "SELECT COUNT(*)::int AS n FROM session_memberships WHERE session_id = $1 AND state = $2",
      [request.sessionId, ACTIVE_MEMBERSHIP_STATE],
    );
    // `?? 0` defends the empty-result edge (a count query always returns one
    // row in practice, but `noUncheckedIndexedAccess` makes the optional
    // access explicit, and 0 is the correct floor for "no active members").
    const participantCount: number = countProbe.rows[0]?.n ?? 0;

    // 3. Synthesize the single bootstrap "main" channel.
    const mainChannel: ChannelListResponseChannel = {
      id: deriveMainChannelId(request.sessionId),
      // Always present — the bootstrap channel is never unnamed. We set the
      // key (never `name: undefined`) so the value survives under
      // `exactOptionalPropertyTypes`.
      name: MAIN_CHANNEL_NAME,
      state: MAIN_CHANNEL_STATE,
      participantCount,
    };

    return { channels: [mainChannel] };
  }
}
