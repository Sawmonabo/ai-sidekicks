// What the MCP servers and Providers settings pages are answered with: the MCP page's replies
// (`mcp-server-replies.ts`) and the machine's provider-account registry, with the calls the
// Providers page's controls send. Both are the machine's, not a session's, so a scenario that plays
// a session spreads these into its own replies.
//
// The registry holds a Claude account the daemon observed signed in, with two limits on one window
// length; a pasted-token Claude account whose token stopped working, marked the default, so its
// readiness entry carries the paste-token remedy; and a Codex account whose folder holds no
// credential, whose entry carries the sign-in remedy.
//
// The Providers page's writes behave as the daemon's do: a sign-in the page started ends on its own
// a few seconds later, reported on `provider.account.subscribe` unless it was canceled first (the
// first one fails with the provider's reason, and every later one finishes), a checked account
// answers its current reading, the first pasted token is one the provider does not accept, a
// re-supplied token keeps the account it was pasted into and signs it back in, and the default
// moves to a signed-in account while one whose sign-in is gone is refused with its own remedy. The
// registry read reflects every answered write.

import type { DaemonStatusReadResponse } from "@ai-sidekicks/contracts/daemon/status";
import { CURRENT_PROTOCOL_VERSION } from "@ai-sidekicks/contracts/jsonrpc/negotiation";
import type {
  ProviderAccountNotification,
  ProviderAccount,
  ProviderAccountId,
  ProviderAccountListResponse,
  ProviderReadiness,
  ProviderSignInExpiredRemedy,
} from "@ai-sidekicks/contracts/provider/account/record";
import {
  PROVIDER_ACCOUNT_NOT_AUTHENTICATED_CODE,
  type ProviderAccountCurrentUpdateResponse,
  type ProviderAccountNotAuthenticatedDetails,
  type ProviderAccountProbeResponse,
} from "@ai-sidekicks/contracts/provider/account/methods";
import {
  PROVIDER_ACCOUNT_TOKEN_NOT_ACCEPTED_CODE,
  type ProviderAccountRegisterResponse,
  type ProviderAccountSignInAttemptCancelResponse,
  type ProviderAccountSignInResponse,
} from "@ai-sidekicks/contracts/provider/account/sign-in";
import type { ProviderId } from "@ai-sidekicks/contracts/provider/id";
import type {
  AnsweredRequests,
  ScenarioNotice,
  ScenarioRefusalEnvelope,
  ScenarioReply,
} from "#renderer/services/daemon/scenario/reply.fixture.js";
import { MCP_SERVER_REPLIES } from "./mcp-server-replies.js";
import { readMember } from "./requests.js";

const OBSERVED_AT = "2026-01-01T08:55:00.000Z";
const WORK_ACCOUNT_ID = "pa-0001" as ProviderAccountId;
const PERSONAL_ACCOUNT_ID = "pa-0002" as ProviderAccountId;
const TOKEN_ACCOUNT_ID = "pa-0003" as ProviderAccountId;
const CLAUDE = "claude" as ProviderId;
const CODEX = "codex" as ProviderId;

/**
 * An account the daemon observed and found signed in, not the default, so it can be made one. The
 * workflow runs pay with it, and a run waiting on a spent account waits on it.
 */
export const WORK_ACCOUNT: ProviderAccount = {
  accountId: WORK_ACCOUNT_ID,
  provider: CLAUDE,
  credentialGeneration: 3,
  billingMode: "subscription",
  observedAccountEmail: "sam@example.com",
  observedAccountPlan: "max",
  isDefault: false,
  healthState: "authenticated",
  healthObservedAt: OBSERVED_AT,
  observedAuthMode: "oauthSubscription",
  signedInAt: "2025-12-02T09:00:00.000Z",
  signInNeededAtEstimate: "2026-01-01T09:00:00.000Z",
  probeEnabled: true,
  lastRefreshObservedAt: null,
  windowStartEnabled: true,
  wakeForWindowStartEnabled: false,
  memoryImport: null,
};

