/**
 * Claude driver tool metadata (Plan-005 T3.9).
 *
 * Owns the Claude driver's declared tool catalog and the CLOSING step that
 * makes every entry carry an `idempotency_class`. This module is the Claude
 * side of the recovery contract: `Spec-015` classifies a crash-interrupted
 * tool call by the class recorded on its `driver_tools` row, so an entry that
 * reaches the writer without a class would be classified by accident rather
 * than by declaration.
 *
 * ## I-005-3 — the conservative default is STRUCTURAL, not documentary
 *
 * `Spec-005 §Tool Metadata`: "If a driver does not declare `idempotency_class`
 * for a tool, the runtime MUST treat it as `manual_reconcile_only`." That rule
 * is realized here by {@link closeToolIdempotencyClass}, which is the ONLY
 * constructor of a {@link NormalizedProviderToolMetadata} in this module —
 * {@link CLAUDE_TOOL_CATALOG} is its output, never a hand-written literal. An
 * entry added to {@link CLAUDE_TOOL_DECLARATIONS} with no class therefore
 * lands at the floor by CONSTRUCTION; there is no path by which forgetting an
 * annotation produces a permissive class. The floor also survives an
 * unrecognized class (see the helper's own note), so untyped ingress — which
 * is what T3.13 routes MCP-discovered tools through — cannot widen a class by
 * shipping a value outside the vocabulary.
 *
 * The contract carries a SECOND, independent application of the same default:
 * `ProviderToolMetadataSchema` in `@ai-sidekicks/contracts` defaults the field
 * at the write seam. The two are deliberately redundant (defense in depth at
 * the driver boundary and at the persistence boundary), and neither is
 * evidence for the other — the tests in this directory assert THIS module's
 * closing, not the schema's.
 *
 * ## Classification discipline
 *
 * `Spec-005 §Tool Metadata` defines `idempotent` as a pure read (or a write
 * whose external target is server-side idempotent) and `manual_reconcile_only`
 * as the class that halts recovery for operator reconciliation. Only tools
 * whose effect is a pure read of local state are annotated `idempotent` here,
 * each with a one-line rationale. Everything else is left UNANNOTATED so the
 * floor applies — including the tools whose classification is merely
 * *plausible* (a session-local list write, an HTTP GET whose remote endpoint
 * may not be side-effect-free). An over-permissive class silently re-executes
 * an effect after a crash; the floor only costs an operator prompt.
 *
 * No entry is annotated `compensable`: that class requires a caller-supplied
 * `dedupe_key` the remote honors (`Spec-005 §Tool Metadata`), and no Claude
 * built-in tool accepts one. The vocabulary member is unused here by decision,
 * not by oversight.
 *
 * No entry carries a `description`: the column exists for the PROVIDER's own
 * tool description, and a sentence written here would be daemon prose posing
 * as provider metadata. Absence is honest; an invented description is not.
 *
 * ## Catalog scope
 *
 * The catalog is deliberately small — the Claude tool surface attested by the
 * corpus (`docs/reference/provider-wire/claude.md`,
 * `Spec-012 §Required Behavior`'s permission classes, and Plan-006's
 * `TodoWrite`-family result row). A tool name that appears in NO declaration
 * gets no `driver_tools` row at all, which is a different question from this
 * invariant's (an undeclared CLASS on a declared tool): the treatment of a
 * call with no row is the recovery dispatcher's (`Spec-015`), so speculative
 * names bought nothing and would have asserted a wire census this repo has
 * not recorded. MCP-discovered tools are NOT enumerated here; their floor and
 * census are T3.13.
 *
 * @see Spec-005 §Tool Metadata
 * @see Plan-005 T3.9 (I-005-3)
 */

import { McpServerStatusEmissionSchema } from "@ai-sidekicks/contracts";
import type {
  IdempotencyClass,
  McpServerStatus,
  McpServerStatusEmission,
  NormalizedProviderToolMetadata,
  ProviderToolMetadata,
} from "@ai-sidekicks/contracts";

// --------------------------------------------------------------------------
// The conservative default (I-005-3)
// --------------------------------------------------------------------------

/**
 * The class an unannotated tool takes. `Spec-005 §Tool Metadata` fixes this
 * value: it halts recovery for operator reconciliation rather than replaying
 * an effect whose repeat-safety nobody declared.
 */
