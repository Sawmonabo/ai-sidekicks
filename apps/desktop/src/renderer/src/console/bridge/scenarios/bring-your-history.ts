// The bring-your-history scenario: a person arriving with work that already exists.
//
// The console's other scenarios all start from nothing or from a session already
// running. This one is the third opening the sessions surface has to draw and the one
// no script reached: a participant who has a provider CLI transcript on disk, or an
// identifier for a session somebody else is already in, and wants the console to pick
// up from there rather than from an empty composer.
//
// WHY IT SCRIPTS REFUSALS AS WELL AS ANSWERS. Three surfaces read from here — the
// join control, the import entry, and the notification centre — and each of them has
// an arm that only a refusal reaches: a session identifier that resolves to nothing,
// a provider this node cannot read a transcript for, and a machine that will not
// display an OS notification at all. A scenario that answered every call would leave
// all three of those renderings unreachable in the fixture, which is where they are
// looked at.
//
// NO SCRIPTED LATENCY ANYWHERE. The engine parks a delayed reply until the frozen
// clock reaches the tick it was made at plus that many milliseconds, and this script
// runs one beat at tick zero — so a latency here would be parked and never released,
// and every surface awaiting it would render its loading state for the life of the
// window. The in-flight arm of both acts is reachable in
// `sessions/acts/act-settlement.test.ts`, which holds an attempt open directly.
//
// THE THREE GROWTH KEYS. `growth:<operationId>` is the reply key a growth row with no
// registered wire method takes; `wire-truth/reply-walk.ts` states that rule and
// rejects a method-shaped key for such a row, because a method string nobody
// registered is an invented wire. `session.join` is keyed by its own method name for
// the opposite reason: the corpus registers it and the console binds it.

import type { ConsoleScenario } from "../scenario-runtime/index.js";
import type { GrowthImportProgress } from "../growth-values/index.js";
import type { GrowthStream } from "../growth-port/growth-outcome.js";
import type { WireErrorEnvelope } from "../../core/index.js";

export const BRING_YOUR_HISTORY_SCENARIO_ID = "bring-your-history";

const SESSION_ID = "019b78c9-0a80-7b31-9c40-4f0a0b6d1100";
const PARTICIPANT_YOU = "019b78c9-0a80-7b31-9c40-4f0a0b6d1101";
const MEMBERSHIP_YOU = "019b78c9-0a80-7b31-9c40-4f0a0b6d1102";

/** The reply key the shell's notification-permission reading is scripted under. */
export const SHELL_NOTIFICATION_PERMISSION_CALL = "growth:shellNotificationPermissionRead";

/** The reply key the import's opening call is scripted under. */
export const PROVIDER_SESSION_IMPORT_BEGIN_CALL = "growth:providerSessionImportBegin";

/** The reply key the import's progress subscription is scripted under. */
export const PROVIDER_SESSION_IMPORT_SUBSCRIBE_CALL = "growth:providerSessionImportSubscribe";

/** The one provider this script holds a readable transcript for. */
const IMPORTABLE_PROVIDER_NAME = "claude";

/** The import this script answers `providerSessionImportBegin` with. */
const IMPORT_ID = "019b78c9-0a80-7b31-9c40-4f0a0b6d1103";

/**
 * What the import reports as it runs: two readings in flight, then its terminal.
 *
 * A frozen list rather than a generator held in module scope, because a scenario is
 * replayed tick-for-tick and a consumed iterable would answer the second run with
 * nothing. {@link importProgressStream} builds a fresh walk over it per call.
 */
const IMPORT_PROGRESS_FRAMES: readonly GrowthImportProgress[] = [
  { importId: IMPORT_ID, turnsSeen: 0, state: "reading" },
  { importId: IMPORT_ID, turnsSeen: 34, state: "reading" },
  { importId: IMPORT_ID, turnsSeen: 61, state: "complete" },
];

/**
 * One fresh drain over the frames above, with the close every subscriber owes.
 *
 * The stream is built PER CALL rather than held, so two subscriptions in one scenario
 * — a second window, or a surface that remounted — each see the whole import rather
 * than sharing one half-drained iterator. `close()` stops the walk at the frame it
 * has reached; a caller that unmounts mid-import leaves nothing running.
 */
