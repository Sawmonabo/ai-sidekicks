// What the MCP servers settings page is answered with: the machine's MCP inventory, the public
// registry's search, and the calls the page's controls send. The inventory is the machine's, not a
// session's, so a scenario that plays a session spreads these into its own replies.
//
// The inventory holds the rows the page must draw: a connected binding whose tools read the
// server's own settings beside ones set here, one needing authorization while one of its legs is
// fine, one whose binding store could not be read, and a project's shared copy of that last one's
// name, which the project does not use because its own copy takes its place.
//
// The page's writes behave as the daemon's do, each announced on `mcp.subscribe`: an added server
// reads back as a row of its own and a changed one with its new declaration, values left out as
// the daemon leaves them out; a removed one reads back gone; a switched binding reads back
// switched; a tool's facet reads back set here or, once cleared, the server's own. A reconnect
// answers each leg it names as it stands, and a search answers the registry's servers whose name,
// title or description holds what was typed.

import {
  MCP_TOOL_OVERRIDE_FACETS,
  type McpApplicationGrade,
  type McpRegistryServer,
  type McpRegistrySearchResponse,
  type McpServerBindingId,
  type McpServerBindingRef,
  type McpServerConfigChangedNotice,
  type McpServerConfigInput,
  type McpServerConfigView,
  type McpServerDeleteResponse,
  type McpServerInventoryEntry,
  type McpServerListResponse,
  type McpServerMutationResponse,
  type McpServerReconnectResponse,
  type McpServerSignInResponse,
  type McpServerUpsertRequest,
  type McpToolOverrideApplication,
  type McpToolOverrideClearRequest,
  type McpToolOverrideFacet,
  type McpToolOverrideMutationResponse,
  type McpToolOverrideUpdateRequest,
  type McpToolReading,
} from "@ai-sidekicks/contracts/mcp/server";
import type { RuntimeBindingId } from "@ai-sidekicks/contracts/provider/driver/runtime-binding";
import type { ProviderId } from "@ai-sidekicks/contracts/provider/id";
import type { SubscriptionId } from "@ai-sidekicks/contracts/jsonrpc/streaming";
import type {
  SessionListEntry,
  SessionSubscribeResponse,
} from "@ai-sidekicks/contracts/session/directory";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import type {
  AnsweredRequests,
  ScenarioNotice,
  ScenarioOpeningNotice,
  ScenarioReply,
} from "#renderer/services/daemon/scenario/reply.fixture.js";
import { readMember, readString } from "./requests.js";

const OBSERVED_AT = "2026-01-01T08:55:00.000Z";
const SESSION_A = "019b79ee-0280-75e5-8510-ada11a5a21a5" as SessionId;
const SESSION_B = "019b79ee-0280-75e5-8510-ada11a5a22a5" as SessionId;
const CLAUDE = "claude" as ProviderId;
const CODEX = "codex" as ProviderId;

const MCP_INVENTORY: readonly McpServerInventoryEntry[] = [
  {
    provider: CLAUDE,
    scope: "user",
    serverName: "filesystem",
    serverBindingId: "1".repeat(64) as McpServerBindingId,
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
          serverValue: "manualReconcileOnly",
        },
      },
      {
        toolName: "write_file",
        enabled: { value: true, source: "server" },
        approvalMode: { value: "prompt", source: "override", serverValue: "auto" },
        idempotencyClass: {
          value: "compensable",
          source: "override",
          serverValue: "manualReconcileOnly",
        },
      },
    ],
  },
  {
    provider: CODEX,
    scope: "project",
    scopeRef: "/work/sidekicks",
    serverName: "issue-tracker",
    serverBindingId: "2".repeat(64) as McpServerBindingId,
    config: {
      transport: "http",
      url: "https://issues.example.test/mcp",
      headerNames: ["X-Workspace"],
      bearerTokenEnvVar: "ISSUES_TOKEN",
    },
    status: "needsAuth",
    observedAt: OBSERVED_AT,
    legs: [
      {
        sessionId: SESSION_A,
        bindingId: "leg-a" as RuntimeBindingId,
        status: "needsAuth",
        observedAt: OBSERVED_AT,
      },
      { sessionId: SESSION_B, bindingId: "leg-b" as RuntimeBindingId, status: "connected" },
    ],
    enabled: true,
    tools: [
      {
        toolName: "create_issue",
        enabled: { value: true, source: "server" },
        approvalMode: { value: "writes", source: "server" },
        idempotencyClass: { value: "manualReconcileOnly", source: "server" },
      },
    ],
  },
  {
    provider: CLAUDE,
    scope: "local",
    scopeRef: "/work/sidekicks",
    serverName: "scratchpad",
    serverBindingId: "3".repeat(64) as McpServerBindingId,
    config: { transport: "stdio", command: "./scripts/scratchpad-mcp" },
    status: "unknown",
    bindingStoreUnavailable: true,
  },
  {
    provider: CLAUDE,
    scope: "project",
    scopeRef: "/work/sidekicks",
    serverName: "scratchpad",
    serverBindingId: "4".repeat(64) as McpServerBindingId,
    config: { transport: "stdio", command: "npx", args: ["-y", "scratchpad-mcp"] },
    status: "unknown",
    supersededIn: [{ path: "/work/sidekicks" }],
    enabled: true,
    tools: [],
  },
];

