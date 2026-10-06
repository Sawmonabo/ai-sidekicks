// What the MCP servers and Providers settings pages are answered with: the machine's MCP
// inventory and its provider-account registry, and the calls each page's controls send. Both
// are the machine's, not a session's, so a scenario that plays a session spreads these into its
// own replies.
//
// The inventory holds the rows the MCP page must draw: a connected binding whose tools read the
// server's own settings beside ones set here, one needing authorization while one of its legs is
// fine, one whose binding store could not be read, and a project's shared copy of that last one's
// name, which the project does not use because its own copy takes its place.
// The registry holds a Claude account the daemon observed signed in, with two limits on one window
// length; a pasted-token Claude account whose token stopped working, marked the default, so its
// readiness entry carries the paste-token remedy; and a Codex account whose folder holds no
// credential, whose entry carries the sign-in remedy.
//
// The two pages' writes behave as the daemon's do: a switched binding reads back switched, and a
// tool's facet reads back set here or, once cleared, the server's own, each announced on
// `mcp.subscribe`; a sign-in the page started ends on its own a few seconds later, reported on
// `providerAccount.subscribe` unless it was canceled first (the first one fails with the
// provider's reason, and every later one finishes), a checked account answers its current reading,
// the first pasted token is one the provider does not accept, a re-supplied token keeps the
// account it was pasted into and signs it back in, and the default moves to a signed-in account
// while one whose login is gone is refused with its own remedy. The registry read reflects every
// answered write.

import {
  MCP_TOOL_OVERRIDE_FACETS,
  type McpApplicationGrade,
  type McpClearToolOverrideRequest,
  type McpListResponse,
  type McpMutationResult,
  type McpServerBindingRef,
  type McpServerConfigChangedNotice,
  type McpServerInventoryEntry,
  type McpSetToolOverrideRequest,
  type McpToolOverrideApplication,
  type McpToolOverrideFacet,
  type McpToolOverrideMutationResult,
  type McpToolReading,
  type McpToolSetting,
} from "@ai-sidekicks/contracts/mcp/server";
import type {
  ProviderAccountNotification,
  ProviderAccount,
  ProviderAccountId,
  ProviderAccountListResponse,
  ProviderLoginExpiredRemedy,
  ProviderReadiness,
} from "@ai-sidekicks/contracts/provider/account/record";
import type { ProviderName } from "@ai-sidekicks/contracts/provider/name";
import {
  PROVIDER_ACCOUNT_NOT_AUTHENTICATED_CODE,
  type ProviderAccountNotAuthenticatedDetails,
  type ProviderAccountProbeResponse,
  type ProviderAccountSetCurrentResponse,
} from "@ai-sidekicks/contracts/provider/account/methods";
import {
  PROVIDER_ACCOUNT_TOKEN_NOT_ACCEPTED_CODE,
  type ProviderAccountLoginCancelResponse,
  type ProviderAccountLoginResponse,
  type ProviderAccountRegisterResponse,
} from "@ai-sidekicks/contracts/provider/account/sign-in";
import type { SubscriptionId } from "@ai-sidekicks/contracts/jsonrpc/streaming";
import type { SessionListAck, SessionListEntry } from "@ai-sidekicks/contracts/session/directory";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import type {
  ScenarioNotice,
  ScenarioOpeningNotice,
  ScenarioRefusalEnvelope,
  ScenarioReply,
} from "#renderer/services/daemon/scenario/reply.fixture.js";
import { readMember, type AnsweredRequests } from "./requests.js";

