// The session and shell plane's ledger rows: a session's own lifecycle and search,
// the daemon's status and control, onboarding, the shell's settings, the invite
// list, the health stream, and the provider-session import.
//
// One plane of `GROWTH_OPERATIONS`, composed into it by `index.ts`.

import type { GrowthOperationEntry, GrowthOperationId } from "../growth-port/growth-entry.js";
import { op } from "./operation-entry.js";

/**
 * The ids this plane carries, DERIVED from the id union rather than listed again.
 *
 * `Extract` against the plane's own name pattern is what makes the annotation below
 * exhaustive in both directions: a row this plane owns and forgot fails here, and a
 * key that is not an operation id fails here too. A hand-written list would be a
 * second copy of the id set — the thing `growth-entry.ts` exists to prevent.
 */
type SessionOperationId = Extract<
  GrowthOperationId,
  | `session${string}`
  | `daemon${string}`
  | `onboarding${string}`
  | `shell${string}`
  | `providerSessionImport${string}`
  | "invitesList"
  | "healthSubscribe"
>;

/** The session and shell rows, in the order the single table carried them. */
export const SESSION_GROWTH_OPERATIONS: Readonly<Record<SessionOperationId, GrowthOperationEntry>> =
  {
    sessionRename: op("sessionRename", "session-lifecycle-verbs", "method"),
    sessionArchive: op("sessionArchive", "session-lifecycle-verbs", "method"),
    sessionClose: op("sessionClose", "session-lifecycle-verbs", "method"),
    sessionReactivate: op("sessionReactivate", "session-lifecycle-verbs", "method"),
    sessionRead: op("sessionRead", "session-directory-read", "method", "session.read"),
    // The identity a session header renders. A read of its own rather than a member on
    // `sessionRead`, because that operation answers with the console's STORE-shaped
    // snapshot: a base state for a projection, which carries a cursor and a roster and
    // deliberately no display title and no session state. Widening it would make every
    // store initialisation carry two unrelated jobs.
    sessionIdentityRead: op(
      "sessionIdentityRead",
      "session-directory-read",
      "method",
      "session.read",
    ),
    sessionList: op("sessionList", "session-directory-read", "method"),
    daemonStatusRead: op(
      "daemonStatusRead",
      "daemon-control-methods",
      "method",
      "DaemonStatusRead",
    ),
    daemonStop: op("daemonStop", "daemon-control-methods", "method", "DaemonStop"),
    daemonRestart: op("daemonRestart", "daemon-control-methods", "method", "DaemonRestart"),
    // A READ of the ack the shell already holds, and deliberately not the handshake.
    // `daemon.hello` is registered and the daemon answers it, so naming it here would
    // have looked like the honest transcription the rows above make — but a window
    // that sent it would get `compatible: false` with reason
    // `protocol.handshake_already_completed` and no supported set, because the daemon
    // latches the first handshake per connection and refuses every later one. So this
    // row declares NO expected wire method: the seam it needs is a bridge read of a
    // reply the shell is holding, and no such read is registered anywhere. The fixture
    // keys it on the operation id under the `growth:` prefix accordingly.
    daemonNegotiationRead: op("daemonNegotiationRead", "daemon-version-negotiation", "method"),
    // The one act on this row that is NOT a call: a stopped daemon has no IPC
    // server to receive a start, so the shell spawns the process. It sits here
    // because the seam a surface reaches it through is the same one, and a second
    // seam for one operation would be the split this port exists to avoid.
    daemonStart: op("daemonStart", "daemon-control-methods", "method", "DaemonStart"),
    onboardingStateRead: op("onboardingStateRead", "onboarding-methods", "method"),
    onboardingStepAdvance: op("onboardingStepAdvance", "onboarding-methods", "method"),
    onboardingStepSkip: op("onboardingStepSkip", "onboarding-methods", "method"),
    onboardingComplete: op("onboardingComplete", "onboarding-methods", "method"),
    // NO SIXTH ONBOARDING OPERATION, and the absence is the contract rather than a
    // gap. `Spec-026 §Provider Authentication (Group B)` holds the five daemon methods
    // above "unchanged in name, count, and shape" and composes the provider step out of
    // the node-local `providerAccount.*` surface instead — and `Spec-029 §Brokered
    // interactive sign-in` excludes even that plane's own login verbs from this flow,
    // so onboarding stays a HANDOFF: the step displays the invocation the readiness
    // remedy already carries and starts nothing on the operator's behalf.
    // The two bridge methods `Spec-026 §Desktop Surface` names, on their own slate
    // row rather than folded into the five daemon methods above: those are a daemon
    // registration and these are a preload-bridge surface, and a row that bundled
    // them would name two owners for one wire. Neither carries an expected wire
    // method, because neither IS one — a bridge method crosses the preload boundary
    // and never the JSON-RPC wire.
    onboardingPresentChoice: op("onboardingPresentChoice", "onboarding-desktop-surface", "method"),
    onboardingTelemetryPrompt: op(
      "onboardingTelemetryPrompt",
      "onboarding-desktop-surface",
      "method",
    ),
    shellConfigRead: op("shellConfigRead", "shell-config-preferences", "method"),
    shellConfigWrite: op("shellConfigWrite", "shell-config-preferences", "method"),
    invitesList: op("invitesList", "invites-list", "method", "invites.list"),
    healthSubscribe: op("healthSubscribe", "health-subscribe", "subscription", "health.subscribe"),
    sessionSearch: op("sessionSearch", "session-search", "method"),
    // session goals — the owner/collaborator pair the goal card drives.
    sessionGoalUpdate: op(
      "sessionGoalUpdate",
      "session-goal-methods",
      "method",
      "session.goalUpdate",
    ),
    sessionGoalClear: op("sessionGoalClear", "session-goal-methods", "method", "session.goalClear"),
    providerSessionImportBegin: op(
      "providerSessionImportBegin",
      "provider-session-import",
      "method",
    ),
    providerSessionImportSubscribe: op(
      "providerSessionImportSubscribe",
      "provider-session-import",
      "subscription",
    ),
    shellNotificationPermissionRead: op(
      "shellNotificationPermissionRead",
      "notification-permission-read",
      "method",
    ),
    shellStatusSubscribe: op("shellStatusSubscribe", "shell-status-signals", "subscription"),
  };

