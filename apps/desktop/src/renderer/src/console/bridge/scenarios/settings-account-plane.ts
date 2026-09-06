// The provider-account plane the settings scenario answers: the registry, its quota
// rows, its readiness projection, and the three sign-in verbs.
//
// Split out of `settings.ts` on `settings-runtime-nodes.ts`' rule — that module says
// what a person does and in what order, and this says what the daemon answers while
// they do it. A data table sitting between a scenario's identity and its beats is what
// made that file unreadable from either end.
//
// EVERY REPLY HERE IS A WHOLE REGISTERED RESPONSE. `providerAccount.list` reaches the
// console over the bound call door, so the fixture seam parses this reply with the
// registered schema and a row that drifted from the contract fails there rather than
// reaching a surface as a shape no daemon would send. The three sign-in verbs travel
// the growth port and carry the same registered shapes, which is why they are typed
// here rather than written as loose objects.
//
// WHAT THIS TABLE DELIBERATELY PUTS IN THE INTERESTING ARM. Every state below was
// unreachable from any scenario before it: an account the registry has never observed,
// an observation months old, a readiness entry carrying a sign-in remedy, three quota
// limits sharing one window length, and a superseded reading. The calm arms are what
// the unscripted fallbacks already answer, so a deck that scripted those too would
// leave the alarming states drawn by nobody.

import type {
  ProviderAccount,
  ProviderAccountId,
  ProviderAccountListResponse,
  ProviderAccountLoginCancelResponse,
  ProviderAccountLoginResponse,
  ProviderAccountRegisterResponse,
} from "@ai-sidekicks/contracts";

import type { ScenarioReply } from "../scenario-runtime/index.js";

/** The Claude account a run is admitted against today. */
const CLAUDE_DEFAULT_ACCOUNT = "acct-claude-team" as ProviderAccountId;
/** A second Claude account, registered under a vendor-minted token. */
const CLAUDE_TOKEN_ACCOUNT = "acct-claude-batch" as ProviderAccountId;
/** The Codex account nothing has ever observed. */
const CODEX_ACCOUNT = "acct-codex-personal" as ProviderAccountId;

/**
 * The instant the healthy account was last observed, and the much older one the
 * token account carries.
 *
 * Two stamps rather than one because the page's degraded state is exactly their
 * difference: "a stale `healthObservedAt` renders with its timestamp rather than being
 * hidden", and a deck whose observations were all minutes old could not reach it.
 */
const OBSERVED_RECENTLY = "2026-01-01T07:58:00.000Z";
const OBSERVED_LONG_AGO = "2025-12-08T14:12:00.000Z";

/**
 * The three registry rows, in the order the list pane shows them.
 *
 * Each one carries a different answer to the same question, which is the point of
 * having three. The first is authenticated, default, and reports the identity its
 * provider surfaced. The second is a token-mode account whose observation is months
 * old and which reports NO provider identity — so a surface that rendered an email
 * unconditionally would render an empty cell here. The third has never been observed
 * at all: `healthObservedAt`, `observedAuthMode`, `loggedInAt`, and the re-login
 * estimate are all `null` together, which is the one shape `healthState` alone cannot
 * distinguish from a probe that could not decide.
 */