const OBSERVED_AT = "2026-01-01T08:55:00.000Z";
const SESSION_A = "019b79ee-0280-75e5-8510-ada11a5a21a5" as SessionId;
const SESSION_B = "019b79ee-0280-75e5-8510-ada11a5a22a5" as SessionId;
const WORK_ACCOUNT_ID = "pa-0001" as ProviderAccountId;
const PERSONAL_ACCOUNT_ID = "pa-0002" as ProviderAccountId;
const TOKEN_ACCOUNT_ID = "pa-0003" as ProviderAccountId;

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
    tools: [
      {
        toolName: "read_file",
        enabled: { value: true, source: "server" },
        approvalMode: { value: "auto", source: "server" },
        idempotencyClass: {
          value: "idempotent",
          source: "override",
          serverValue: "manual_reconcile_only",
        },
      },
      {
        toolName: "write_file",
        enabled: { value: true, source: "server" },
        approvalMode: { value: "prompt", source: "override", serverValue: "auto" },
        idempotencyClass: {
          value: "compensable",
          source: "override",
          serverValue: "manual_reconcile_only",
        },
      },
    ],
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
      { sessionId: SESSION_A, bindingId: "leg-a", status: "needs-auth", observedAt: OBSERVED_AT },
      { sessionId: SESSION_B, bindingId: "leg-b", status: "connected" },
    ],
    enabled: true,
    tools: [
      {
        toolName: "create_issue",
        enabled: { value: true, source: "server" },
        approvalMode: { value: "writes", source: "server" },
        idempotencyClass: { value: "manual_reconcile_only", source: "server" },
      },
    ],
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
  {
    provider: "claude",
    scope: "project",
    scopeRef: "/work/sidekicks",
    serverName: "scratchpad",
    config: { transport: "stdio", command: "npx", args: ["-y", "scratchpad-mcp"] },
    status: "unknown",
    supersededIn: ["/work/sidekicks"],
    enabled: true,
    tools: [],
  },
];

/**
 * An account the daemon observed and found signed in, not the default, so it can be made one. The
 * workflow runs pay with it, and a run waiting on a spent account waits on it.
 */