/**
 * The registry's servers a search can find: one run as a package that reads a secret variable, and
 * one reached at an address whose header the person fills.
 */
const REGISTRY_SERVERS: readonly McpRegistryServer[] = [
  {
    name: "io.example/weather",
    title: "Weather",
    description: "Current conditions and forecasts for a place.",
    version: "1.4.0",
    packages: [
      {
        registryType: "npm",
        identifier: "@example/weather-mcp",
        version: "1.4.0",
        runtimeHint: "npx",
      },
    ],
    environmentVariables: [
      {
        name: "WEATHER_API_KEY",
        description: "The forecast service's key.",
        isRequired: true,
        isSecret: true,
      },
    ],
  },
  {
    name: "io.example/notes",
    title: "Notes",
    description: "Reads and writes notes in a shared notebook.",
    version: "0.9.2",
    remotes: [
      {
        type: "streamable-http",
        url: "https://notes.example.test/mcp",
        headers: [{ name: "Authorization", isRequired: true, isSecret: true }],
      },
    ],
    environmentVariables: [],
  },
];

/** Every call the MCP servers page makes, and what each is answered with. */
export const MCP_SERVER_REPLIES: readonly ScenarioReply[] = [
  // Computed, so a server added, changed, removed or switched earlier reads back that way.
  { call: "mcp.server.list", resultFor: answerMcpList },
  // Computed, so the row that was pressed is the row the answer names.
  {
    call: "mcp.server.enabled.update",
    afterMs: 200,
    resultFor: answerMcpSetEnabled,
    noticesFor: announceMcpEdit,
  },
  // Computed, so the tool that was pressed is the tool the answer names, each facet set here.
  {
    call: "mcp.toolOverride.update",
    afterMs: 200,
    resultFor: answerMcpToolWrite,
    noticesFor: announceMcpEdit,
  },
  // Computed, so the facet cleared reads the server's own and the tool's others stand.
  {
    call: "mcp.toolOverride.clear",
    afterMs: 200,
    resultFor: answerMcpToolWrite,
    noticesFor: announceMcpEdit,
  },
  // The server needing authorization hands back the page its provider opens in the browser.
  {
    call: "mcp.server.signIn",
    afterMs: 200,
    result: {
      authorizationUrl: "https://issues.example.test/authorize",
    } satisfies McpServerSignInResponse,
  },
  // Computed, so the row answered is the one the form described.
  {
    call: "mcp.server.upsert",
    afterMs: 200,
    resultFor: answerMcpUpsert,
    noticesFor: announceMcpEdit,
  },
  // Computed, so only a row the inventory holds is removed.
  {
    call: "mcp.server.delete",
    afterMs: 200,
    resultFor: answerMcpDelete,
    noticesFor: announceMcpEdit,
  },
  // Computed, so the legs answered are the pressed row's.
  { call: "mcp.server.reconnect", afterMs: 200, resultFor: answerMcpReconnect },
  // Computed, so the servers answered are the ones the query names.
  { call: "mcp.registry.search", afterMs: 200, resultFor: answerRegistrySearch },
];

