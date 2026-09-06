// Signing in, and setting this node up: the two surfaces a person meets before work.
//
// WHAT THIS SCENARIO IS FOR. Sign-in and the first-run walkthrough are the only two
// console surfaces that are neither a rail destination nor a pane, so neither is
// reachable from any other scenario's screen — they are opened from the command
// palette, and a scenario that did not script their hosts would render both as a
// build with no ceremony and no onboarding wire. That is an honest rendering and it
// is not a demonstration of anything.
//
// THE CEREMONY IS SCRIPTED AS A SEQUENCE, which is what makes the fallback path
// reachable to its finish: the first assertion reports a host with no PRF and hands
// over a verification address and code, and the second — the one the browser
// hand-off waits on — settles the grant. The keystore is scripted unavailable on
// that settlement, so the memory-only consequence renders at the moment a person can
// still decide differently, which is the only moment it is worth rendering.
//
// ENROLMENT IS SCRIPTED AS A REFUSAL, and deliberately so: a participant dismissing
// the platform dialog has answered the question, and the answer is no. It is the one
// arm that must never fall through to the browser, so it is the one worth pinning.
//
// THE WALKTHROUGH OPENS PART-DONE. The relay step is already recorded, so the rail
// shows a mixed state rather than three identical entries, and the telemetry and
// provider steps are where a person still has something to do. One provider is ready
// and one is signed out, which is what makes the completion summary say something —
// a summary over an all-ready node states nothing a person did not already know.

import type { ConsoleScenario } from "../scenario-runtime/index.js";

export const ONBOARDING_SCENARIO_ID = "onboarding";

const SESSION_ID = "019b78c9-0a80-75e5-8510-ada11a5a3301";
const PARTICIPANT_YOU = "019b78c9-0a80-79a4-8110-cca0117a3301";
const CODEX_ACCOUNT_ID = "019b78c9-0a80-7c31-8110-cca0117a3302";
const CLAUDE_ACCOUNT_ID = "019b78c9-0a80-7c31-8110-cca0117a3303";

export const ONBOARDING_SCENARIO: ConsoleScenario = {
  id: ONBOARDING_SCENARIO_ID,
  label: "Signing in and setting up",
  purpose:
    "The two surfaces a person meets before any work: the passkey ceremony falling back to a browser hand-off that finishes memory-only, and the first-run walkthrough part-done with one provider ready and one signed out.",
  sessionId: SESSION_ID,
  participantIdsInJoinOrder: [PARTICIPANT_YOU],
  viewingParticipantId: PARTICIPANT_YOU,
  membershipRoleByParticipantId: { [PARTICIPANT_YOU]: "owner" },
  signInCeremony: {
    assertions: [
      {
        kind: "fallback-required",
        probeResult: "no-prf",
        handoff: {
          verificationUri: "http://127.0.0.1:8419/callback",
          userCode: "JQPD-4KTM",
        },
      },
      { kind: "authenticated", custody: "memory-only" },
    ],
    registration: { kind: "refused", reason: "cancelled" },
  },
  startedAtIso: "2026-01-01T09:00:00.000Z",
  beats: [
    {
      atMs: 0,
      event: {
        id: "019b78c9-0a80-7ea1-8110-e5e0d1153301",
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
        timelineCursors: { latest: "onboarding-cursor-1" },
      },
    },
    { call: "agent.list", result: { agents: [] } },
    {
      // The readiness projection, which is a REQUIRED member of this reply and
      // carries exactly one entry per selected provider. `claude` is ready and
      // carries no remedy — the one arm that gets none, because nothing is owed —
      // and `codex` is signed out and carries the sign-in remedy the daemon composed.
      call: "providerAccount.list",
      result: {
        accounts: [
          {
            accountId: CLAUDE_ACCOUNT_ID,
            provider: "claude",
            displayLabel: "Work subscription",
            credentialGeneration: 3,
            billingMode: "subscription",
            isDefault: true,
            healthState: "authenticated",
            healthObservedAt: "2026-01-01T08:55:00.000Z",
            observedAuthMode: "oauth_subscription",
            loggedInAt: "2025-12-02T10:00:00.000Z",
            expectedReloginAtEstimate: null,
            probeEnabled: true,
          },
          {
            accountId: CODEX_ACCOUNT_ID,
            provider: "codex",
            displayLabel: "Personal",
            credentialGeneration: 1,
            billingMode: "metered",
            isDefault: true,
            healthState: "reauth_required",
            healthObservedAt: "2026-01-01T08:40:00.000Z",
            observedAuthMode: "oauth_token",
            loggedInAt: "2025-11-01T10:00:00.000Z",
            expectedReloginAtEstimate: null,
            probeEnabled: true,
          },
        ],
        usageWindows: [],
        readiness: [
          {
            provider: "claude",
            state: "authenticated",
            resolvedAccountId: CLAUDE_ACCOUNT_ID,
            observedAt: "2026-01-01T08:55:00.000Z",
          },
          {
            provider: "codex",
            state: "reauth_required",
            resolvedAccountId: CODEX_ACCOUNT_ID,
            observedAt: "2026-01-01T08:40:00.000Z",
            remedy: {
              kind: "sign_in",
              accountId: CODEX_ACCOUNT_ID,
              signInInvocation: "codex login",
              credentialHomePath: "/Users/you/Library/Application Support/sidekicks/codex/personal",
            },
          },
        ],
      },
    },
    {
      // A deliberate re-check, and the one this scenario can answer: the probe takes
      // an account id, so the control is offered only where readiness resolved one.
      call: "providerAccount.probe",
      result: {
        accountId: CODEX_ACCOUNT_ID,
        healthState: "reauth_required",
        credentialGeneration: 1,
      },
    },
    {
      // Part-done: the relay choice is recorded and the rest is not, which is what a
      // resumed walkthrough looks like and what the rail exists to show.
      call: "growth:onboardingStateRead",
      result: { completedStepIds: ["relay"], isComplete: false },
    },
    {
      call: "growth:onboardingPresentChoice",
      result: {
        relayMethodId: "self-host",
        relayUrl: "https://relay.internal.example/",
        credentialHandle: "keystore:relay-join-token",
      },
    },
    { call: "growth:onboardingTelemetryPrompt", result: { enabled: false } },
    { call: "growth:onboardingStepAdvance", result: null },
    { call: "growth:onboardingStepSkip", result: null },
    { call: "growth:onboardingComplete", result: null },
    { call: "growth:onboardingProviderSignInHandoff", result: null },
  ],
};