export const WORK_ACCOUNT: ProviderAccount = {
  accountId: WORK_ACCOUNT_ID,
  provider: "claude",
  displayLabel: "Claude — work",
  credentialGeneration: 3,
  billingMode: "subscription",
  isDefault: false,
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

/** An account whose credential home was absent when last observed. */
const PERSONAL_ACCOUNT: ProviderAccount = {
  accountId: PERSONAL_ACCOUNT_ID,
  provider: "codex",
  displayLabel: "Codex — personal",
  credentialGeneration: 1,
  billingMode: "metered",
  isDefault: true,
  healthState: "home_missing",
  healthObservedAt: OBSERVED_AT,
  observedAuthMode: null,
  loggedInAt: null,
  expectedReloginAtEstimate: null,
  probeEnabled: true,
  lastRefreshObservedAt: null,
  windowStartEnabled: true,
  wakeForWindowStartEnabled: false,
  memoryImport: null,
};

/** A pasted-token account whose token stopped working, the default for its provider. */
const TOKEN_ACCOUNT: ProviderAccount = {
  accountId: TOKEN_ACCOUNT_ID,
  provider: "claude",
  displayLabel: "Claude — token",
  credentialGeneration: 1,
  billingMode: "metered",
  isDefault: true,
  healthState: "reauth_required",
  healthObservedAt: OBSERVED_AT,
  observedAuthMode: "oauth_token",
  loggedInAt: "2025-12-20T09:00:00.000Z",
  expectedReloginAtEstimate: null,
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

/** The providers a readiness entry is drawn for, one each. */
const READINESS_PROVIDERS: readonly ProviderName[] = ["claude", "codex"];

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

const SIGN_IN_CANCELED: ProviderAccountLoginCancelResponse = { status: "canceled" };

/** How long a started sign-in takes to finish on its own, in scenario time. */
const SIGN_IN_FINISHES_AFTER_MS = 5000;

/** How long a sign-in code stays good, in scenario time, as a provider's device code does. */
const SIGN_IN_CODE_LIFETIME_MS = 15 * 60 * 1000;

/** Every call the two machine-level settings pages make, and what each is answered with. */
export const SETTINGS_REPLIES: readonly ScenarioReply[] = [
  // Computed, so a binding switched earlier in the playback reads back switched.
  { call: "mcp.list", resultFor: answerMcpList },
  // Computed, so the row that was pressed is the row the answer names.
  {
    call: "mcp.setEnabled",
    afterMs: 200,
    resultFor: answerMcpSetEnabled,
    noticesFor: announceMcpEdit,
  },
  // Computed, so the tool that was pressed is the tool the answer names, each facet set here.
  {
    call: "mcp.setToolOverride",
    afterMs: 200,
    resultFor: answerMcpToolWrite,
    noticesFor: announceMcpEdit,
  },
  // Computed, so the facet cleared reads the server's own and the tool's others stand.
  {
    call: "mcp.clearToolOverride",
    afterMs: 200,
    resultFor: answerMcpToolWrite,
    noticesFor: announceMcpEdit,
  },
  // Computed, so a moved default and a re-supplied token read back applied.
  { call: "providerAccount.list", resultFor: answerAccountList },
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
  // Computed, so the reading answered is the checked account's own.
  { call: "providerAccount.probe", afterMs: 200, resultFor: answerAccountProbe },
  // Computed, so an account whose login is gone is refused with its own remedy.
  { call: "providerAccount.setCurrent", afterMs: 200, resultFor: answerSetCurrent },
];

/**
 * The frame `session.list` opens with: the list as it stands, naming the two running sessions the
 * inventory's legs belong to.
 */
export const SESSION_LIST_OPENING_NOTICES: readonly ScenarioOpeningNotice[] = [
  {
    stream: "session.list",
    payloadAtOpen: (): SessionListAck => ({
      subscriptionId: "019b79ee-0280-7d11-8510-ada11a5a2300" as SubscriptionId,
      sessions: [
        runningChat(SESSION_A, "Fix login"),
        runningChat(SESSION_B, "Refresh-token expiry"),
      ],
    }),
  },
];

function runningChat(sessionId: SessionId, name: string): SessionListEntry {
  return {
    sessionId,
    name,
    shape: "chat",
    documentCount: 0,
    state: "active",
    activity: "running",
    activityRenewedAt: OBSERVED_AT,
    muted: false,
    lastActivityAt: OBSERVED_AT,
  };
}

/**
 * The inventory, with each binding's newest answered `mcp.setEnabled` and every answered tool
 * override set and clear applied in the order they landed.
 */
function answerMcpList(
  _request: unknown,
  _settledAtMilliseconds: number,
  _computedReplyOrdinal: number,
  answeredRequestsFor: AnsweredRequests,
): McpListResponse {
  const writes = answeredRequestsFor("mcp.setEnabled");
  const toolWrites = answeredRequestsFor("mcp.setToolOverride", "mcp.clearToolOverride");
  return {
    servers: MCP_INVENTORY.map((entry) => {
      const newestWrite = writes.findLast(
        (request) => scriptedServerAddressedBy(request) === entry,
      );
      const enabled = enablementOf(newestWrite);
      const switched = enabled === undefined ? entry : { ...entry, enabled };
      return toolWrites
        .filter((request) => scriptedServerAddressedBy(request) === entry)
        .reduce(withToolWriteApplied, switched);
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

/**
 * The inventory row a `mcp.setToolOverride` or `mcp.clearToolOverride` request addresses, with the
 * write applied and each facet it touched graded as the provider takes it. A request naming no
 * scripted row settles as an unscripted call does.
 */
function answerMcpToolWrite(request: unknown): McpToolOverrideMutationResult | undefined {
  const server = scriptedServerAddressedBy(request);
  if (server === undefined) {
    return undefined;
  }
  const write = toolWriteOf(request);
  const touched = MCP_TOOL_OVERRIDE_FACETS.filter((facet) =>
    "facet" in write ? write.facet === facet : write.override[facet] !== undefined,
  );
  return { server: withToolWriteApplied(server, request), applied: applicationOf(server, touched) };
}

/**
 * Where each touched facet takes effect: Claude Code's at the service's own approval layer at once,
 * Codex's switch and approval mode in its own settings, and an interrupted-call class always at
 * once.
 */
function applicationOf(
  entry: McpServerInventoryEntry,
  facets: readonly McpToolOverrideFacet[],
): McpToolOverrideApplication {
  const providerGrade: McpApplicationGrade =
    entry.provider === "claude" ? "daemon_enforced" : "user_config_write";
  return {
    ...(facets.includes("enabled") ? { enabled: providerGrade } : {}),
    ...(facets.includes("approvalMode") ? { approvalMode: providerGrade } : {}),
    ...(facets.includes("idempotencyClass") ? { idempotencyClass: "daemon_enforced" } : {}),
  };
}

/**
 * An answered tool write as the page sent it. `callDaemon` sends only a request its method's
 * schema accepts, so a request the playback answered for either call has that call's shape.
 */
function toolWriteOf(request: unknown): McpSetToolOverrideRequest | McpClearToolOverrideRequest {
  return request as McpSetToolOverrideRequest | McpClearToolOverrideRequest;
}

/**
 * A row with one answered tool write applied to the tool it names: each facet a set names reads
 * set here over the server's own value, the facet a clear names reads the server's own value
 * again, and every other facet stands.
 */
function withToolWriteApplied(
  entry: McpServerInventoryEntry,
  request: unknown,
): McpServerInventoryEntry {
  if (entry.bindingStoreUnavailable === true) {
    return entry;
  }
  const write = toolWriteOf(request);
  const toolName = "facet" in write ? write.toolName : write.override.toolName;
  const written = <OverrideValue, ServerValue>(
    facet: McpToolOverrideFacet,
    setting: McpToolSetting<OverrideValue, ServerValue>,
    setValue: OverrideValue | undefined,
  ): McpToolSetting<OverrideValue, ServerValue> => {
    const serverValue = setting.source === "server" ? setting.value : setting.serverValue;
    if ("facet" in write) {
      return write.facet === facet ? { source: "server", value: serverValue } : setting;
    }
    return setValue === undefined ? setting : { source: "override", value: setValue, serverValue };
  };
  const override = "facet" in write ? undefined : write.override;
  return {
    ...entry,
    tools: entry.tools.map(
      (tool): McpToolReading =>
        tool.toolName === toolName
          ? {
              ...tool,
              enabled: written("enabled", tool.enabled, override?.enabled),
              approvalMode: written("approvalMode", tool.approvalMode, override?.approvalMode),
              idempotencyClass: written(
                "idempotencyClass",
                tool.idempotencyClass,
                override?.idempotencyClass,
              ),
            }
          : tool,
    ),
  };
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
      entry.provider === readMember(request, "provider") &&
      entry.scope === readMember(request, "scope") &&
      entry.serverName === readMember(request, "serverName") &&
      (entry.scope === "user" ? undefined : entry.scopeRef) === readMember(request, "scopeRef"),
  );
}

/** The enablement a request or override asked for, or `undefined` for none. */
function enablementOf(request: unknown): boolean | undefined {
  const enabled = readMember(request, "enabled");
  return typeof enabled === "boolean" ? enabled : undefined;
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

/**
 * A device-code sign-in whose attempt id is minted from the answer's ordinal, its code good for a
 * quarter of an hour from the answer.
 */
function answerSignIn(
  _request: unknown,
  settledAtMilliseconds: number,
  computedReplyOrdinal: number,
): ProviderAccountLoginResponse {
  return {
    attemptId: signInAttemptId(computedReplyOrdinal),
    verificationUri: "https://provider.example.test/device",
    userCode: "WXYZ-1234",
    expiresAt: new Date(settledAtMilliseconds + SIGN_IN_CODE_LIFETIME_MS).toISOString(),
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
          kind: "login_completed",
          attemptId,
          accountId: account.accountId,
          outcome: "failed",
          failureReason: "The device code expired before it was entered.",
        }
      : { kind: "login_completed", attemptId, accountId: account.accountId, outcome: "succeeded" };
  return [
    {
      stream: "providerAccount.subscribe",
      afterMs: SIGN_IN_FINISHES_AFTER_MS,
      payloadAtDelivery: (answeredRequestsFor) =>
        answeredRequestsFor("providerAccount.loginCancel").some(
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
 * The named account made its provider's default, or the daemon's refusal where its login is gone,
 * carrying that account's own remedy; nothing moves on a refusal. A request naming no scripted
 * account settles as an unscripted call does.
 */
function answerSetCurrent(
  request: unknown,
  settledAtMilliseconds: number,
  _computedReplyOrdinal: number,
  answeredRequestsFor: AnsweredRequests,
): ProviderAccountSetCurrentResponse | undefined {
  const account = accountNamedBy(
    request,
    currentAccounts(answeredRequestsFor, settledAtMilliseconds),
  );
  if (account === undefined) {
    return undefined;
  }
  if (account.healthState === "reauth_required" || account.healthState === "home_missing") {
    const details: ProviderAccountNotAuthenticatedDetails = { remedy: loginRemedyFor(account) };
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
 * then each answered default move takes the mark from the provider's other accounts.
 */
function currentAccounts(
  answeredRequestsFor: AnsweredRequests,
  observedAtMilliseconds: number,
): readonly ProviderAccount[] {
  const resupplies = answeredRequestsFor("providerAccount.register").filter(
    (request) => readMember(request, "accountId") !== undefined,
  );
  const resupplied = SCRIPTED_ACCOUNTS.map((account) => {
    const count = resupplies.filter(
      (request) => readMember(request, "accountId") === account.accountId,
    ).length;
    return count === 0
      ? account
      : {
          ...account,
          credentialGeneration: account.credentialGeneration + count,
          healthState: "authenticated" as const,
          healthObservedAt: new Date(observedAtMilliseconds).toISOString(),
        };
  });
  return answeredRequestsFor("providerAccount.setCurrent").reduce<readonly ProviderAccount[]>(
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

/** One provider's readiness, resolved to its default account the way the daemon resolves it. */
function readinessOf(
  provider: ProviderName,
  accounts: readonly ProviderAccount[],
): ProviderReadiness {
  const providerAccounts = accounts.filter((account) => account.provider === provider);
  if (providerAccounts.length === 0) {
    return { provider, state: "no_account", remedy: { kind: "register", provider } };
  }
  const resolved = providerAccounts.find((account) => account.isDefault);
  if (resolved === undefined) {
    return {
      provider,
      state: "no_default",
      remedy: {
        kind: "choose_default",
        candidateAccountIds: providerAccounts.map((account) => account.accountId),
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
    case "reauth_required":
    case "home_missing":
      return { ...entry, state: resolved.healthState, remedy: loginRemedyFor(resolved) };
    case "indeterminate":
      return {
        ...entry,
        state: "indeterminate",
        remedy: { kind: "look_again", accountId: resolved.accountId },
      };
  }
}

/**
 * The one way back for an account whose login is gone: a token or API-key account cannot refresh
 * itself, so a fresh token is pasted; every other account signs in again through the provider.
 */
function loginRemedyFor(account: ProviderAccount): ProviderLoginExpiredRemedy {
  const isPastedCredential =
    account.observedAuthMode === "oauth_token" || account.observedAuthMode === "api_key";
  return isPastedCredential && account.healthState === "reauth_required"
    ? { kind: "paste_token", accountId: account.accountId }
    : { kind: "sign_in", accountId: account.accountId };
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
      // Nothing has observed an account registered a moment ago.
      healthState: "indeterminate",
      healthObservedAt: null,
    },
  };
}
