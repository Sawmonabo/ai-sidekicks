/**
 * Claude driver tool metadata: the declared tool catalog, and the step that gives every entry an
 * `idempotency_class`: whether a call may safely be repeated, shown on Settings › MCP servers.
 *
 * - The default is structural: an unannotated or unrecognized class (untyped ingress such as
 *   MCP-discovered tools) takes `manual_reconcile_only`, and `closeToolIdempotencyClass` is the
 *   only constructor of a `NormalizedProviderToolMetadata` here.
 * - Only pure reads of local state are `idempotent`; a wrongly permissive class tells the person
 *   a repeat is safe when it is not.
 * - No entry is `compensable` (no built-in tool accepts a `dedupe_key`) or carries a `description`
 *   (that column holds the provider's own).
 */

import type {
  IdempotencyClass,
  McpServerStatus,
  NormalizedProviderToolMetadata,
  ProviderToolMetadata,
} from "@ai-sidekicks/contracts/provider-driver";

import {
  boundMcpServerStatusEmission,
  type McpServerStatusIngestRejection,
  type McpServerStatusIngestResult,
} from "../mcp-server-status-ingest.js";
import type { McpServerStatusEmission } from "../../provider-driver.js";

/** The class an unannotated tool takes: a repeat is for the person to judge. */
const DEFAULT_CLAUDE_TOOL_IDEMPOTENCY_CLASS: IdempotencyClass = "manual_reconcile_only";

/** The closed `idempotency_class` vocabulary, for runtime recognition. */
const RECOGNIZED_IDEMPOTENCY_CLASSES: readonly IdempotencyClass[] = [
  "idempotent",
  "compensable",
  "manual_reconcile_only",
];

function isRecognizedIdempotencyClass(value: unknown): value is IdempotencyClass {
  return (
    typeof value === "string" &&
    (RECOGNIZED_IDEMPOTENCY_CLASSES as readonly string[]).includes(value)
  );
}

/**
 * Closes one declaration's `idempotency_class`: absent or unrecognized takes the floor rather than
 * throwing, since untyped ingress can carry one. Returns a new object; the input is not mutated.
 */
export function closeToolIdempotencyClass(
  declaration: ProviderToolMetadata,
): NormalizedProviderToolMetadata {
  const idempotencyClass: IdempotencyClass = isRecognizedIdempotencyClass(
    declaration.idempotency_class,
  )
    ? declaration.idempotency_class
    : DEFAULT_CLAUDE_TOOL_IDEMPOTENCY_CLASS;
  if (declaration.description !== undefined) {
    return {
      name: declaration.name,
      idempotency_class: idempotencyClass,
      description: declaration.description,
    };
  }
  return { name: declaration.name, idempotency_class: idempotencyClass };
}

/** Closes a whole declaration table. See {@link closeToolIdempotencyClass}. */
function closeToolIdempotencyClasses(
  declarations: readonly ProviderToolMetadata[],
): NormalizedProviderToolMetadata[] {
  return declarations.map((declaration) => closeToolIdempotencyClass(declaration));
}

/**
 * The tools Claude Code carries itself, in its own names, as a person picks them for an agent's
 * tool allowlist. Separate from the class declarations, which name what a transcript reports.
 */
export const CLAUDE_BUILT_IN_TOOLS: readonly string[] = Object.freeze([
  "Read",
  "Edit",
  "Write",
  "Bash",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "Agent",
]);

/**
 * The Claude driver's raw tool declarations, where omitting `idempotency_class` is the normal case.
 */
const CLAUDE_TOOL_DECLARATIONS: readonly ProviderToolMetadata[] = Object.freeze(
  (
    [
      // Pure local reads: nothing observable changes, so a repeated call is safe.
      { name: "Read", idempotency_class: "idempotent" },
      { name: "Glob", idempotency_class: "idempotent" },
      { name: "Grep", idempotency_class: "idempotent" },

      // Unannotated on purpose: the daemon cannot establish that a repeat is safe.
      { name: "Bash" },
      { name: "Write" },
      { name: "Edit" },
      { name: "NotebookEdit" },
      { name: "WebFetch" },
      { name: "WebSearch" },
      { name: "TodoWrite" },
      { name: "Task" },
    ] satisfies readonly ProviderToolMetadata[]
  ).map((declaration) => Object.freeze(declaration)),
);

