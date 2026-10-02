// What the MCP servers and Providers settings pages are answered with: the machine's MCP
// inventory and its provider-account registry, and the calls each page's controls send. Both
// are the machine's, not a session's, so a scenario that plays a session spreads these into its
// own replies.
//
// The inventory holds the three rows the MCP page must draw: a connected binding, one needing
// authorization while one of its legs is fine, and one whose binding store could not be read.
// The registry holds an account the daemon observed signed in, with two limits on one window
// length, and one nothing has observed, whose readiness entry carries the sign-in remedy.

import type {
  McpMutationResult,
  McpServerInventoryEntry,
  ProviderAccount,
  ProviderAccountId,
  ProviderAccountListResponse,
  ProviderAccountLoginCancelResponse,
  ProviderAccountLoginResponse,
  ProviderAccountRegisterResponse,
  SessionId,
} from "@ai-sidekicks/contracts";
import type { ScenarioReply } from "@renderer/services/daemon/scenario-reply.fixture.js";

const OBSERVED_AT = "2026-01-01T08:55:00.000Z";
const SESSION_A = "019b79ee-0280-75e5-8510-ada11a5a21a5" as SessionId;
const SESSION_B = "019b79ee-0280-75e5-8510-ada11a5a22a5" as SessionId;
const WORK_ACCOUNT_ID = "pa-0001" as ProviderAccountId;
const PERSONAL_ACCOUNT_ID = "pa-0002" as ProviderAccountId;

const MCP_INVENTORY: readonly McpServerInventoryEntry[] = [
  {
    provider: "claude",
    scope: "user",
    serverName: "filesystem",
    config: {
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem"],
      envVarNames: ["FS_ROOT"],
    },
    status: "connected",
    observedAt: OBSERVED_AT,
    enabled: true,
    toolOverrides: [{ toolName: "write_file", approvalMode: "prompt" }],
  },
  {
    provider: "codex",
    scope: "project",
    scopeRef: "/work/sidekicks",
    serverName: "issue-tracker",
    config: {
      transport: "http",
      url: "https://issues.example.test/mcp",
      headerNames: ["X-Workspace"],
      bearerTokenEnvVar: "ISSUES_TOKEN",
    },
    status: "needs-auth",
    observedAt: OBSERVED_AT,
    legs: [
      { sessionId: SESSION_A, bindingId: "leg-a", status: "needs-auth" },
      { sessionId: SESSION_B, bindingId: "leg-b", status: "connected" },
    ],
    enabled: true,
    toolOverrides: [],
  },
  {
    provider: "claude",
    scope: "local",
    scopeRef: "/work/sidekicks",
    serverName: "scratchpad",
    config: { transport: "stdio", command: "./scripts/scratchpad-mcp" },
    status: "unknown",
    bindingStoreUnavailable: true,
  },
];

/** An account the daemon observed and found signed in. */
const WORK_ACCOUNT: ProviderAccount = {
  accountId: WORK_ACCOUNT_ID,
  provider: "claude",
  displayLabel: "Claude — work",
  credentialGeneration: 3,
  billingMode: "subscription",
  isDefault: true,
  healthState: "authenticated",
  healthObservedAt: OBSERVED_AT,
  observedAuthMode: "oauth_subscription",
  loggedInAt: "2025-12-02T09:00:00.000Z",
  expectedReloginAtEstimate: "2026-01-01T09:00:00.000Z",
  probeEnabled: true,
  lastRefreshObservedAt: null,
  windowStartEnabled: true,
  wakeForWindowStartEnabled: false,
  memoryImport: null,
};

/** An account nothing has observed yet. */
const PERSONAL_ACCOUNT: ProviderAccount = {
  accountId: PERSONAL_ACCOUNT_ID,
  provider: "codex",
  displayLabel: "Codex — personal",
  credentialGeneration: 1,
  billingMode: "metered",
  isDefault: true,
  healthState: "indeterminate",
  healthObservedAt: null,
  observedAuthMode: null,
  loggedInAt: null,
  expectedReloginAtEstimate: null,
  probeEnabled: true,
  lastRefreshObservedAt: null,
  windowStartEnabled: true,
  wakeForWindowStartEnabled: false,
  memoryImport: null,
};