/**
 * What each of this plane's operations is, in a sentence.
 *
 * A second declaration rather than a member of the row beside it — `index.ts` states
 * the rule, which is `growth-slate-consumers.ts`'s: the split is by CONSUMER, and no
 * running console reads a sentence. The `Record` is over this plane's own id set, so a
 * row with no sentence and a sentence under an unknown id are both compile errors.
 */
export const SESSION_GROWTH_OPERATION_SUMMARIES: Readonly<Record<SessionOperationId, string>> = {
  sessionRename: "rename a session",
  sessionArchive: "archive a session",
  sessionClose: "close a session",
  sessionReactivate: "reactivate an archived session",
  sessionRead:
    "read one session's snapshot, so its store can reach a base state and project the stream bound to it",
  sessionIdentityRead:
    "read one session's display title and its wire-verbatim state, so a header names the session rather than only its identifier",
  sessionList:
    "list the sessions on this node, so a surface can offer more than the set this window happens to have open",
  daemonStatusRead: "read the daemon's status for the settings daemon page",
  daemonStop: "stop the daemon",
  daemonRestart: "restart the daemon",
  daemonNegotiationRead:
    "read, through the bridge, the negotiated ack the shell holds — the protocol agreed with the local runtime, the versions that runtime supports, and the reason when the two do not meet",
  daemonStart: "start a stopped daemon, which is a shell spawn rather than a call",
  onboardingStateRead: "read first-run progress",
  onboardingStepAdvance: "record a completed first-run step",
  onboardingStepSkip: "record a skipped first-run step",
  onboardingComplete: "finish first-run setup",
  onboardingPresentChoice:
    "put the relay choice in front of the participant from the main process, so the self-host admin token is typed where the renderer cannot read it and only an opaque handle comes back",
  onboardingTelemetryPrompt:
    "put the telemetry question in front of the participant as its own step, after the relay choice resolves and never bundled into it",
  shellConfigRead: "read the shell-level preferences",
  shellConfigWrite: "set one shell-level preference",
  invitesList: "list pending invites",
  healthSubscribe: "node health for the strip and the park banner",
  sessionSearch: "search sessions from the palette and the all-sessions list",
  sessionGoalUpdate:
    "set the session's goal, which the daemon appends as `session.goal_updated` and every surface then reads off the log",
  sessionGoalClear:
    "clear the session's goal — the distinct operation, never an update carrying empty text",
  providerSessionImportBegin: "start importing an existing provider session's history",
  providerSessionImportSubscribe: "progress for a running provider-session import",
  shellNotificationPermissionRead:
    "whether this machine will display an OS notification, so the notification centre can say when it is the only surface and the notifications page can say what the machine has answered",
  shellStatusSubscribe:
    "the shell's own condition as one feed — the supervisor's step and attempt count, the handshake ack, the transport it reached the daemon over, and whether this host has a usable keystore",
};
