// The session and shell plane: the session's own lifecycle, and the shell surfaces
// that surround one.
//
// One plane of `GrowthOperationSignatures`, composed into it by `index.ts`. A
// session is renamed, archived, closed, reactivated, read, listed, and searched
// here; beside it sit the surfaces a window has whether or not a session is open —
// the daemon's own status and control, onboarding, the shell's boolean settings,
// the invite list, the health stream, and the provider-session import a new session
// can be seeded from.

import type { NegotiationIncompatibleReason } from "@ai-sidekicks/contracts";

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
  sessionIdentityRead: { request: { readonly sessionId: string }; value: GrowthSessionSummary };
  daemonStatusRead: {
    request: Record<string, never>;
    value: { readonly state: string; readonly version: string };
  };
  daemonStop: { request: Record<string, never>; value: void };
  daemonRestart: { request: Record<string, never>; value: void };
  // The handshake's reply, projected for a window.
  //
  // FOUR MEMBERS OF `DaemonHelloAck` AND ONE OF `DaemonHello`, and nothing else. The
  // ack answers the daemon's verdict, the version it chose, the set it supports, and —
  // on the refused arm — which of the three reasons refused it; the console's own
  // proposed version comes from the request the shell sent, and it is here because a
  // banner that names one side of a disagreement names neither.
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
  // beside this one, and folding two wires into one reply would leave the version mark
  // making a claim no single answer supports.
  daemonHello: {
    request: Record<string, never>;
    value:
      | {
          readonly compatible: true;
          readonly consoleProtocolVersion: string;
          readonly daemonProtocolVersion: string;
          readonly daemonSupportedProtocols: readonly string[];
        }
      | {
          readonly compatible: false;
          readonly reason: NegotiationIncompatibleReason;
          readonly consoleProtocolVersion: string;
          readonly daemonProtocolVersion: string;
          readonly daemonSupportedProtocols: readonly string[];
        };
  };
  onboardingStateRead: {
    request: Record<string, never>;
    value: { readonly completedStepIds: readonly string[]; readonly isComplete: boolean };
  };
  onboardingStepAdvance: { request: { readonly stepId: string }; value: void };
  onboardingStepSkip: { request: { readonly stepId: string }; value: void };
  onboardingComplete: { request: Record<string, never>; value: void };
  onboardingProviderSignInHandoff: { request: { readonly providerName: string }; value: void };
  shellConfigRead: { request: Record<string, never>; value: Readonly<Record<string, boolean>> };
  shellConfigWrite: { request: { readonly key: string; readonly enabled: boolean }; value: void };
  invitesList: { request: { readonly sessionId: string }; value: readonly GrowthInviteSummary[] };
  healthSubscribe: { request: Record<string, never>; value: GrowthStream<GrowthHealthReading> };
  // The one-shot read's reply, typed inline rather than as a named growth value: it
  // is this operation's own answer and nothing else names it, and the per-component
  // rows ARE `GrowthHealthReading`, which the stream beside it already publishes.
  healthStatusRead: {
    request: { readonly scope?: string };
    value: { readonly overall: string; readonly components: readonly GrowthHealthReading[] };
  };
  sessionSearch: { request: { readonly query: string }; value: readonly GrowthSessionSummary[] };
  providerSessionImportBegin: {
    request: { readonly providerName: string; readonly sourceRef: string };
    value: { readonly importId: string };
  };
  providerSessionImportSubscribe: {
    request: { readonly importId: string };
    value: GrowthStream<GrowthImportProgress>;
  };
}
