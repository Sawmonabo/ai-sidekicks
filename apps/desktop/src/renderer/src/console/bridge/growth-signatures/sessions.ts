// The session and shell plane: the session's own lifecycle, and the shell surfaces
// that surround one.
//
// One plane of `GrowthOperationSignatures`, composed into it by `index.ts`. A
// session is renamed, archived, closed, reactivated, read, listed, searched, and
// given or cleared a goal here; beside it sit the surfaces a window has whether or
// not a session is open —
// the daemon's own status and control, onboarding, the shell's boolean settings,
// the invite list, the health stream, and the provider-session import a new session
// can be seeded from.

import type { GrowthStream } from "../growth-port/growth-outcome.js";
import type {
  GrowthHealthReading,
  GrowthImportProgress,
  GrowthInviteSummary,
  GrowthSessionSummary,
} from "../growth-values/index.js";
import type { SessionSnapshot } from "../../store/index.js";

export interface SessionGrowthSignatures {
  sessionRename: { request: { readonly sessionId: string; readonly title: string }; value: void };
  sessionArchive: { request: { readonly sessionId: string }; value: void };
  sessionClose: { request: { readonly sessionId: string }; value: void };
  sessionReactivate: { request: { readonly sessionId: string }; value: void };
  sessionRead: { request: { readonly sessionId: string }; value: SessionSnapshot };
  sessionList: { request: Record<string, never>; value: readonly GrowthSessionSummary[] };
  daemonStatusRead: {
    request: Record<string, never>;
    value: { readonly state: string; readonly version: string };
  };
  daemonStop: { request: Record<string, never>; value: void };
  daemonRestart: { request: Record<string, never>; value: void };
  onboardingStateRead: {
    request: Record<string, never>;
    value: { readonly completedStepIds: readonly string[]; readonly isComplete: boolean };
  };
  onboardingStepAdvance: { request: { readonly stepId: string }; value: void };
  onboardingStepSkip: { request: { readonly stepId: string }; value: void };
  onboardingComplete: { request: Record<string, never>; value: void };
  onboardingProviderSignInHandoff: { request: { readonly providerName: string }; value: void };
  // The two bridge methods, whose values are what a MAIN-PROCESS dialog answered.
  // `credentialHandle` is an opaque reference and never a secret: `Spec-026
  // §Pitfalls To Avoid` records that rendering the admin-token field in the renderer
  // has already leaked it once, so the token is typed into main's own window and the
  // renderer is handed something that only names it.
  //
  // `relayMethodId` travels as a bare `string` deliberately. The three normative
  // identifiers are `Spec-026 §Three-Way Choice Semantics`', and the console narrows
  // against its own copy of them fail-closed at the step — an id this build does not
  // recognise renders as the unrecognised row rather than as one of the three.
  onboardingPresentChoice: {
    request: Record<string, never>;
    value: { readonly relayMethodId: string; readonly credentialHandle: string | undefined };
  };
  onboardingTelemetryPrompt: {
    request: Record<string, never>;
    value: { readonly enabled: boolean };
  };
  shellConfigRead: { request: Record<string, never>; value: Readonly<Record<string, boolean>> };
  shellConfigWrite: { request: { readonly key: string; readonly enabled: boolean }; value: void };
  invitesList: { request: { readonly sessionId: string }; value: readonly GrowthInviteSummary[] };
  healthSubscribe: { request: Record<string, never>; value: GrowthStream<GrowthHealthReading> };
  sessionSearch: { request: { readonly query: string }; value: readonly GrowthSessionSummary[] };
  // session goals — two operations and never one. `session.goalUpdate` sets and
  // `session.goalClear` clears; an update carrying no goal is malformed rather than
  // a clear, which is why the request below has no optional goal member. Neither
  // answers with anything the card reads: the goal is a PROJECTION of the event log,
  // so what a caller waits for is the `session.goal_updated` beat and not a reply.
  sessionGoalUpdate: {
    request: { readonly sessionId: string; readonly goal: { readonly text: string } };
    value: undefined;
  };
  sessionGoalClear: {
    request: { readonly sessionId: string };
    value: undefined;
  };
  providerSessionImportBegin: {
    request: { readonly providerName: string; readonly sourceRef: string };
    value: { readonly importId: string };
  };
  providerSessionImportSubscribe: {
    request: { readonly importId: string };
    value: GrowthStream<GrowthImportProgress>;
  };
}
