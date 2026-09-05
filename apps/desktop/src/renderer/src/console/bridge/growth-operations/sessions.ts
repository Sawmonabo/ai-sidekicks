// The session and shell plane's ledger rows: a session's own lifecycle and search,
// the daemon's status and control, onboarding, the shell's settings, the invite
// list, the health stream, and the provider-session import.
//
// One plane of `GROWTH_OPERATIONS`, composed into it by `index.ts`.

import type { GrowthOperationEntry, GrowthOperationId } from "../growth-entry.js";
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
  | `shellConfig${string}`
  | `providerSessionImport${string}`
  | "invitesList"
  | "healthSubscribe"
>;

/** The session and shell rows, in the order the single table carried them. */
export const SESSION_GROWTH_OPERATIONS: Readonly<Record<SessionOperationId, GrowthOperationEntry>> =
  {
    sessionRename: op("sessionRename", "session-lifecycle-verbs", "method", "rename a session"),
    sessionArchive: op("sessionArchive", "session-lifecycle-verbs", "method", "archive a session"),
    sessionClose: op("sessionClose", "session-lifecycle-verbs", "method", "close a session"),
    sessionReactivate: op(
      "sessionReactivate",
      "session-lifecycle-verbs",
      "method",
      "reactivate an archived session",
    ),
    sessionRead: op(
      "sessionRead",
      "session-directory-read",
      "method",
      "read one session's snapshot, so its store can reach a base state and project the stream bound to it",
      "session.read",
    ),
    sessionList: op(
      "sessionList",
      "session-directory-read",
      "method",
      "list the sessions on this node, so a surface can offer more than the set this window happens to have open",
    ),
    daemonStatusRead: op(
      "daemonStatusRead",
      "daemon-control-methods",
      "method",
      "read the daemon's status for the settings daemon page",
      "DaemonStatusRead",
    ),
    daemonStop: op(
      "daemonStop",
      "daemon-control-methods",
      "method",
      "stop the daemon",
      "DaemonStop",
    ),
    daemonRestart: op(
      "daemonRestart",
      "daemon-control-methods",
      "method",
      "restart the daemon",
      "DaemonRestart",
    ),
    onboardingStateRead: op(
      "onboardingStateRead",
      "onboarding-methods",
      "method",
      "read first-run progress",
    ),
    onboardingStepAdvance: op(
      "onboardingStepAdvance",
      "onboarding-methods",
      "method",
      "record a completed first-run step",
    ),
    onboardingStepSkip: op(
      "onboardingStepSkip",
      "onboarding-methods",
      "method",
      "record a skipped first-run step",
    ),
    onboardingComplete: op(
      "onboardingComplete",
      "onboarding-methods",
      "method",
      "finish first-run setup",
    ),
    onboardingProviderSignInHandoff: op(
      "onboardingProviderSignInHandoff",
      "onboarding-methods",
      "method",
      "hand the participant off to a provider's own sign-in flow",
    ),
    shellConfigRead: op(
      "shellConfigRead",
      "shell-config-preferences",
      "method",
      "read the shell-level preferences",
    ),
    shellConfigWrite: op(
      "shellConfigWrite",
      "shell-config-preferences",
      "method",
      "set one shell-level preference",
    ),
    invitesList: op(
      "invitesList",
      "invites-list",
      "method",
      "list pending invites",
      "invites.list",
    ),
    healthSubscribe: op(
      "healthSubscribe",
      "health-subscribe",
      "subscription",
      "node health for the strip and the park banner",
      "health.subscribe",
    ),
    sessionSearch: op(
      "sessionSearch",
      "session-search",
      "method",
      "search sessions from the palette and the all-sessions list",
    ),
    providerSessionImportBegin: op(
      "providerSessionImportBegin",
      "provider-session-import",
      "method",
      "start importing an existing provider session's history",
    ),
    providerSessionImportSubscribe: op(
      "providerSessionImportSubscribe",
      "provider-session-import",
      "subscription",
      "progress for a running provider-session import",
    ),
  };
