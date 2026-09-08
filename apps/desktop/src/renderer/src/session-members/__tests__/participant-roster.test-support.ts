// The fixtures and the mock bridge the ParticipantRoster suites share.
//
// Split out when the single suite passed the package's file ceiling: one file was
// carrying a hundred lines of scaffolding, seven lifecycle cases, four failure cases,
// and a source-text tripwire, which is four jobs. What moved here is the part none of
// those jobs owns — the branded-id fixtures, the presence snapshots they compose, the
// deferred the out-of-order guard needs, and the install / remove pair every case runs
// its bridge through. The shape is `runtime-node-attach/__tests__`' own
// `attach-flow.test-support.ts`: an install and a matching remove, so no suite writes
// the teardown by hand and two suites cannot disagree about what teardown means.
//
// The bridge stays DUPLICATED from `SessionBootstrap.test.tsx` per the T6.3 standing
// directive: this view's surface is `{ daemon: { call, subscribe } }`, wider than the
// call-only one that suite installs, so one helper could not serve both.
//
// Vitest 4 `globals: true` (renderer project) supplies `vi`; the renderer test tsconfig
// adds `vitest/globals` to `types`.

import type {
  ParticipantId,
  PresenceReadResponse,
  SessionId,
  SidekicksBridge,
  Unsubscribe,
} from "@ai-sidekicks/contracts";

// Branded id fixtures — `"<uuid>" as SessionId` / `as ParticipantId` mirrors the
// shipped SDK precedent (packages/client-sdk/test/membershipClient.integration.test.ts:64-70).
export const KNOWN_SESSION_ID = "01970000-0000-7000-8000-0000000000a1" as SessionId;
// A SECOND session id for the session-switch test: re-rendering with a new
// `sessionId` must reset the roster to loading (not show the prior session's
// stale `loaded` roster) and re-read for the new session.
export const SECOND_SESSION_ID = "01970000-0000-7000-8000-0000000000a2" as SessionId;
export const PARTICIPANT_ONLINE = "01970000-0000-7000-8000-0000000000b1" as ParticipantId;
export const PARTICIPANT_OFFLINE = "01970000-0000-7000-8000-0000000000b2" as ParticipantId;
export const PARTICIPANT_RECONNECTING = "01970000-0000-7000-8000-0000000000b3" as ParticipantId;
export const PARTICIPANT_NEW_ON_REREAD = "01970000-0000-7000-8000-0000000000b4" as ParticipantId;
// A member that belongs ONLY to SECOND_SESSION_ID's roster — used to prove the
// new session's participants eventually load after a session switch.
export const PARTICIPANT_SECOND_SESSION = "01970000-0000-7000-8000-0000000000b5" as ParticipantId;

// Two snapshots so the re-read test can assert the roster updates from one to
// the other on a subscribe push. SNAPSHOT_ONE varies `state` across the
// `PresenceState` union and INCLUDES an `"offline"` member to pin Spec-002 AC2
// (an offline member renders a row, does not vanish).
export const SNAPSHOT_ONE: PresenceReadResponse = {
  participants: [
    {
      participantId: PARTICIPANT_ONLINE,
      state: "online",
      lastSeen: "2026-05-26T10:00:00.000Z",
    },
    {
      participantId: PARTICIPANT_OFFLINE,
      state: "offline",
      lastSeen: "2026-05-26T09:55:00.000Z",
    },
    {
      participantId: PARTICIPANT_RECONNECTING,
      state: "reconnecting",
      lastSeen: "2026-05-26T09:58:00.000Z",
    },
  ],
};

// SNAPSHOT_TWO is what a subscribe-triggered re-read returns — an extra member
// joined and one flipped to `idle`. The re-read test asserts the roster reflects
// THIS snapshot after the captured handler fires.
export const SNAPSHOT_TWO: PresenceReadResponse = {
  participants: [
    {
      participantId: PARTICIPANT_ONLINE,
      state: "idle",
      lastSeen: "2026-05-26T10:05:00.000Z",
    },
    {
      participantId: PARTICIPANT_NEW_ON_REREAD,
      state: "online",
      lastSeen: "2026-05-26T10:05:30.000Z",
    },
  ],
};

// The roster SECOND_SESSION_ID returns — a disjoint membership, so the
// session-switch test can assert the prior session's members are gone and this
// one's member is present.
export const SECOND_SESSION_SNAPSHOT: PresenceReadResponse = {
  participants: [
    {
      participantId: PARTICIPANT_SECOND_SESSION,
      state: "online",
      lastSeen: "2026-05-26T11:00:00.000Z",
    },
  ],
};

// A manually-resolvable promise — lets a test hold two `presence.read` calls in
// flight and resolve them in a CHOSEN order (older last) to exercise the
// out-of-order guard. `resolve` is assigned synchronously inside the executor,
// so it is always defined by the time the test calls it.
export function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

export function installMockBridge(
  call: ReturnType<typeof vi.fn>,
  subscribe: ReturnType<typeof vi.fn>,
): void {
  // ParticipantRoster reads `window.sidekicks.daemon.call` (presence.read) AND
  // `window.sidekicks.daemon.subscribe` (presence.subscribe) — both methods are
  // required on the mock. Mocking the other five capability groups would be
  // unnecessary scaffolding; we cast through `unknown` because the partial shape
  // is not structurally assignable to the full `SidekicksBridge`.
  const bridge: { daemon: { call: typeof call; subscribe: typeof subscribe } } = {
    daemon: { call, subscribe },
  };
  (window as unknown as { sidekicks: SidekicksBridge }).sidekicks =
    bridge as unknown as SidekicksBridge;
}

// A no-op `Unsubscribe` for cases that do not assert on cleanup. The unmount case in
// `participant-roster.test.tsx` uses a dedicated `vi.fn()` spy instead.
export const noopUnsubscribe: Unsubscribe = () => {};

/** Remove the mock bridge a case installed. Every suite's `afterEach` runs this. */
export function removeMockBridge(): void {
  delete (window as unknown as { sidekicks?: SidekicksBridge }).sidekicks;
}