export const DEFAULT_CLAUDE_TOOL_IDEMPOTENCY_CLASS: IdempotencyClass = "manual_reconcile_only";

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
 * Close one declaration's `idempotency_class`, applying the I-005-3 floor.
 *
 * Absent → floor, per `Spec-005 §Tool Metadata`. UNRECOGNIZED → floor too,
 * and deliberately not a throw: the static type is erased at runtime, so a
 * declaration reaching this helper from untyped ingress (T3.13's
 * MCP-discovered tools are the named case) can carry a value outside the
 * vocabulary — and a value outside the vocabulary is not a declaration of
 * anything, so it takes the same treatment as absence. Throwing would fail an
 * entire capability declaration over one malformed entry; flooring keeps the
 * declaration and makes the entry maximally conservative.
 *
 * The result is a NEW object: the caller's declaration is never mutated, and
 * the returned entry shares no reference with the module's own table.
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

/** Close a whole declaration table. See {@link closeToolIdempotencyClass}. */
export function closeToolIdempotencyClasses(
  declarations: readonly ProviderToolMetadata[],
): NormalizedProviderToolMetadata[] {
  return declarations.map((declaration) => closeToolIdempotencyClass(declaration));
}

// --------------------------------------------------------------------------
// Claude tool declarations
// --------------------------------------------------------------------------

/**
 * The Claude driver's RAW tool declarations — the authoring surface, where an
 * omitted `idempotency_class` is the normal case and the floor does the work.
 *
 * Exported so a test can assert the floor is load-bearing on SHIPPED data
 * (an unannotated entry here appearing floored in {@link CLAUDE_TOOL_CATALOG}),
 * rather than only on a synthetic input.
 */