/**
 * The frame `session.subscribe` opens with: the list as it stands, naming the two running sessions
 * the inventory's legs belong to, both chats, so the daemon counts two.
 */
export const SESSION_LIST_OPENING_NOTICES: readonly ScenarioOpeningNotice[] = [
  {
    stream: "session.subscribe",
    payloadAtOpen: (): SessionSubscribeResponse => ({
      subscriptionId: "019b79ee-0280-7d11-8510-ada11a5a2300" as SubscriptionId,
      sessions: [
        runningChat(SESSION_A, "Fix login"),
        runningChat(SESSION_B, "Refresh-token expiry"),
      ],
      chatCount: 2,
      isComplete: true,
    }),
  },
];

function runningChat(sessionId: SessionId, name: string): SessionListEntry {
  return {
    sessionId,
    name,
    shape: "chat",
    state: "active",
    activity: "running",
    activityRenewedAt: OBSERVED_AT,
    muted: false,
    lastActivityAt: OBSERVED_AT,
  };
}

/**
 * The inventory, with each answered add, change and removal applied in the order they landed,
 * then each row's newest answered `mcp.server.enabled.update` and every answered tool override
 * update and clear in the order they landed.
 */
function answerMcpList(
  _request: unknown,
  _settledAtMilliseconds: number,
  _computedReplyOrdinal: number,
  answeredRequestsFor: AnsweredRequests,
): McpServerListResponse {
  const writes = answeredRequestsFor("mcp.server.enabled.update");
  const toolWrites = answeredRequestsFor("mcp.toolOverride.update", "mcp.toolOverride.clear");
  return {
    servers: declaredInventory(answeredRequestsFor).map((entry) => {
      const newestWrite = writes.findLast((request) => isAddressedBy(entry, request));
      const enabled = enablementOf(newestWrite);
      const switched = enabled === undefined ? entry : { ...entry, enabled };
      return toolWrites
        .filter((request) => isAddressedBy(entry, request))
        .reduce(withToolWriteApplied, switched);
    }),
    failedProviders: [],
  };
}

/**
 * The scripted inventory with each answered `mcp.server.upsert` and `mcp.server.delete` applied in
 * the order they landed: an upsert carries a declaration and a removal does not.
 */
function declaredInventory(
  answeredRequestsFor: AnsweredRequests,
): readonly McpServerInventoryEntry[] {
  return answeredRequestsFor("mcp.server.upsert", "mcp.server.delete").reduce<
    readonly McpServerInventoryEntry[]
  >((inventory, request) => {
    if (readMember(request, "config") === undefined) {
      return inventory.filter((entry) => !isAddressedBy(entry, request));
    }
    const upsert = upsertOf(request);
    const standing = inventory.find((entry) => isAddressedBy(entry, request));
    const upserted = upsertedRow(standing, upsert);
    return standing === undefined
      ? [...inventory, upserted]
      : inventory.map((entry) => (entry === standing ? upserted : entry));
  }, MCP_INVENTORY);
}

/**
 * The row an upsert leaves: the standing row with its new declaration, or a new row for a name the
 * scope does not hold yet, not yet observed and with no tools read.
 */
function upsertedRow(
  standing: McpServerInventoryEntry | undefined,
  upsert: McpServerUpsertRequest,
): McpServerInventoryEntry {
  const config = configViewOf(upsert.config);
  const enabled = upsert.config.enabled;
  if (standing !== undefined) {
    return standing.bindingStoreUnavailable === true || enabled === undefined
      ? { ...standing, config }
      : { ...standing, config, enabled };
  }
  // The request's own scope and reference, so the row is one of the request's arms.
  return {
    ...bindingRefOf(upsert),
    serverBindingId: mintedBindingId(upsert),
    config,
    status: "unknown",
    enabled: enabled ?? true,
    tools: [],
  } as McpServerInventoryEntry;
}

/**
 * A submitted declaration as the daemon reads it back: names only for the environment and the
 * headers, and a member the request removed with `null` absent. Cast because each input arm with
 * those members renamed is its transport's view arm.
 */