const ACCOUNTS: readonly ProviderAccount[] = [
  {
    accountId: CLAUDE_DEFAULT_ACCOUNT,
    provider: "claude",
    displayLabel: "Claude — team plan",
    credentialGeneration: 3,
    billingMode: "subscription",
    observedAccountEmail: "team@example.test",
    observedAccountOrgName: "Example Engineering",
    isDefault: true,
    healthState: "authenticated",
    healthObservedAt: OBSERVED_RECENTLY,
    observedAuthMode: "oauth_subscription",
    loggedInAt: "2025-12-20T09:30:00.000Z",
    expectedReloginAtEstimate: "2026-01-19T09:30:00.000Z",
    probeEnabled: true,
  },
  {
    accountId: CLAUDE_TOKEN_ACCOUNT,
    provider: "claude",
    displayLabel: "Claude — batch runs",
    credentialGeneration: 7,
    billingMode: "metered",
    isDefault: false,
    healthState: "reauth_required",
    healthObservedAt: OBSERVED_LONG_AGO,
    observedAuthMode: "oauth_token",
    loggedInAt: "2025-11-30T08:00:00.000Z",
    // No estimate: the anchor exists and the mode publishes no issuance interval this
    // build can read, and an estimate with no interval would be a fabrication.
    expectedReloginAtEstimate: null,
    // The operator silenced the background observer for this one, which is why its
    // reading is months old rather than minutes.
    probeEnabled: false,
  },
  {
    accountId: CODEX_ACCOUNT,
    provider: "codex",
    displayLabel: "Codex — personal",
    credentialGeneration: 1,
    billingMode: "unknown",
    isDefault: true,
    healthState: "indeterminate",
    healthObservedAt: null,
    observedAuthMode: null,
    loggedInAt: null,
    expectedReloginAtEstimate: null,
    probeEnabled: true,
  },
];

/**
 * The registry reply: the accounts, their durable quota rows, and readiness.
 *
 * THE QUOTA ROWS INCLUDE A SUPERSEDED ONE ON PURPOSE. Three of them share one
 * `windowMins` of 10080, which is the exact case the `(accountId, limitId)` key exists
 * for — an `(accountId, windowMins)` key would collapse them and the survivor would
 * depend on arrival order. A fourth row repeats one of those limits at an OLDER
 * `observedAt`, so a table that took the last row it saw rather than the newest
 * observation renders a figure this deck can prove wrong.
 *
 * READINESS CARRIES ONE ENTRY PER PROVIDER, never zero and never two. Claude resolves
 * to its default account and needs nothing done, so it carries no remedy at all —
 * which is the one state whose remedy would be wrong rather than merely redundant.
 * Codex resolves to an account nothing has observed, so it is `indeterminate` with the
 * `sign_in` remedy that state calls for, naming the same account it resolved and the
 * credential home that invocation authenticates into.
 */
export const SETTINGS_PROVIDER_ACCOUNT_LIST: ProviderAccountListResponse = {
  accounts: [...ACCOUNTS],
  usageWindows: [
    {
      accountId: CLAUDE_DEFAULT_ACCOUNT,
      limitId: "session_5h",
      windowMins: 300,
      label: "Session",
      usedPercent: 41,
      resetsAt: "2026-01-01T11:00:00.000Z",
      observedAt: OBSERVED_RECENTLY,
      observedCredentialGeneration: 3,
      source: "run",
    },
    {
      accountId: CLAUDE_DEFAULT_ACCOUNT,
      limitId: "weekly_all",
      windowMins: 10080,
      label: "Weekly",
      usedPercent: 88,
      resetsAt: "2026-01-05T00:00:00.000Z",
      observedAt: OBSERVED_RECENTLY,
      observedCredentialGeneration: 3,
      source: "run",
    },
    {
      accountId: CLAUDE_DEFAULT_ACCOUNT,
      limitId: "weekly_opus",
      windowMins: 10080,
      label: "Weekly (largest model)",
      // Over 100 on purpose, and NOT clamped on the wire: a provider may report
      // over-consumption against a soft limit and the renderer is what clamps for
      // display, so a deck that never sent one could not prove the clamp is there.
      usedPercent: 103,
      resetsAt: "2026-01-05T00:00:00.000Z",
      observedAt: OBSERVED_RECENTLY,
      observedCredentialGeneration: 3,
      source: "probe",
    },
    {
      accountId: CLAUDE_DEFAULT_ACCOUNT,
      limitId: "weekly_opus",
      windowMins: 10080,
      label: "Weekly (largest model)",
      usedPercent: 12,
      resetsAt: "2026-01-05T00:00:00.000Z",
      // OLDER than the row above and last in the array: the superseded reading.
      observedAt: "2025-12-31T22:04:00.000Z",
      observedCredentialGeneration: 3,
      source: "run",
    },
    {
      accountId: CLAUDE_TOKEN_ACCOUNT,
      limitId: "weekly_all",
      windowMins: 10080,
      label: "Weekly",
      usedPercent: 4,
      observedAt: OBSERVED_LONG_AGO,
      // Taken two generations ago: a credential-home rebuild does not clear stored
      // readings, so the page has a reading it must mark as behind the account.
      observedCredentialGeneration: 5,
      source: "probe",
    },
  ],
  readiness: [
    {
      provider: "claude",
      state: "authenticated",
      resolvedAccountId: CLAUDE_DEFAULT_ACCOUNT,
      observedAt: OBSERVED_RECENTLY,
    },
    {
      provider: "codex",
      state: "indeterminate",
      resolvedAccountId: CODEX_ACCOUNT,
      remedy: {
        kind: "sign_in",
        accountId: CODEX_ACCOUNT,
        signInInvocation: "codex login",
        credentialHomePath: "/var/lib/sidekicks/credential-homes/acct-codex-personal",
      },
    },
  ],
};

