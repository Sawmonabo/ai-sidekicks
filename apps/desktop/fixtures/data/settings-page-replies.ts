// What the MCP servers and Providers settings pages are answered with: the machine's MCP
// inventory and its provider-account registry, and the calls each page's controls send. Both
// are the machine's, not a session's, so a scenario that plays a session spreads these into its
// own replies.
//
// The inventory holds the three rows the MCP page must draw: a connected binding, one needing
// authorization while one of its legs is fine, and one whose binding store could not be read.
// The registry holds an account the daemon observed signed in, with two limits on one window
// length, and one nothing has observed, whose readiness entry carries the sign-in remedy.
//
// The two pages' writes behave as the daemon's do: a switched binding reads back switched and is
// announced on `mcp.subscribe`, and a sign-in the page started finishes on its own a few seconds
// later, reported on `providerAccount.subscribe`, unless it was canceled first.

import type {
  McpListResponse,
  McpMutationResult,
  McpServerBindingRef,
  McpServerConfigChangedNotice,
  McpServerInventoryEntry,
} from "@ai-sidekicks/contracts/mcp";
import type {
  ProviderAccountNotification,
  ProviderAccount,
  ProviderAccountId,
  ProviderAccountListResponse,
} from "@ai-sidekicks/contracts/provider-account";
import type {
  ProviderAccountLoginCancelResponse,
  ProviderAccountLoginResponse,
  ProviderAccountRegisterResponse,
} from "@ai-sidekicks/contracts/provider-account-sign-in";
import type { SessionId } from "@ai-sidekicks/contracts/session";
import type {
  ScenarioNotice,
  ScenarioReply,
} from "@renderer/services/daemon/scenario-reply.fixture.js";

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

const SIGN_IN_CANCELED: ProviderAccountLoginCancelResponse = { status: "canceled" };

/** How long a started sign-in takes to finish on its own, in scenario time. */
const SIGN_IN_FINISHES_AFTER_MS = 5000;

/** Every call the two machine-level settings pages make, and what each is answered with. */
export const SETTINGS_PAGE_REPLIES: readonly ScenarioReply[] = [
  // Computed, so a binding switched earlier in the playback reads back switched.
  { call: "mcp.list", resultFor: answerMcpList },
  // Computed, so the row that was pressed is the row the answer names.
  {
    call: "mcp.setEnabled",
    afterMs: 200,
    resultFor: answerMcpSetEnabled,
    noticesFor: announceMcpEdit,
  },
  { call: "providerAccount.list", result: ACCOUNT_REGISTRY },
  // Computed, so each attempt carries its own id and its completion names that one.
  {
    call: "providerAccount.login",
    afterMs: 200,
    resultFor: answerSignIn,
    noticesFor: finishSignIn,
  },
  { call: "providerAccount.loginCancel", result: SIGN_IN_CANCELED },
  // Computed, so the account answered is the one the form described.
  { call: "providerAccount.register", afterMs: 200, resultFor: answerAccountRegistration },
];

/** The inventory, with each binding's newest answered `mcp.setEnabled` applied. */
function answerMcpList(
  _request: unknown,
  _settledAtMilliseconds: number,
  _computedReplyOrdinal: number,
  answeredRequestsFor: (call: string) => readonly unknown[],
): McpListResponse {
  const writes = answeredRequestsFor("mcp.setEnabled");
  return {
    servers: MCP_INVENTORY.map((entry) => {
      const newestWrite = writes.findLast(
        (request) => scriptedServerAddressedBy(request) === entry,
      );
      const enabled = enablementOf(newestWrite);
      return enabled === undefined ? entry : { ...entry, enabled };
    }),
  };
}

/**
 * The inventory row a `mcp.setEnabled` request addresses, with the enablement it asked for, or
 * `undefined` for a request naming no scripted row, which settles as an unscripted call does.
 */
function answerMcpSetEnabled(request: unknown): McpMutationResult | undefined {
  const server = scriptedServerAddressedBy(request);
  const enabled = enablementOf(request);
  if (server === undefined || enabled === undefined) {
    return undefined;
  }
  return { server: { ...server, enabled }, applied: "next_run" };
}

/** The edit notice the daemon sends once it has applied a binding's enablement change. */
function announceMcpEdit(request: unknown): readonly ScenarioNotice[] {
  const server = scriptedServerAddressedBy(request);
  if (server === undefined) {
    return [];
  }
  const payload: McpServerConfigChangedNotice = {
    ...bindingRefOf(server),
    type: "mcp.server_config_changed",
  };
  return [{ stream: "mcp.subscribe", afterMs: 0, payloadAtDelivery: () => payload }];
}

/** The scripted inventory row a request's binding fields address, or `undefined`. */
function scriptedServerAddressedBy(request: unknown): McpServerInventoryEntry | undefined {
  return MCP_INVENTORY.find(
    (entry) =>
      entry.provider === fieldOf(request, "provider") &&
      entry.scope === fieldOf(request, "scope") &&
      entry.serverName === fieldOf(request, "serverName") &&
      (entry.scope === "user" ? undefined : entry.scopeRef) === fieldOf(request, "scopeRef"),
  );
}

/** The enablement a `mcp.setEnabled` request asked for, or `undefined` for none. */
function enablementOf(request: unknown): boolean | undefined {
  const enabled = fieldOf(request, "enabled");
  return typeof enabled === "boolean" ? enabled : undefined;
}

/** One member of a request or answer the fixture is handed untyped, or `undefined`. */
function fieldOf(value: unknown, field: string): unknown {
  return typeof value === "object" && value !== null
    ? (value as Readonly<Record<string, unknown>>)[field]
    : undefined;
}

/** A row's binding address alone, as a notice carries it. */
function bindingRefOf(entry: McpServerInventoryEntry): McpServerBindingRef {
  return entry.scope === "user"
    ? { provider: entry.provider, scope: entry.scope, serverName: entry.serverName }
    : {
        provider: entry.provider,
        scope: entry.scope,
        scopeRef: entry.scopeRef,
        serverName: entry.serverName,
      };
}

/** A device-code sign-in whose attempt id is minted from the answer's ordinal. */
function answerSignIn(
  _request: unknown,
  _settledAtMilliseconds: number,
  computedReplyOrdinal: number,
): ProviderAccountLoginResponse {
  return {
    attemptId: `attempt-${String(computedReplyOrdinal)}`,
    verificationUri: "https://provider.example.test/device",
    userCode: "WXYZ-1234",
    expiresAt: "2026-01-01T09:15:00.000Z",
  };
}

/**
 * The completion the daemon reports once the person has finished the provider's flow: the
 * attempt the answer minted, for the account the request named. Composed when it comes due, so
 * an attempt canceled in the meantime reports nothing.
 */
function finishSignIn(request: unknown, answer: unknown): readonly ScenarioNotice[] {
  const account = ACCOUNT_REGISTRY.accounts.find(
    (registered) => registered.accountId === fieldOf(request, "accountId"),
  );
  const attemptId = fieldOf(answer, "attemptId");
  if (account === undefined || typeof attemptId !== "string") {
    return [];
  }
  const payload: ProviderAccountNotification = {
    kind: "login_completed",
    attemptId,
    accountId: account.accountId,
    outcome: "succeeded",
  };
  return [
    {
      stream: "providerAccount.subscribe",
      afterMs: SIGN_IN_FINISHES_AFTER_MS,
      payloadAtDelivery: (answeredRequestsFor) =>
        answeredRequestsFor("providerAccount.loginCancel").some(
          (cancel) => fieldOf(cancel, "attemptId") === attemptId,
        )
          ? undefined
          : payload,
    },
  ];
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