function configViewOf(config: McpServerConfigInput): McpServerConfigView {
  if (config.transport === "stdio") {
    const { env, envVars, ...declared } = config;
    const envVarNames = [...Object.keys(env ?? {}), ...(envVars ?? [])];
    return {
      ...membersPresentIn(declared),
      ...(envVarNames.length === 0 ? {} : { envVarNames }),
    } as McpServerConfigView;
  }
  const { headers, ...declared } = config;
  const headerNames = Object.keys(headers ?? {});
  return {
    ...membersPresentIn(declared),
    ...(headerNames.length === 0 ? {} : { headerNames }),
  } as McpServerConfigView;
}

/** A record without the members a request set to `null`, which removes them. */
function membersPresentIn(record: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== null));
}

/**
 * The answered upsert as the page sent it. `callDaemon` sends only a request its method's check
 * accepts, so a request the playback answered has that call's shape.
 */
function upsertOf(request: unknown): McpServerUpsertRequest {
  return request as McpServerUpsertRequest;
}

/** The row an upsert leaves, applied where it takes effect: the provider's next run. */
function answerMcpUpsert(
  request: unknown,
  _settledAtMilliseconds: number,
  _computedReplyOrdinal: number,
  answeredRequestsFor: AnsweredRequests,
): McpServerMutationResponse {
  const standing = declaredInventory(answeredRequestsFor).find((entry) =>
    isAddressedBy(entry, request),
  );
  return { server: upsertedRow(standing, upsertOf(request)), applied: "nextRun" };
}

/**
 * The removal of a row the inventory holds, applied at the provider's next run, or `undefined` for
 * a request naming none, which settles as an unscripted call does.
 */
function answerMcpDelete(
  request: unknown,
  _settledAtMilliseconds: number,
  _computedReplyOrdinal: number,
  answeredRequestsFor: AnsweredRequests,
): McpServerDeleteResponse | undefined {
  const standing = declaredInventory(answeredRequestsFor).find((entry) =>
    isAddressedBy(entry, request),
  );
  return standing === undefined ? undefined : { applied: "nextRun" };
}

/**
 * Each live leg of the addressed row the request names, all of them when it names no session or
 * leg, as it stands, or `undefined` for a request naming no row, which settles as an unscripted
 * call does.
 */
function answerMcpReconnect(
  request: unknown,
  _settledAtMilliseconds: number,
  _computedReplyOrdinal: number,
  answeredRequestsFor: AnsweredRequests,
): McpServerReconnectResponse | undefined {
  const standing = declaredInventory(answeredRequestsFor).find((entry) =>
    isAddressedBy(entry, request),
  );
  if (standing === undefined) {
    return undefined;
  }
  const sessionId = readMember(request, "sessionId");
  const bindingId = readMember(request, "bindingId");
  return {
    legs: (standing.legs ?? []).filter(
      (leg) =>
        (sessionId === undefined || leg.sessionId === sessionId) &&
        (bindingId === undefined || leg.bindingId === bindingId),
    ),
  };
}

/** The registry's servers whose name, title or description holds the query, in any case. */
function answerRegistrySearch(request: unknown): McpRegistrySearchResponse {
  const query = readString(request, "query").toLowerCase();
  return {
    servers: REGISTRY_SERVERS.filter((server) =>
      [server.name, server.title ?? "", server.description].some((text) =>
        text.toLowerCase().includes(query),
      ),
    ),
  };
}

/**
 * The inventory row a `mcp.server.enabled.update` request addresses, with the enablement it asked
 * for, or `undefined` for a request naming no row, which settles as an unscripted call does.
 */
function answerMcpSetEnabled(
  request: unknown,
  _settledAtMilliseconds: number,
  _computedReplyOrdinal: number,
  answeredRequestsFor: AnsweredRequests,
): McpServerMutationResponse | undefined {
  const server = declaredInventory(answeredRequestsFor).find((entry) =>
    isAddressedBy(entry, request),
  );
  const enabled = enablementOf(request);
  if (server === undefined || enabled === undefined) {
    return undefined;
  }
  return { server: { ...server, enabled }, applied: "nextRun" };
}

/**
 * The inventory row a `mcp.toolOverride.update` or `mcp.toolOverride.clear` request addresses,
 * with the write applied and each facet it touched graded as the provider takes it. A request
 * naming no row settles as an unscripted call does.
 */