/** What a brokered sign-in answers: where to finish it, and by when. */
export const SETTINGS_PROVIDER_ACCOUNT_LOGIN: ProviderAccountLoginResponse = {
  attemptId: "login-attempt-7f3c",
  verificationUri: "https://auth.example.test/device",
  userCode: "HJKL-2946",
  expiresAt: "2026-01-01T08:10:00.000Z",
};

/** What cancelling that attempt answers. */
export const SETTINGS_PROVIDER_ACCOUNT_LOGIN_CANCEL: ProviderAccountLoginCancelResponse = {
  status: "cancelled",
};

/**
 * What registering with a non-interactive token answers.
 *
 * The account, and nothing else. There is no member on this reply for the token that
 * was submitted, which is the registered shape and the reason the write-only field can
 * be built honestly: there is nothing here to echo back even for a surface that tried.
 */
export const SETTINGS_PROVIDER_ACCOUNT_REGISTER: ProviderAccountRegisterResponse = {
  account: {
    accountId: "acct-codex-ci" as ProviderAccountId,
    provider: "codex",
    displayLabel: "Codex — CI",
    credentialGeneration: 1,
    billingMode: "metered",
    isDefault: false,
    healthState: "authenticated",
    healthObservedAt: "2026-01-01T08:00:00.000Z",
    observedAuthMode: "oauth_token",
    loggedInAt: "2026-01-01T08:00:00.000Z",
    expectedReloginAtEstimate: null,
    probeEnabled: true,
  },
};

/**
 * The account plane's scripted replies.
 *
 * The registry read carries a small latency because its loading state is a real frame
 * a person sees, and a reply that resolved on the same tick as the call would let the
 * page ship without anyone having drawn it. The three verbs answer a little more
 * slowly still: each is a press, and the pending arm of the sign-in card is the state
 * the flow is in for as long as the operator is at the provider's own page.
 */
export const SETTINGS_ACCOUNT_PLANE_REPLIES: readonly ScenarioReply[] = [
  { call: "providerAccount.list", afterMs: 40, result: SETTINGS_PROVIDER_ACCOUNT_LIST },
  { call: "providerAccount.login", afterMs: 80, result: SETTINGS_PROVIDER_ACCOUNT_LOGIN },
  {
    call: "providerAccount.loginCancel",
    afterMs: 60,
    result: SETTINGS_PROVIDER_ACCOUNT_LOGIN_CANCEL,
  },
  { call: "providerAccount.register", afterMs: 80, result: SETTINGS_PROVIDER_ACCOUNT_REGISTER },
];
