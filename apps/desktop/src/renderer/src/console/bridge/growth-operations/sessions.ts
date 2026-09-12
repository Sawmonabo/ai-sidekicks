// The session and shell plane's ledger rows: a session's own lifecycle and search,
// the daemon's status and control, onboarding, the shell's settings, the health
// stream, and the provider-session import.
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