/**
 * The tool catalog `getCapabilities()` reports, class-closed and frozen at both levels; callers
 * building a `GetCapabilitiesResult` use {@link getClaudeToolMetadata}.
 */
export const CLAUDE_TOOL_CATALOG: readonly NormalizedProviderToolMetadata[] = Object.freeze(
  closeToolIdempotencyClasses(CLAUDE_TOOL_DECLARATIONS).map((tool) => Object.freeze(tool)),
);

/** A fresh, mutable copy of the catalog, since `GetCapabilitiesResult.tools` is mutable. */
export function getClaudeToolMetadata(): NormalizedProviderToolMetadata[] {
  return CLAUDE_TOOL_CATALOG.map((tool) => ({ ...tool }));
}

/**
 * Recognized Claude status tokens mapped to the unified enum, looked up lower-cased with `-` and
 * whitespace collapsed (`needs_auth` is the init census spelling). `disabled` and any unrecognized
 * token map to `unknown`, never a healthy state, because the wire census does not pin the set.
 */
const CLAUDE_STATUS_TOKEN_MAP: Readonly<Record<string, McpServerStatus>> = {
  connected: "connected",
  failed: "failed",
  "failed to connect": "failed",
  "needs authentication": "needs-auth",
  needs_auth: "needs-auth",
  pending: "starting",
  starting: "starting",
  disabled: "unknown",
};

/** Canonicalizes a raw status token for map lookup, never for emission. */
function canonicalizeClaudeStatusToken(rawToken: string): string {
  return rawToken
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/g, " ");
}

function mapClaudeStatusToken(rawToken: unknown): McpServerStatus {
  if (typeof rawToken !== "string") {
    return "unknown";
  }
  const canonical = canonicalizeClaudeStatusToken(rawToken);
  return CLAUDE_STATUS_TOKEN_MAP[canonical] ?? "unknown";
}

/**
 * Normalizes the `system/init` `mcp_servers[]` census: a non-object row is one rejection and a
 * non-array input one rejection with no emissions. Server names are untrusted CLI output, so each
 * emission goes through `boundMcpServerStatusEmission`.
 */
export function normalizeClaudeMcpServerInitCensus(
  rawServers: unknown,
): McpServerStatusIngestResult {
  if (!Array.isArray(rawServers)) {
    return {
      emissions: [],
      rejections: [
        { reason: "system/init mcp_servers is not an array; census skipped for this session." },
      ],
    };
  }
  const emissions: McpServerStatusEmission[] = [];
  const rejections: McpServerStatusIngestRejection[] = [];
  for (const rawServer of rawServers) {
    if (typeof rawServer !== "object" || rawServer === null) {
      rejections.push({ reason: "system/init mcp_servers row is not an object; row skipped." });
      continue;
    }
    const row = rawServer as Record<string, unknown>;
    const bounded = boundMcpServerStatusEmission(row["name"], mapClaudeStatusToken(row["status"]));
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
 * Normalizes `claude mcp list` output (`<name>: <command> - <glyph> <status text>`; the CLI has no
 * `--json`), the zero-billed-turn status refresh. Lines without a `name:` prefix and a ` - `
 * separator are skipped without a rejection.
 */
export function normalizeClaudeMcpListProbeOutput(
  probeStdout: string,
): McpServerStatusIngestResult {
  const emissions: McpServerStatusEmission[] = [];
  const rejections: McpServerStatusIngestRejection[] = [];
  for (const line of probeStdout.split(/\r?\n/)) {
    const separatorIndex = line.lastIndexOf(" - ");
    const colonIndex = line.indexOf(":");
    if (separatorIndex === -1 || colonIndex === -1 || colonIndex >= separatorIndex) {
      continue;
    }
    const serverName = line.slice(0, colonIndex).trim();
    if (serverName.length === 0) {
      continue;
    }
    // Strip the leading status glyph so the token map reads words, not the symbol.
    const statusText = line
      .slice(separatorIndex + " - ".length)
      .replace(/^[^\p{L}\p{N}]+/u, "")
      .trim();
    const bounded = boundMcpServerStatusEmission(serverName, mapClaudeStatusToken(statusText));
    if (bounded.emission !== undefined) {
      emissions.push(bounded.emission);
    }
    if (bounded.rejection !== undefined) {
      rejections.push(bounded.rejection);
    }
  }
  return { emissions, rejections };
}