/** An account whose credential home was absent when last observed. */
const PERSONAL_ACCOUNT: ProviderAccount = {
  accountId: PERSONAL_ACCOUNT_ID,
  provider: CODEX,
  credentialGeneration: 1,
  billingMode: "metered",
  observedAccountEmail: "sam@example.org",
  observedAccountPlan: "team",
  observedAccountOrgName: "Example Inc",
  isDefault: true,
  healthState: "homeMissing",
  healthObservedAt: OBSERVED_AT,
  observedAuthMode: null,
  signedInAt: null,
  signInNeededAtEstimate: null,
  probeEnabled: true,
  lastRefreshObservedAt: null,
  windowStartEnabled: true,
  wakeForWindowStartEnabled: false,
  memoryImport: null,
};

/** A pasted-token account whose token stopped working, the default for its provider. */
const TOKEN_ACCOUNT: ProviderAccount = {
  accountId: TOKEN_ACCOUNT_ID,
  provider: CLAUDE,
  displayLabel: "Personal",
  credentialGeneration: 1,
  billingMode: "metered",
  isDefault: true,
  healthState: "reauthRequired",
  healthObservedAt: OBSERVED_AT,
  observedAuthMode: "oauthToken",
  signedInAt: "2025-12-20T09:00:00.000Z",
  signInNeededAtEstimate: null,
  probeEnabled: true,
  lastRefreshObservedAt: null,
  windowStartEnabled: true,
  wakeForWindowStartEnabled: false,
  memoryImport: null,
};

/** Every account the registry starts with, before any write the playback answers. */
const SCRIPTED_ACCOUNTS: readonly ProviderAccount[] = [
  WORK_ACCOUNT,
  TOKEN_ACCOUNT,
  PERSONAL_ACCOUNT,
];

/** The providers a readiness entry is drawn for, one each, and an account registered under. */
const READINESS_PROVIDERS: readonly ProviderId[] = [CLAUDE, CODEX];

const USAGE_WINDOWS: ProviderAccountListResponse["usageWindows"] = [
  {
    accountId: WORK_ACCOUNT_ID,
    limitId: "weekly_all",
    label: "Weekly, all models",
    windowMins: 10080,
    usedPercent: 88,
    resetsAt: "2026-01-05T00:00:00.000Z",
    observedAt: OBSERVED_AT,
    observedCredentialGeneration: 3,
    source: "run",
  },
  {
    accountId: WORK_ACCOUNT_ID,
    limitId: "weekly_opus",
    label: "Weekly, Opus",
    windowMins: 10080,
    usedPercent: 40,
    resetsAt: "2026-01-05T00:00:00.000Z",
    observedAt: OBSERVED_AT,
    observedCredentialGeneration: 3,
    source: "run",
  },
];

const SIGN_IN_CANCELED: ProviderAccountSignInAttemptCancelResponse = { status: "canceled" };

/** How long a started sign-in takes to finish on its own, in scenario time. */
const SIGN_IN_FINISHES_AFTER_MS = 5000;

/** How long a sign-in code stays good, in scenario time, as a provider's device code does. */
const SIGN_IN_CODE_LIFETIME_MS = 15 * 60 * 1000;

/**
 * The service's status as the Providers page reads it: running, with no secrets file, so a pasted
 * token is kept in the keychain.
 */
const DAEMON_STATUS: DaemonStatusReadResponse = {
  processState: "running",
  processIdentity: { processId: 4242, bootId: "scenario-boot", processStartTime: "scenario-start" },
  version: "0.0.0",
  protocolVersion: CURRENT_PROTOCOL_VERSION,
  transportEndpoint: "scenario",
  startedAt: OBSERVED_AT,
  uptimeMs: 60_000,
  dataDirectory: "/scenario/data",
  processor: null,
  memory: null,
  recovery: { overall: "healthy", sessions: [] },
};

