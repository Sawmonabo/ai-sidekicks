// Per-tool metadata for the Codex driver, and its only source of a tool's `idempotency_class`, so
// crash recovery can dispatch on a class without asking the provider.
//
// - Tool names are `ThreadItem.type` discriminants: `codex app-server` (codex-cli 0.150.1)
//   publishes no list of model-facing tool names, and that type is all the daemon observes.
// - `closeCodexToolDeclaration` gives an unannotated entry the conservative floor; the mutating
//   tools are left unannotated on purpose. No built-in is `compensable`: that needs a remote
//   honoring a client idempotency key.
// - Left out: `mcpToolCall` and `dynamicToolCall` (their classes come from the MCP floor and the
//   session registry), `subAgentActivity`, and the message and lifecycle arms.

import type {
  IdempotencyClass,
  McpServerStatus,
  NormalizedProviderToolMetadata,
} from "@ai-sidekicks/contracts";

import {
  boundMcpServerStatusEmission,
  type McpServerStatusIngestRejection,
  type McpServerStatusIngestResult,
} from "../mcp-server-status-ingest.js";
import type { McpServerStatusEmission } from "../../provider-driver.js";

/** The class an unannotated Codex tool closes to. */
const DEFAULT_CODEX_TOOL_IDEMPOTENCY_CLASS: IdempotencyClass = "manual_reconcile_only";

/** Codex's own tools in the names a person picks for an agent's allowlist. */
export const CODEX_BUILT_IN_TOOLS: readonly string[] = Object.freeze([
  "shell",
  "apply_patch",
  "web_search",
]);

/** `ThreadItem.type` arms for an invocation whose crash-recovery disposition matters. */
const CODEX_TOOL_NAMES = [
  "commandExecution",
  "fileChange",
  "collabAgentToolCall",
  "imageGeneration",
  "webSearch",
  "imageView",
  "sleep",
] as const;

/** The closed union of Codex tool identities. */
export type CodexToolName = (typeof CODEX_TOOL_NAMES)[number];

/** `description` is required: an operator reconciling a halted receipt reads it. */
interface CodexToolDeclaration {
  readonly idempotency_class?: IdempotencyClass;
  readonly description: string;
}

const CODEX_TOOL_DECLARATIONS: Record<CodexToolName, CodexToolDeclaration> = {
  // Unannotated -> floor: an arbitrary shell command with an undeclared effect; the protocol
  // exposes no dedup handle for a re-run.
  commandExecution: {
    description: "Executes a shell command in the thread's working directory.",
  },
  // Unannotated -> floor: re-applying an already-applied patch corrupts the working tree.
  fileChange: {
    description: "Applies file creations, edits, and deletions to the working tree.",
  },
  // Unannotated -> floor: a replay duplicates another agent's run and its downstream effect.
  collabAgentToolCall: {
    description: "Spawns, messages, resumes, waits on, or closes a peer agent thread.",
  },
  // Unannotated -> floor: a billable remote generation whose replay yields a different artifact.
  imageGeneration: {
    description: "Generates an image through the provider's remote model.",
  },
  // Rationale: a read-only query against an external index; a replay changes nothing.
  webSearch: {
    idempotency_class: "idempotent",
    description: "Runs a read-only web search and returns results to the model.",
  },
  // Rationale: a pure read of a file into model context.
  imageView: {
    idempotency_class: "idempotent",
    description: "Reads an image file at a path into the model's context.",
  },
  // Rationale: a wall-clock delay with no effect; a replay costs time and nothing else.
  sleep: {
    idempotency_class: "idempotent",
    description: "Pauses the turn for a fixed duration.",
  },
};

function closeCodexToolDeclaration(
  name: CodexToolName,
  declaration: CodexToolDeclaration,
): NormalizedProviderToolMetadata {
  return {
    name,
    idempotency_class: declaration.idempotency_class ?? DEFAULT_CODEX_TOOL_IDEMPOTENCY_CLASS,
    description: declaration.description,
  };
}

/** The frozen, fully classified tool list; callers use {@link getCodexToolMetadata}. */
export const CODEX_TOOL_METADATA: readonly NormalizedProviderToolMetadata[] = Object.freeze(
  CODEX_TOOL_NAMES.map((name) =>
    Object.freeze(closeCodexToolDeclaration(name, CODEX_TOOL_DECLARATIONS[name])),
  ),
);

