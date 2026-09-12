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
//   existence) and stamps its id with the shared `deriveMainChannelId`. It
//   does not — and must not — add a channels table
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
 * `userCount` for the bootstrap channel.
 *
 * One user owns a session and no other person is ever on it, so the count of
 * people present in the channel is the owner alone. It is a constant rather
 * than a query because the session row's existence — already probed below — is
 * the whole of the evidence: the owner is bound at create time on that same
 * row and cannot leave. A count of the user's connected DEVICES is a different
 * figure and belongs to the device-presence surface, not here.
 */
const OWNER_USER_COUNT = 1;

// --------------------------------------------------------------------------
// Internal row shapes
// --------------------------------------------------------------------------

interface SessionExistenceRow {
  readonly id: string;
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

    // 2. Synthesize the single bootstrap "main" channel.
    const mainChannel: ChannelListResponseChannel = {
      id: deriveMainChannelId(request.sessionId),
      // Always present — the bootstrap channel is never unnamed. We set the
      // key (never `name: undefined`) so the value survives under
      // `exactOptionalPropertyTypes`.
      name: MAIN_CHANNEL_NAME,
      state: MAIN_CHANNEL_STATE,
      userCount: OWNER_USER_COUNT,
    };

    return { channels: [mainChannel] };
  }
}