export const CLAUDE_TOOL_DECLARATIONS: readonly ProviderToolMetadata[] = Object.freeze(
  (
    [
      // Pure local reads — safe to repeat after a crash; nothing observable changes.
      // `idempotent` per Spec-005 §Tool Metadata ("a pure read").
      { name: "Read", idempotency_class: "idempotent" },
      { name: "Glob", idempotency_class: "idempotent" },
      { name: "Grep", idempotency_class: "idempotent" },

      // Everything below is UNANNOTATED on purpose: each either mutates local
      // state, or hands an effect to a target whose repeat-safety the daemon
      // cannot establish. The I-005-3 floor classifies them.
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
 * The Claude driver's tool catalog as reported by `getCapabilities()` — every
 * entry class-closed. Built by {@link closeToolIdempotencyClasses}; never
 * hand-written, so the I-005-3 floor cannot be bypassed by an author.
 *
 * Frozen at BOTH levels: a consumer that reads this constant instead of
 * copying it cannot rewrite a tool's class for every later declaration in the
 * process. Callers building a `GetCapabilitiesResult` use
 * {@link getClaudeToolMetadata}, which hands back fresh, mutable rows.
 */
export const CLAUDE_TOOL_CATALOG: readonly NormalizedProviderToolMetadata[] = Object.freeze(
  closeToolIdempotencyClasses(CLAUDE_TOOL_DECLARATIONS).map((tool) => Object.freeze(tool)),
);

/**
 * A fresh, independently-mutable copy of the catalog.
 *
 * `GetCapabilitiesResult.tools` is a MUTABLE array on a contract that crosses
 * the driver boundary; handing out the module constant would make one
 * caller's mutation everyone's (the defensive-clone doctrine
 * `provider-registry.ts` applies to its cached flags snapshot).
 */
export function getClaudeToolMetadata(): NormalizedProviderToolMetadata[] {
  return CLAUDE_TOOL_CATALOG.map((tool) => ({ ...tool }));
}

// ==========================================================================
// T3.13 — MCP idempotency floor + MCP server-status census (EXTENDs T3.9)
// ==========================================================================
//
// The Claude side of Plan-005 T3.13 (P2-7, P2-10-L1). Same three additions as
// the Codex leg, adapted to this provider's ingress surfaces:
//
//   1. The MCP idempotency floor — an MCP-discovered tool is ALWAYS
//      `manual_reconcile_only`; MCP `ToolAnnotations` self-claims never
//      derive a class (`Spec-005 §Tool Metadata`, MUST-strength). The floor
//      here COMPOSES with {@link closeToolIdempotencyClass}: an MCP tool row
//      never reaches that helper with a permissive class in the first place,
//      because this classifier is the only source of MCP classes.
//   2. The DORMANT durable-task-handle seam (MCP 2025-11-25 Tasks): observe
//      the receiver-generated `taskId` at task-augmented dispatch, write
//      nothing — the `command_receipts.mcp_task_id` ALTER and the seam's
//      activation are T5.1's (phase split, Codex round 3). Pre-Phase-5
//      recovery for MCP receipts stays on the `manual_reconcile_only` halt.
//   3. The MCP server-status census normalizers for the two Claude ingress
//      shapes: the `system/init` `mcp_servers[]` member (the per-session
//      init census) and the `claude mcp list` zero-billed-turn probe's
//      human-CLI output (glyph lines; Spec-028 §Provider Capability Model
//      records there is no `--json`). Both normalize into the closed
//      `McpServerStatus` enum, bounded through
//      `McpServerStatusEmissionSchema` (`serverName` is untrusted CLI
//      output) BEFORE anything reaches the daemon-injected
//      `onMcpServerStatus` producer. SERVERS ONLY — support is not
//      visibility. Producer-only: the consumer is Plan-028's
//      `McpStatusNormalizer` (CP-028-2).
//
// Evidence honesty: unlike the Codex leg, the Claude wire reference does not
// pin these ingress vocabularies — the recognized status tokens below are
// Derived (Spec-028 §Status Observation records `pending` and `disabled` as
// observed Claude states and fixes `pending` → `starting`; the remaining
// tokens are the ecosystem-observed init-census values). The mapper is
// therefore deliberately tolerant: every unrecognized token lands at
// `unknown` — honestly no observation — and never at a healthy state, so a
// vocabulary the vendor widens degrades visibility, never correctness.

/**
 * The class of EVERY MCP-discovered tool (`Spec-005 §Tool Metadata`).
 *
 * Distinct from {@link DEFAULT_CLAUDE_TOOL_IDEMPOTENCY_CLASS} by RULE, not by
 * value: the default is what an unannotated builtin closes to; this is what
 * an MCP tool is regardless of annotation. The test pins the value identity.
 */
export const MCP_DISCOVERED_TOOL_IDEMPOTENCY_CLASS: IdempotencyClass = "manual_reconcile_only";

/**
 * MCP `ToolAnnotations` self-claims (MCP 2025-11-25 Tools). Modeled ONLY so
 * {@link classifyMcpDiscoveredTool}'s signature can name what it deliberately
 * ignores; the negative test drives it with every hint at its most
 * permissive value.
 */
export interface McpToolAnnotationHints {
  readonly readOnlyHint?: boolean | undefined;
  readonly idempotentHint?: boolean | undefined;
  readonly destructiveHint?: boolean | undefined;
  readonly openWorldHint?: boolean | undefined;
}

/**
 * Classify an MCP-discovered tool: always the floor.
 *
 * The `annotations` parameter is accepted and IGNORED — MCP binds clients to
 * treat annotations as untrusted (MUST-strength), and `Spec-005 §Tool
 * Metadata` forbids deriving `idempotency_class` from them. The only upgrade
 * path is the operator-governed assignment surface (Spec-028 §Tool-Level
 * Overrides, Plan-028's), never consulted at this seam.
 */
export function classifyMcpDiscoveredTool(
  annotations?: McpToolAnnotationHints | undefined,
): IdempotencyClass {
  // Intentionally unread: consulted-never-derived is the contract.
  void annotations;
  return MCP_DISCOVERED_TOOL_IDEMPOTENCY_CLASS;
}

// --------------------------------------------------------------------------
// Dormant durable-task-handle seam (T5.1 activates)
// --------------------------------------------------------------------------

/**
 * A task-augmented MCP dispatch whose acceptance carried a receiver-generated
 * `taskId` — the handle T5.1's receipt-column writer will persist into
 * `command_receipts.mcp_task_id`. Until that ALTER ships, observations go to
 * {@link DORMANT_MCP_TASK_HANDLE_SINK} and nowhere else.
 */
export interface McpTaskHandleObservation {
  readonly serverName: string;
  readonly toolName: string;
  readonly mcpTaskId: string;
}

/** Where an observed task handle lands; see {@link McpTaskHandleObservation}. */
export type McpTaskHandleSink = (observation: McpTaskHandleObservation) => void;

/**
 * The DORMANT sink: observes and discards. A named export so activation is a
 * one-line substitution at the dispatch seam and the dormancy is grep-able.
 */
export const DORMANT_MCP_TASK_HANDLE_SINK: McpTaskHandleSink = () => {
  // Dormant by design (Plan-005 T3.13 phase split): the
  // `command_receipts.mcp_task_id` column does not exist until T5.1 lands its
  // ALTER on Plan-004's `command_receipts` substrate. Recovery for an MCP
  // receipt therefore stays on the `manual_reconcile_only` halt.
};

/**
 * Extract the receiver-generated `taskId` from a `CreateTaskResult`-shaped
 * acceptance (`task.taskId`, existing only once the receiver ACCEPTS).
 * Tolerant: anything else yields `undefined`, keeping the receipt on the
 * floor's halt — an absent handle is never fabricated.
 */
export function extractMcpTaskId(acceptanceResult: unknown): string | undefined {
  if (typeof acceptanceResult !== "object" || acceptanceResult === null) {
    return undefined;
  }
  const task = (acceptanceResult as Record<string, unknown>)["task"];
  if (typeof task !== "object" || task === null) {
    return undefined;
  }
  const taskId = (task as Record<string, unknown>)["taskId"];
  if (typeof taskId !== "string" || taskId.length === 0) {
    return undefined;
  }
  return taskId;
}

/**
 * The dispatch-seam observation step: hand the sink an observation ONLY when
 * a handle exists — no handle (or malformed acceptance) means no call, and
 * the floor's halt stays the default for both.
 */
export function observeMcpTaskAcceptance(
  sink: McpTaskHandleSink,
  serverName: string,
  toolName: string,
  acceptanceResult: unknown,
): void {
  const mcpTaskId = extractMcpTaskId(acceptanceResult);
  if (mcpTaskId === undefined) {
    return;
  }
  sink({ serverName, toolName, mcpTaskId });
}

// --------------------------------------------------------------------------
// MCP server-status census normalization (P2-10-L1)
// --------------------------------------------------------------------------

/**
 * A raw row or line this normalizer could not turn into a bounded emission.
 * Rejections are RETURNED, never dropped — the wiring seam routes them to
 * the driver diagnostic surface so a malformed row is a visible census gap.
 */
export interface McpServerStatusIngestRejection {
  readonly reason: string;
}

/** The outcome of normalizing one raw ingress payload. */
export interface McpServerStatusIngestResult {
  readonly emissions: readonly McpServerStatusEmission[];
  readonly rejections: readonly McpServerStatusIngestRejection[];
}

/**
 * Recognized Claude status tokens → unified enum (Derived — see the module
 * note above). Keys are compared lower-cased with `_`/`-`/space collapsed, so
 * the init census's `needs_auth` and the CLI's "Needs authentication" resolve
 * identically.
 *
 *   * `pending` → `starting` is Spec-028 §Status Observation's stated
 *     deterministic map.
 *   * `disabled` → `unknown`: deliberately not running — there is no live
 *     connection state; enabled/disabled semantics live on the CONSUMER's
 *     inventory entry, never in this enum.
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

/** Canonicalize a raw status token for map lookup (never for emission). */
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

/** Bound one (serverName, status) pair through the contract schema. */
function boundEmission(
  serverName: unknown,
  status: McpServerStatus,
): { emission?: McpServerStatusEmission; rejection?: McpServerStatusIngestRejection } {
  const parsed = McpServerStatusEmissionSchema.safeParse({ serverName, status });
  if (parsed.success) {
    return { emission: parsed.data };
  }
  return {
    rejection: {
      reason: `MCP server-status emission rejected at the wire bound: ${parsed.error.issues
        .map((issue) => issue.message)
        .join("; ")}`,
    },
  };
}

/**
 * Normalize the `system/init` `mcp_servers[]` member — the per-session init
 * census. Rows are `{ name, status }`-shaped; anything else per row is a
 * rejection, and a non-array input is one rejection with no emissions.
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
    const bounded = boundEmission(row["name"], mapClaudeStatusToken(row["status"]));
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
 * Normalize `claude mcp list` probe output — the zero-billed-turn
 * status-refresh path. The CLI prints human-oriented lines
 * (`<name>: <command> - <glyph> <status text>`); there is no `--json`
 * (Spec-028 §Provider Capability Model). The parser is deliberately narrow:
 * a line must carry a `name:` prefix AND a ` - ` status separator to be read
 * at all — headers, blank lines, and prose fall through WITHOUT a rejection
 * (they are formatting, not malformed rows) — and a recognized line whose
 * status text is unrecognized emits `unknown`, never a guess.
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
    // Strip the leading status glyph (✓ / ✗ / ⚠ / any non-word prefix) so the
    // token map reads the words, not the symbol — glyphs are presentation.
    const statusText = line
      .slice(separatorIndex + " - ".length)
      .replace(/^[^\p{L}\p{N}]+/u, "")
      .trim();
    const bounded = boundEmission(serverName, mapClaudeStatusToken(statusText));
    if (bounded.emission !== undefined) {
      emissions.push(bounded.emission);
    }
    if (bounded.rejection !== undefined) {
      rejections.push(bounded.rejection);
    }
  }
  return { emissions, rejections };
}
