// The session and shell plane: the session's own lifecycle, and the shell surfaces
// that surround one.
//
// One plane of `GrowthOperationSignatures`, composed into it by `index.ts`. A
// session is renamed, archived, closed, reactivated, read, listed, searched, and
// given or cleared a goal here; beside it sit the surfaces a window has whether or
// not a session is open —
// the daemon's own status and control, onboarding, the shell's boolean settings,
// the invite list, the health stream, the provider-session import a new session can
// be seeded from, and whether this machine will display an OS notification at all.

import type { ProviderAccountId } from "@ai-sidekicks/contracts";

import type { GrowthStream } from "../growth-port/growth-outcome.js";
import type {
  GrowthHealthReading,
  GrowthImportProgress,
  GrowthInviteSummary,
  GrowthNotificationPermission,
  GrowthSessionSummary,
} from "../growth-values/index.js";
import type { SessionSnapshot, ShellReport } from "../../store/index.js";

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
  daemonStart: { request: Record<string, never>; value: void };
  onboardingStateRead: {
    request: Record<string, never>;
    value: { readonly completedStepIds: readonly string[]; readonly isComplete: boolean };
  };
  onboardingStepAdvance: { request: { readonly stepId: string }; value: void };
  onboardingStepSkip: { request: { readonly stepId: string }; value: void };
  onboardingComplete: { request: Record<string, never>; value: void };
  onboardingProviderSignInHandoff: {
    request: {
      readonly providerName: string;
      /**
       * The account whose credential home this hand-off authenticates INTO.
       *
       * Present on exactly the arm that has one — the readiness `sign_in` remedy,
       * which the contract requires to name an account — and absent where resolution
       * reached none, whose remedy is a registry verb rather than a sign-in. A
       * provider holding more than one registered account holds more than one
       * credential home, so a request carrying only the provider name leaves the
       * surface behind it to elect one, and the election it can afford is the
       * default: a different account from the one whose remedy was on screen.
       *
       * Carried and never re-derived. The daemon composed the remedy this names, and
       * a client picking an account for itself is the arbitrary cross-account
       * election the readiness derivation exists to refuse.
       */
      readonly providerAccountId?: ProviderAccountId;
    };
    value: void;
  };
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
  //
  // `relayUrl` is on the reply because `Spec-026 §Desktop Surface` declares it there
  // and `Spec-026 §Persistence` records it as plaintext config rather than a secret —
  // and because Option 1's own required prompt is that the current published relay
  // address is displayed. Without it this console could describe the consequence of a
  // choice and never name the address it resolved to.
  onboardingPresentChoice: {
    request: Record<string, never>;
    value: {
      readonly relayMethodId: string;
      readonly relayUrl: string;
      readonly credentialHandle: string | undefined;
    };
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
  // The shell's notification-permission reading. A READ and never a request for
  // permission: asking for one is a prompt, which is an act on a person's machine
  // that a panel rendering its own absence has no business performing.
  shellNotificationPermissionRead: {
    request: Record<string, never>;
    value: GrowthNotificationPermission;
  };
  // The shell's own condition. The value is `ShellReport` rather than a shape
  // declared beside it, because the console already has one: `store/shell-state.ts`
  // owns the vocabulary every reader of this feed narrows on, and a second
  // declaration here would be the same closed set written twice — the case the
  // `growth-values/` door names as belonging to the module that already declares it.
  shellStatusSubscribe: { request: Record<string, never>; value: GrowthStream<ShellReport> };
}
