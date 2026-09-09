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

import type { NegotiationIncompatibleReason } from "@ai-sidekicks/contracts";

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
  // The snapshot read, and the position the caller wants the stream picked up from.
  //
  // `fromCursor` IS OPTIONAL AND ITS ABSENCE IS A MEANING rather than a default: it
  // says the caller has no acknowledged position and the beginning of the window is
  // where the read starts. A required member would have to be filled with a sentinel
  // for the ordinary first read of every session, and a sentinel is a position the
  // daemon then has to be told to ignore.
  //
  // IT IS ON THE REQUEST BECAUSE NO REGISTERED REQUEST CARRIES IT. `SessionReadRequest`
  // is `.strict()` over `sessionId` alone and `SessionSubscribeRequest.afterCursor` is
  // the only cursor a registered request has, so the resume position this console
  // decides has no wire to travel on — which is the growth-slate row's own claim, and
  // this is where the console states the shape it is asking for.
  sessionRead: {
    request: { readonly sessionId: string; readonly fromCursor?: string };
    value: SessionSnapshot;
  };
  sessionList: { request: Record<string, never>; value: readonly GrowthSessionSummary[] };
  sessionIdentityRead: { request: { readonly sessionId: string }; value: GrowthSessionSummary };
  daemonStatusRead: {
    request: Record<string, never>;
    value: { readonly state: string; readonly version: string };
  };
  daemonStop: { request: Record<string, never>; value: void };
  daemonRestart: { request: Record<string, never>; value: void };
  // The handshake's reply, projected for a window.
  //
  // MEMBER BY MEMBER, EACH ON THE OUTCOMES THAT CARRY IT — because `DaemonHelloAck`
  // populates a different subset on each of the four outcomes the daemon can reach,
  // and a projection that required all of them would be requiring, on three of those
  // four, a member the wire does not send:
  //
  //   • `compatible` and the negotiated version, on every outcome.
  //   • `reason`, on the three refusals and on no agreement.
  //   • `daemonSupportedProtocols`, on the two refusals that name a version out of
  //     range. `protocol.handshake_already_completed` omits it deliberately — the
  //     first handshake's ack already carried the set — and the AGREEING arm carries
  //     it on no outcome at all, which is why the member appears only below the
  //     refused arm and is optional even there.
  //
  //   • The console's own proposed version comes from the `DaemonHello` the shell
  //     sent, and it is here because a banner that names one side of a disagreement
  //     names neither.
  //
  // `reason` IS THE CONTRACT'S OWN CLOSED UNION rather than a `string`, so the remedy
  // mapping a surface writes over it is total by the compiler rather than by a default
  // arm — and a fourth reason registered on the wire fails at the mapping instead of
  // rendering as the console's guess.
  //
  // AND IT IS A DISCRIMINATED UNION rather than a boolean beside an optional reason,
  // which is what keeps the renderer from ever computing compatibility: a surface
  // narrows on the wire's own `compatible` and finds the reason already there. The ack
  // types `reason` as optional; this projection requires it on the refused arm, because
  // the console's refusal grammar renders a CODE and a refusal that names none cannot
  // be drawn — so a reasonless refusal is a fault the seam reports rather than a state
  // a window has to invent copy for.
  //
  // THE DAEMON'S BUILD VERSION IS DELIBERATELY ABSENT. `DaemonHelloAck` carries none:
  // the runtime's build rides `daemonStatusRead` on the `daemon-control-methods` row
  // beside this one, and folding two wires into one reply would leave the version
  // banner making a claim no single answer supports.
  daemonNegotiationRead: {
    request: Record<string, never>;
    value:
      | {
          readonly compatible: true;
          readonly consoleProtocolVersion: string;
          readonly daemonProtocolVersion: string;
        }
      | {
          readonly compatible: false;
          readonly reason: NegotiationIncompatibleReason;
          readonly consoleProtocolVersion: string;
          readonly daemonProtocolVersion: string;
          readonly daemonSupportedProtocols?: readonly string[];
        };
  };
  daemonStart: { request: Record<string, never>; value: void };
  onboardingStateRead: {
    request: Record<string, never>;
    value: { readonly completedStepIds: readonly string[]; readonly isComplete: boolean };
  };
  onboardingStepAdvance: { request: { readonly stepId: string }; value: void };
  onboardingStepSkip: { request: { readonly stepId: string }; value: void };
  onboardingComplete: { request: Record<string, never>; value: void };
  // NO SIGN-IN OPERATION, DELIBERATELY. `Spec-029 §Brokered interactive sign-in` puts
  // the brokered login on the provider-management surface and its CLI parity verb, and
  // says in the same breath that it "does not rewire" the first-run step: that step's
  // `providerAccount.*` calls exclude `providerAccount.login` and `loginCancel`, so
  // onboarding never depends on a brokered process the operator did not ask for. What
  // the provider step has instead is the remedy the readiness entry already carries —
  // which provider, which account, the invocation, the credential home — displayed, and
  // the probe that decides whether it worked.

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
  // declared beside it, because the console already has one: `store/shell/shell-state.ts`
  // owns the vocabulary every reader of this feed narrows on, and a second
  // declaration here would be the same closed set written twice — the case the
  // `growth-values/` door names as belonging to the module that already declares it.
  shellStatusSubscribe: { request: Record<string, never>; value: GrowthStream<ShellReport> };
}