/** Every call the two machine-level settings pages make, and what each is answered with. */
export const SETTINGS_REPLIES: readonly ScenarioReply[] = [
  ...MCP_SERVER_REPLIES,
  // Computed, so a moved default and a re-supplied token read back applied.
  { call: "provider.account.list", resultFor: answerAccountList },
  { call: "daemon.status.read", result: DAEMON_STATUS },
  // Computed, so each attempt carries its own id and its completion names that one.
  {
    call: "provider.account.signIn",
    afterMs: 200,
    resultFor: answerSignIn,
    noticesFor: finishSignIn,
  },
  { call: "provider.account.signInAttempt.cancel", result: SIGN_IN_CANCELED },
  // Computed, so the account answered is the one the form described.
  { call: "provider.account.register", afterMs: 200, resultFor: answerAccountRegistration },
  // Computed, so the reading answered is the checked account's own.
  { call: "provider.account.probe", afterMs: 200, resultFor: answerAccountProbe },
  // Computed, so an account whose sign-in is gone is refused with its own remedy.
  { call: "provider.account.current.update", afterMs: 200, resultFor: answerSetCurrent },
];

/**
 * A device-code sign-in whose attempt id is minted from the answer's ordinal, its code good for a
 * quarter of an hour from the answer.
 */
function answerSignIn(
  _request: unknown,
  settledAtMilliseconds: number,
  computedReplyOrdinal: number,
): ProviderAccountSignInResponse {
  return {
    attemptId: signInAttemptId(computedReplyOrdinal),
    verificationUri: "https://provider.example.test/device",
    userCode: "WXYZ-1234",
    expiresAt: new Date(settledAtMilliseconds + SIGN_IN_CODE_LIFETIME_MS).toISOString(),
    isBrowserOpenedByProvider: false,
  };
}

/** The attempt id the answer with this ordinal mints. */
function signInAttemptId(computedReplyOrdinal: number): string {
  return `attempt-${String(computedReplyOrdinal)}`;
}

/**
 * The completion the daemon reports once the provider's flow ends: the attempt the answer minted,
 * for the account the request named. A playback's first sign-in fails with the provider's own
 * reason and every later one finishes, so `Sign in` is pressed again after a failure. Composed
 * when it comes due, so an attempt canceled in the meantime reports nothing.
 */
function finishSignIn(request: unknown, answer: unknown): readonly ScenarioNotice[] {
  const account = scriptedAccountNamedBy(request);
  const attemptId = readMember(answer, "attemptId");
  if (account === undefined || typeof attemptId !== "string") {
    return [];
  }
  const payload: ProviderAccountNotification =
    attemptId === signInAttemptId(1)
      ? {
          kind: "signInCompleted",
          attemptId,
          accountId: account.accountId,
          outcome: "failed",
          failureReason: "The device code expired before it was entered.",
        }
      : { kind: "signInCompleted", attemptId, accountId: account.accountId, outcome: "succeeded" };
  return [
    {
      stream: "provider.account.subscribe",
      afterMs: SIGN_IN_FINISHES_AFTER_MS,
      payloadAtDelivery: (answeredRequestsFor) =>
        answeredRequestsFor("provider.account.signInAttempt.cancel").some(
          (cancel) => readMember(cancel, "attemptId") === attemptId,
        )
          ? undefined
          : payload,
    },
  ];
}

/**
 * The account's current reading. It stands for a fresh read and for the answer the daemon gives
 * inside a minute of the last read alike, since the reply carries the same members either way. A
 * request naming no scripted account settles as an unscripted call does.
 */
function answerAccountProbe(
  request: unknown,
  settledAtMilliseconds: number,
  _computedReplyOrdinal: number,
  answeredRequestsFor: AnsweredRequests,
): ProviderAccountProbeResponse | undefined {
  const account = accountNamedBy(
    request,
    currentAccounts(answeredRequestsFor, settledAtMilliseconds),
  );
  return account === undefined
    ? undefined
    : {
        accountId: account.accountId,
        healthState: account.healthState,
        credentialGeneration: account.credentialGeneration,
      };
}

/** The registry as the daemon would read it now, with one readiness entry per provider. */
function answerAccountList(
  _request: unknown,
  settledAtMilliseconds: number,
  _computedReplyOrdinal: number,
  answeredRequestsFor: AnsweredRequests,
): ProviderAccountListResponse {
  const accounts = currentAccounts(answeredRequestsFor, settledAtMilliseconds);
  return {
    accounts: [...accounts],
    usageWindows: [...USAGE_WINDOWS],
    readiness: READINESS_PROVIDERS.map((provider) => readinessOf(provider, accounts)),
  };
}