function answerMcpToolWrite(
  request: unknown,
  _settledAtMilliseconds: number,
  _computedReplyOrdinal: number,
  answeredRequestsFor: AnsweredRequests,
): McpToolOverrideMutationResponse | undefined {
  const server = declaredInventory(answeredRequestsFor).find((entry) =>
    isAddressedBy(entry, request),
  );
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
    entry.provider === CLAUDE ? "daemonEnforced" : "userConfigWrite";
  return {
    ...(facets.includes("enabled") ? { enabled: providerGrade } : {}),
    ...(facets.includes("approvalMode") ? { approvalMode: providerGrade } : {}),
    ...(facets.includes("idempotencyClass") ? { idempotencyClass: "daemonEnforced" } : {}),
  };
}

/**
 * An answered tool write as the page sent it. `callDaemon` sends only a request its method's
 * check accepts, so a request the playback answered for either call has that call's shape.
 */
function toolWriteOf(request: unknown): McpToolOverrideUpdateRequest | McpToolOverrideClearRequest {
  return request as McpToolOverrideUpdateRequest | McpToolOverrideClearRequest;
}

/**
 * A row with one answered tool write applied to the tool it names: each facet an update names
 * reads set here over the server's own value, the facet a clear names reads the server's own
 * value again, and every other facet stands.
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
  const override = "facet" in write ? undefined : write.override;
  const written = <Setting extends McpToolReading[McpToolOverrideFacet]>(
    facet: McpToolOverrideFacet,
    setting: Setting,
    setValue: Setting["value"] | undefined,
  ): Setting => {
    const serverValue = setting.source === "server" ? setting.value : setting.serverValue;
    if ("facet" in write) {
      return (
        write.facet === facet ? { source: "server", value: serverValue } : setting
      ) as Setting;
    }
    return (
      setValue === undefined ? setting : { source: "override", value: setValue, serverValue }
    ) as Setting;
  };
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

/** The edit notice the daemon sends once it has applied a change to the binding a request names. */
function announceMcpEdit(request: unknown): readonly ScenarioNotice[] {
  const payload: McpServerConfigChangedNotice = {
    ...bindingRefOf(request as McpServerBindingRef),
    type: "mcp.server.config.changed",
  };
  return [{ stream: "mcp.subscribe", afterMs: 0, payloadAtDelivery: () => payload }];
}

/** Whether a request's binding fields address the row. */
function isAddressedBy(entry: McpServerInventoryEntry, request: unknown): boolean {
  return (
    entry.provider === readMember(request, "provider") &&
    entry.scope === readMember(request, "scope") &&
    entry.serverName === readMember(request, "serverName") &&
    scopeRefOf(entry) === readMember(request, "scopeRef")
  );
}

/** The scope reference a binding's scope carries, or `undefined` for a scope that names none. */
function scopeRefOf(binding: McpServerBindingRef): string | undefined {
  return "scopeRef" in binding ? binding.scopeRef : undefined;
}

/**
 * An added binding's id, the same for every request naming it and, as the daemon's is, holding no
 * path: its address hashed (FNV-1a) into hex.
 */
function mintedBindingId(binding: McpServerBindingRef): McpServerBindingId {
  const address = [binding.provider, binding.scope, scopeRefOf(binding) ?? "", binding.serverName];
  let hash = 0x811c9dc5;
  for (const character of address.join(":")) {
    hash = Math.imul(hash ^ (character.codePointAt(0) ?? 0), 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(64, "0") as McpServerBindingId;
}

/** The enablement a request or override asked for, or `undefined` for none. */
function enablementOf(request: unknown): boolean | undefined {
  const enabled = readMember(request, "enabled");
  return typeof enabled === "boolean" ? enabled : undefined;
}

/** A binding's address alone, as a notice carries it. */
function bindingRefOf(binding: McpServerBindingRef): McpServerBindingRef {
  const { provider, scope, serverName } = binding;
  const scopeRef = scopeRefOf(binding);
  // The binding's own scope and reference, so the address is one of the binding's own arms.
  return (
    scopeRef === undefined
      ? { provider, scope, serverName }
      : { provider, scope, scopeRef, serverName }
  ) as McpServerBindingRef;
}