/** A fresh mutable copy: `GetCapabilitiesResult.tools` is mutable across the driver boundary. */
export function getCodexToolMetadata(): NormalizedProviderToolMetadata[] {
  return CODEX_TOOL_METADATA.map((tool) => ({ ...tool }));
}

// MCP server-status normalizers: status rows and notifications become the closed
// `McpServerStatus` enum, bounded because `serverName` is untrusted. Wire shapes are from
// codex-cli 0.150.1; `runtimeStatus` is null when unavailable or the configuration changed.

/**
 * `McpServerConnectionStatus` to the unified enum; unlisted is `unknown`. `cancelled` is `failed`
 * (startup ended without a connection); `disabled` is `unknown` (deliberately not running).
 */
const CODEX_CONNECTION_STATUS_MAP: Readonly<Record<string, McpServerStatus>> = {
  notStarted: "starting",
  starting: "starting",
  connected: "connected",
  authenticationRequired: "needs-auth",
  failed: "failed",
  cancelled: "failed",
  disabled: "unknown",
};

/** `McpServerStartupState` (startup notification `status`) to the unified enum. */
const CODEX_STARTUP_STATE_MAP: Readonly<Record<string, McpServerStatus>> = {
  starting: "starting",
  ready: "connected",
  failed: "failed",
  cancelled: "failed",
};

/**
 * Normalizes `mcpServerStatus/list` rows; a non-array yields one rejection. A null `runtimeStatus`
 * is `needs-auth` only for `authStatus` `notLoggedIn`, else `unknown` (other modes say nothing).
 *
 * @consumedBy the Codex driver's MCP server status reads
 */
export function normalizeCodexMcpServerStatusList(rawRows: unknown): McpServerStatusIngestResult {
  if (!Array.isArray(rawRows)) {
    return {
      emissions: [],
      rejections: [
        { reason: "mcpServerStatus/list data is not an array; census skipped for this read." },
      ],
    };
  }
  const emissions: McpServerStatusEmission[] = [];
  const rejections: McpServerStatusIngestRejection[] = [];
  for (const rawRow of rawRows) {
    if (typeof rawRow !== "object" || rawRow === null) {
      rejections.push({ reason: "mcpServerStatus/list row is not an object; row skipped." });
      continue;
    }
    const row = rawRow as Record<string, unknown>;
    const runtimeStatus = row["runtimeStatus"];
    let status: McpServerStatus;
    if (typeof runtimeStatus === "string") {
      status = CODEX_CONNECTION_STATUS_MAP[runtimeStatus] ?? "unknown";
    } else {
      status = row["authStatus"] === "notLoggedIn" ? "needs-auth" : "unknown";
    }
    const bounded = boundMcpServerStatusEmission(row["name"], status);
    if (bounded.emission !== undefined) {
      emissions.push(bounded.emission);
    }
    if (bounded.rejection !== undefined) {
      rejections.push(bounded.rejection);
    }
  }
  return { emissions, rejections };
}

/**
 * Normalizes one `mcpServer/startupStatus/updated` notification; a `failed` startup for
 * `reauthenticationRequired` becomes `needs-auth`, the one state a person can fix.
 *
 * @consumedBy the Codex driver's MCP server status reads
 */
export function normalizeCodexMcpServerStatusNotification(
  rawNotification: unknown,
): McpServerStatusIngestResult {
  if (typeof rawNotification !== "object" || rawNotification === null) {
    return {
      emissions: [],
      rejections: [
        { reason: "mcpServer/startupStatus/updated payload is not an object; update skipped." },
      ],
    };
  }
  const notification = rawNotification as Record<string, unknown>;
  const rawState = notification["status"];
  let status: McpServerStatus;
  if (typeof rawState === "string") {
    status = CODEX_STARTUP_STATE_MAP[rawState] ?? "unknown";
  } else {
    status = "unknown";
  }
  if (status === "failed" && notification["failureReason"] === "reauthenticationRequired") {
    status = "needs-auth";
  }
  const bounded = boundMcpServerStatusEmission(notification["name"], status);
  return {
    emissions: bounded.emission !== undefined ? [bounded.emission] : [],
    rejections: bounded.rejection !== undefined ? [bounded.rejection] : [],
  };
}