function importProgressStream(): GrowthStream<GrowthImportProgress> {
  let isClosed = false;
  return {
    events: {
      async *[Symbol.asyncIterator]() {
        for (const frame of IMPORT_PROGRESS_FRAMES) {
          if (isClosed) {
            return;
          }
          yield frame;
        }
      },
    },
    close() {
      isClosed = true;
    },
  };
}

/** Read one member off an unknown request, or `undefined` where it carries none. */
function requestMember(request: unknown, member: string): string | undefined {
  if (typeof request !== "object" || request === null) {
    return undefined;
  }
  const value = (request as Record<string, unknown>)[member];
  return typeof value === "string" ? value : undefined;
}

/** The refusal a daemon sends for a session identifier that resolves to nothing. */
const SESSION_NOT_FOUND: WireErrorEnvelope = {
  code: "session.not_found",
  message: "No session on this node carries that identifier.",
};

/** The refusal a daemon sends for a provider whose transcripts it cannot read. */
const IMPORT_PROVIDER_UNSUPPORTED: WireErrorEnvelope = {
  code: "session.import_provider_unsupported",
  message: "This node has no reader for that provider's transcripts.",
};

export const BRING_YOUR_HISTORY_SCENARIO: ConsoleScenario = {
  id: BRING_YOUR_HISTORY_SCENARIO_ID,
  label: "Bring your history",
  purpose:
    "A participant arriving with work that already exists — a session identifier to join and a provider transcript to import — with the refusing arm of each and a machine that will not show OS notifications.",
  sessionId: SESSION_ID,
  participantIdsInJoinOrder: [PARTICIPANT_YOU],
  viewingParticipantId: PARTICIPANT_YOU,
  membershipRoleByParticipantId: { [PARTICIPANT_YOU]: "owner" },
  startedAtIso: "2026-01-01T09:00:00.000Z",
  beats: [
    {
      atMs: 0,
      event: {
        id: "019b78c9-0a80-7b31-9c40-4f0a0b6d1201",
        sessionId: SESSION_ID,
        sequence: 1,
        kind: "session.created",
        occurredAt: "2026-01-01T09:00:00.000Z",
        actorId: PARTICIPANT_YOU,
        payload: { sessionId: SESSION_ID, config: {}, metadata: {} },
      },
    },
  ],
  replies: [
    {
      call: "session.read",
      result: {
        session: {
          id: SESSION_ID,
          state: "active",
          config: {},
          metadata: {},
          createdAt: "2026-01-01T09:00:00.000Z",
          updatedAt: "2026-01-01T09:00:00.000Z",
        },
        timelineCursors: { latest: "bring-your-history-cursor-1" },
      },
    },
    { call: "agent.list", result: { agents: [] } },
    // The machine will not show notifications, which is the arm the notification
    // centre's only-surface line exists for. `granted` renders nothing extra, so a
    // script answering it would leave that line unreachable here.
    { call: SHELL_NOTIFICATION_PERMISSION_CALL, result: { state: "denied" } },
    {
      // Both arms of the join. The session this scenario plays is joinable; every
      // other identifier refuses as the daemon refuses, which is what the form's
      // refusal rendering is measured against.
      call: "session.join",
      resultFor: (request) => {
        if (requestMember(request, "sessionId") !== SESSION_ID) {
          throw SESSION_NOT_FOUND;
        }
        return {
          sessionId: SESSION_ID,
          participantId: PARTICIPANT_YOU,
          membershipId: MEMBERSHIP_YOU,
          sharedMetadata: {},
        };
      },
    },
    {
      // The import's opening call, and its refusing arm: a provider this node holds
      // no reader for never reaches a progress subscription at all.
      call: PROVIDER_SESSION_IMPORT_BEGIN_CALL,
      resultFor: (request) => {
        if (requestMember(request, "providerName") !== IMPORTABLE_PROVIDER_NAME) {
          throw IMPORT_PROVIDER_UNSUPPORTED;
        }
        return { importId: IMPORT_ID };
      },
    },
    {
      // The progress subscription. Answered only for the import the call above
      // minted: a subscription to an import nobody began is a subject that does not
      // exist, and answering it would report progress on nothing.
      call: PROVIDER_SESSION_IMPORT_SUBSCRIBE_CALL,
      resultFor: (request) =>
        requestMember(request, "importId") === IMPORT_ID ? importProgressStream() : undefined,
    },
  ],
};