const ACCOUNT_REGISTRY: ProviderAccountListResponse = {
  accounts: [WORK_ACCOUNT, PERSONAL_ACCOUNT],
  usageWindows: [
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
  ],
  readiness: [
    {
      provider: "claude",
      state: "authenticated",
      resolvedAccountId: WORK_ACCOUNT_ID,
      observedAt: OBSERVED_AT,
    },
    {
      provider: "codex",
      state: "indeterminate",
      resolvedAccountId: PERSONAL_ACCOUNT_ID,
      remedy: {
        kind: "sign_in",
        accountId: PERSONAL_ACCOUNT_ID,
        signInInvocation: "codex login",
        credentialHomePath: "/home/person/.sidekicks/homes/pa-0002",
      },
    },
  ],
};

const SIGN_IN_ATTEMPT: ProviderAccountLoginResponse = {
  attemptId: "attempt-1",
  verificationUri: "https://provider.example.test/device",
  userCode: "WXYZ-1234",
  expiresAt: "2026-01-01T09:15:00.000Z",
};

const SIGN_IN_CANCELED: ProviderAccountLoginCancelResponse = { status: "canceled" };

/** Every call the two machine-level settings pages make, and what each is answered with. */
export const SETTINGS_PAGE_REPLIES: readonly ScenarioReply[] = [
  { call: "mcp.list", result: { servers: MCP_INVENTORY } },
  // Computed, so the row that was pressed is the row the answer names.
  { call: "mcp.setEnabled", afterMs: 200, resultFor: answerMcpSetEnabled },
  { call: "providerAccount.list", result: ACCOUNT_REGISTRY },
  { call: "providerAccount.login", afterMs: 200, result: SIGN_IN_ATTEMPT },
  { call: "providerAccount.loginCancel", result: SIGN_IN_CANCELED },
  // Computed, so the account answered is the one the form described.
  { call: "providerAccount.register", afterMs: 200, resultFor: answerAccountRegistration },
];

/**
 * The inventory row a `mcp.setEnabled` request addresses, with the enablement it asked for, or
 * `undefined` for a request naming no scripted row, which settles as an unscripted call does.
 */
function answerMcpSetEnabled(request: unknown): McpMutationResult | undefined {
  if (typeof request !== "object" || request === null) {
    return undefined;
  }
  const sent = request as Readonly<Record<string, unknown>>;
  const enabled = sent["enabled"];
  const server = MCP_INVENTORY.find(
    (entry) =>
      entry.provider === sent["provider"] &&
      entry.scope === sent["scope"] &&
      entry.serverName === sent["serverName"] &&
      (entry.scope === "user" ? undefined : entry.scopeRef) === sent["scopeRef"],
  );
  if (server === undefined || typeof enabled !== "boolean") {
    return undefined;
  }
  return { server: { ...server, enabled }, applied: "next_run" };
}

/**
 * A freshly registered account carrying the provider, label and billing mode the request named,
 * with an identity minted from the answer's ordinal, or `undefined` for a request missing one.
 */
function answerAccountRegistration(
  request: unknown,
  _settledAtMilliseconds: number,
  computedReplyOrdinal: number,
): ProviderAccountRegisterResponse | undefined {
  if (typeof request !== "object" || request === null) {
    return undefined;
  }
  const sent = request as Readonly<Record<string, unknown>>;
  const { provider, displayLabel, billingMode } = sent;
  if (
    (provider !== "claude" && provider !== "codex") ||
    typeof displayLabel !== "string" ||
    (billingMode !== "subscription" && billingMode !== "metered" && billingMode !== "unknown")
  ) {
    return undefined;
  }
  return {
    account: {
      ...PERSONAL_ACCOUNT,
      accountId: `pa-registered-${String(computedReplyOrdinal)}` as ProviderAccountId,
      provider,
      displayLabel,
      billingMode,
      isDefault: false,
    },
  };
}