/**
 * The named account made its provider's current one, or the daemon's refusal where its sign-in is
 * gone, carrying that account's own remedy; nothing moves on a refusal. A request naming no
 * scripted account settles as an unscripted call does.
 */
function answerSetCurrent(
  request: unknown,
  settledAtMilliseconds: number,
  _computedReplyOrdinal: number,
  answeredRequestsFor: AnsweredRequests,
): ProviderAccountCurrentUpdateResponse | undefined {
  const account = accountNamedBy(
    request,
    currentAccounts(answeredRequestsFor, settledAtMilliseconds),
  );
  if (account === undefined) {
    return undefined;
  }
  if (account.healthState === "reauthRequired" || account.healthState === "homeMissing") {
    const details = {
      remedy: signInRemedyFor(account),
    } satisfies ProviderAccountNotAuthenticatedDetails;
    // A thrown wire envelope is the scenario's way to script a daemon refusal.
    const refusal: ScenarioRefusalEnvelope = {
      code: PROVIDER_ACCOUNT_NOT_AUTHENTICATED_CODE,
      message: "That account is not signed in, so it was not made the default.",
      details,
    };
    throw refusal;
  }
  return { account: { ...account, isDefault: true }, movingSessions: [] };
}

/**
 * The scripted accounts with every answered write applied: each re-supplied token signs its
 * account back in under the next credential generation, observed no later than `observedAtMs`,
 * then each answered current-account move takes the mark from the provider's other accounts.
 */
function currentAccounts(
  answeredRequestsFor: AnsweredRequests,
  observedAtMilliseconds: number,
): readonly ProviderAccount[] {
  const resupplies = answeredRequestsFor("provider.account.register").filter(
    (request) => readMember(request, "accountId") !== undefined,
  );
  const resupplied = SCRIPTED_ACCOUNTS.map((account): ProviderAccount => {
    const count = resupplies.filter(
      (request) => readMember(request, "accountId") === account.accountId,
    ).length;
    return count === 0
      ? account
      : {
          ...account,
          credentialGeneration: account.credentialGeneration + count,
          healthState: "authenticated",
          healthObservedAt: new Date(observedAtMilliseconds).toISOString(),
        };
  });
  return answeredRequestsFor("provider.account.current.update").reduce<readonly ProviderAccount[]>(
    (accounts, request) => {
      const moved = accountNamedBy(request, accounts);
      return moved === undefined
        ? accounts
        : accounts.map((account) =>
            account.provider === moved.provider
              ? { ...account, isDefault: account.accountId === moved.accountId }
              : account,
          );
    },
    resupplied,
  );
}

/**
 * One provider's readiness, resolved to its current account the way the daemon resolves it. Cast
 * because the generated readiness type reads the remedy's account-id cross-reference as a member.
 */
function readinessOf(
  provider: ProviderId,
  accounts: readonly ProviderAccount[],
): ProviderReadiness {
  const providerAccounts = accounts.filter((account) => account.provider === provider);
  const [firstAccount, ...otherAccounts] = providerAccounts;
  if (firstAccount === undefined) {
    return { provider, state: "noAccount", remedy: { kind: "register", provider } };
  }
  const resolved = providerAccounts.find((account) => account.isDefault);
  if (resolved === undefined) {
    return {
      provider,
      state: "noCurrent",
      remedy: {
        kind: "chooseCurrent",
        candidateAccountIds: [
          firstAccount.accountId,
          ...otherAccounts.map((account) => account.accountId),
        ],
      },
    };
  }
  const entry = {
    provider,
    resolvedAccountId: resolved.accountId,
    ...(resolved.healthObservedAt === null ? {} : { observedAt: resolved.healthObservedAt }),
  };
  switch (resolved.healthState) {
    case "authenticated":
      return { ...entry, state: "authenticated" };
    case "reauthRequired":
      return {
        ...entry,
        state: "reauthRequired",
        remedy: signInRemedyFor(resolved),
      } as ProviderReadiness;
    case "homeMissing":
      return {
        ...entry,
        state: "homeMissing",
        remedy: { kind: "signIn", accountId: resolved.accountId },
      } as ProviderReadiness;
    case "indeterminate":
      return {
        ...entry,
        state: "indeterminate",
        remedy: { kind: "lookAgain", accountId: resolved.accountId },
      } as ProviderReadiness;
  }
}

