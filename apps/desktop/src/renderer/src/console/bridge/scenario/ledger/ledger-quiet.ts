// A session that has been opened and has done nothing.
//
// The opposite of `ledger.ts` next door, and it exists for the one case that one
// cannot show: rule 8's five kinds of nothing render differently, and EMPTY — a log
// with no rows — is the only one a scripted stream of events can never reach,
// because every beat it plays puts a row on screen. Without a scenario whose script
// is empty, the ledger's empty state is unreachable in the fixture picker at all,
// and an empty state nobody can look at is an empty state nobody designed.
//
// The roster is the load-bearing part, exactly as it is next door: participant hues
// are allocated by join-log order,
// so two people and one agent is the smallest roster that still shows a wrapped-hue
// treatment apart from a first-step one.
//
// ITS REPLIES ARE EVERY READ AN OPEN SESSION PERFORMS, AND NOT ONLY THE FRAME'S.
// `session.read` and `agent.list` are the frame's two — the registered method names,
// rather than a `session.list` the method registry does not carry — and the composer
// mounts with every open session and takes two more: the queue shelf's opening read
// and the account plane's registry read. A call this scenario does not answer is
// refused by name, and each surface renders that refusal where it happened, so a
// script short of one of them puts two refusal notices in the one capture that exists
// to show what an empty session looks like.

import type { ConsoleScenario } from "../runtime/index.js";

export const LEDGER_QUIET_SCENARIO_ID = "ledger-quiet";

const SESSION_ID = "019b793b-7b60-75e5-8520-ada11a5a45a5";
const PARTICIPANT_YOU = "019b793b-7b60-79a4-8130-cca0117a0440";
const PARTICIPANT_PRIYA = "019b793b-7b60-79a4-8140-cca0117a0450";
const AGENT_IMPLEMENTER = "019b793b-7b60-7a6e-8140-d1a4c1150104";
const STARTED_AT_ISO = "2026-01-01T09:00:00.000Z";

/**
 * The account that pays for the agent this session has attached.
 *
 * ONE ACCOUNT AND NOT TWO, because the roster is what says there is one at all: the
 * Implementer is attached on the `claude` driver, so a claude home is authenticated
 * on this node. Nothing in this session says anything about the other provider, and
 * the readiness entry below states exactly that rather than inventing a second
 * registration to keep the pair symmetrical.
 */
const PROVIDER_ACCOUNT_CLAUDE = "acct-ledger-quiet-claude";

export const LEDGER_QUIET_SCENARIO: ConsoleScenario = {
  id: LEDGER_QUIET_SCENARIO_ID,
  label: "Quiet session",
  purpose:
    "A session with a roster and nothing on the log yet. Reaches the ledger's empty state, which no scripted stream can.",
  sessionId: SESSION_ID,
  participantIdsInJoinOrder: [PARTICIPANT_YOU, PARTICIPANT_PRIYA, AGENT_IMPLEMENTER],
  // One person opened this session and nothing has happened in it, so which of the
  // roster this window is is not in doubt — which is why it is stated rather than
  // left for the caller-identity read to refuse.
  viewingParticipantId: PARTICIPANT_YOU,
  startedAtIso: STARTED_AT_ISO,
  beats: [],
  replies: [
    {
      call: "session.read",
      result: {
        session: {
          id: SESSION_ID,
          state: "active",
          config: {},
          metadata: {},
          createdAt: STARTED_AT_ISO,
          updatedAt: STARTED_AT_ISO,
        },
        timelineCursors: { latest: "ledger-quiet-cursor-0" },
      },
    },
    {
      call: "agent.list",
      result: {
        agents: [
          {
            agentId: AGENT_IMPLEMENTER,
            name: "Implementer",
            driverName: "claude",
            modelId: "claude-sonnet-5",
            config: {},
            state: "ready",
            createdAt: STARTED_AT_ISO,
          },
        ],
      },
    },
    {
      // The queue shelf's opening read. `QueueItemListResponse` is `{ items }` parsed
      // `.strict()`, and the empty list is the SERVED answer rather than an absence:
      // nothing is waiting, because nothing has been sent in this session at all.
      call: "run.queueList",
      result: { items: [] },
    },
    {
      // The account plane's registry read, which seeds the composer's quota chips.
      //
      // NO USAGE WINDOW, AND THAT IS THE SCENARIO'S OWN SUBJECT rather than a gap in
      // the script: a window is observed from a probe or from real traffic, and this
      // session has had neither, so a node with an authenticated account and nothing
      // metered against it is exactly what an untouched session looks like. The chips
      // are drawn from these rows, so there are none — which is a served reading and
      // not the refusal an unscripted call would have rendered in their place.
      //
      // `readiness` is a REQUIRED member carrying one entry per provider, so the
      // provider with no registration here says so: `no_account` resolves to no
      // account and therefore carries neither a resolved id nor an observation time,
      // and takes the `register` remedy its state calls for.
      call: "providerAccount.list",
      result: {
        accounts: [
          {
            accountId: PROVIDER_ACCOUNT_CLAUDE,
            provider: "claude",
            displayLabel: "Claude — work",
            credentialGeneration: 1,
            billingMode: "subscription",
            isDefault: true,
            healthState: "authenticated",
            healthObservedAt: STARTED_AT_ISO,
            observedAuthMode: "oauth_subscription",
            loggedInAt: STARTED_AT_ISO,
            expectedReloginAtEstimate: null,
            probeEnabled: true,
          },
        ],
        usageWindows: [],
        readiness: [
          {
            provider: "claude",
            state: "authenticated",
            resolvedAccountId: PROVIDER_ACCOUNT_CLAUDE,
            observedAt: STARTED_AT_ISO,
          },
          {
            provider: "codex",
            state: "no_account",
            remedy: { kind: "register", provider: "codex" },
          },
        ],
      },
    },
  ],
};