/**
 * The one way back for an account whose sign-in is gone: a token or API-key account cannot
 * refresh itself, so a fresh token is pasted; every other account signs in again through the
 * provider.
 */
function signInRemedyFor(account: ProviderAccount): ProviderSignInExpiredRemedy {
  const isPastedCredential =
    account.observedAuthMode === "oauthToken" || account.observedAuthMode === "apiKey";
  return isPastedCredential && account.healthState === "reauthRequired"
    ? { kind: "pasteToken", accountId: account.accountId }
    : { kind: "signIn", accountId: account.accountId };
}

/** The account among `accounts` a request's `accountId` names, or `undefined`. */
function accountNamedBy(
  request: unknown,
  accounts: readonly ProviderAccount[],
): ProviderAccount | undefined {
  return accounts.find((registered) => registered.accountId === readMember(request, "accountId"));
}

/** The scripted account a request's `accountId` names, or `undefined`. */
function scriptedAccountNamedBy(request: unknown): ProviderAccount | undefined {
  return accountNamedBy(request, SCRIPTED_ACCOUNTS);
}

/**
 * A freshly registered account carrying the provider, label and billing mode the request named,
 * with an identity minted from the answer's ordinal, or `undefined` for a request missing one. A
 * request naming an account replaces that account's token and answers the same account, its
 * identity kept, under the next credential generation and signed in. A playback's first pasted
 * token is one the provider does not accept, refused as the daemon refuses it, with nothing
 * registered or replaced; every later one is accepted.
 */
function answerAccountRegistration(
  request: unknown,
  settledAtMilliseconds: number,
  computedReplyOrdinal: number,
  answeredRequestsFor: AnsweredRequests,
): ProviderAccountRegisterResponse | undefined {
  if (typeof request !== "object" || request === null) {
    return undefined;
  }
  if (computedReplyOrdinal === 1) {
    // A thrown wire envelope is the scenario's way to script a daemon refusal.
    const refusal: ScenarioRefusalEnvelope = {
      code: PROVIDER_ACCOUNT_TOKEN_NOT_ACCEPTED_CODE,
      message: "The provider's status check found no signed-in account for that token.",
    };
    throw refusal;
  }
  const sent = request as Readonly<Record<string, unknown>>;
  if (sent["accountId"] !== undefined) {
    const resupplied = accountNamedBy(
      request,
      currentAccounts(answeredRequestsFor, settledAtMilliseconds),
    );
    return resupplied === undefined
      ? undefined
      : {
          account: {
            ...resupplied,
            credentialGeneration: resupplied.credentialGeneration + 1,
            healthState: "authenticated",
            healthObservedAt: new Date(settledAtMilliseconds).toISOString(),
          },
        };
  }
  const { displayLabel, billingMode } = sent;
  const provider = READINESS_PROVIDERS.find((known) => known === sent["provider"]);
  if (
    provider === undefined ||
    typeof displayLabel !== "string" ||
    (billingMode !== "subscription" && billingMode !== "metered" && billingMode !== "unknown")
  ) {
    return undefined;
  }
  return {
    account: {
      ...TOKEN_ACCOUNT,
      accountId: `pa-registered-${String(computedReplyOrdinal)}` as ProviderAccountId,
      provider,
      displayLabel,
      billingMode,
      // The pasted credential's kind, which the registration's own status check observed.
      observedAuthMode: provider === CODEX ? "apiKey" : "oauthToken",
      isDefault: false,
      // Nothing has observed an account registered a moment ago.
      healthState: "indeterminate",
      healthObservedAt: null,
    },
  };
}
