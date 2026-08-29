// Codex per-tool metadata declaration (Plan-005 Phase 3, T3.4).
//
// This module is the Codex driver's ONLY source of per-tool
// `idempotency_class` metadata. `DriverCapabilitiesWriter` (T2.4) explodes the
// declared array into `driver_tools` rows so the daemon's two-phase
// command-receipt protocol can dispatch crash recovery on a tool's class
// WITHOUT round-tripping the provider (`Spec-005 §Tool Metadata`).
//
// -- The tool-name namespace, and why it is the ThreadItem discriminant --
//
// The `codex app-server` protocol at the pinned build publishes NO census of
// the model-facing built-in tool names: regenerating the JSON Schema per
// `docs/reference/provider-wire/codex.md §Regeneration` yields a `Tool`
// definition whose `name` is an open `string` (the MCP-style descriptor), a
// `ToolsV2` config object carrying a single `web_search` toggle, and a
// `GuardianCommandSource` enum — none of which enumerates the tools an agent
// turn can invoke. The ONE closed, wire-verified enumeration of invocation
// identities the protocol does publish is the `ThreadItem` `type`
// discriminant, and that is also precisely the identity the daemon OBSERVES:
// a Codex tool invocation reaches this daemon as an `item/started` /
// `item/completed` notification carrying that discriminant and nothing more
// specific. Keying `driver_tools` on any other namespace would therefore
// produce rows that the recovery dispatcher's lookup can never hit — a
// silently vacuous class table. So the namespace here is the observed one.
//
// `CODEX_TOOL_NAMES` is exported as a `const` tuple (and `CodexToolName` as
// its derived union) SPECIFICALLY so the T3.5 event normalizer imports the
// identity rather than restating string literals: a namespace change becomes a
// compile error at the consumer instead of a dead database lookup at recovery
// time. This is the seam T3.5 must consume.
//
// -- I-005-3 is structural, not documented --
//
// Every entry leaves this module as a `NormalizedProviderToolMetadata`, whose
// `idempotency_class` is REQUIRED. The only constructor of that shape here is
// `closeCodexToolDeclaration`, which substitutes
// `DEFAULT_CODEX_TOOL_IDEMPOTENCY_CLASS` (`manual_reconcile_only`) for an
// unannotated entry. An author who adds a tool and forgets to classify it
// therefore gets the conservative floor BY CONSTRUCTION — there is no code
// path that emits an unclassified tool, and no comment anyone has to obey.
// This is defense in depth over the contract-level realization
// (`ProviderToolMetadataSchema`'s `.optional().default(...)`), not a
// replacement for it: the two guard different boundaries (authoring here, the
// untyped write seam there).
//
// The mutating tools below are deliberately authored WITHOUT an
// `idempotency_class` so the floor is exercised by the shipped census itself
// rather than only by a test fixture. Annotating them
// `manual_reconcile_only` explicitly would read identically and prove
// nothing.
//
// -- Classification basis --
//
// `idempotent` is claimed ONLY where re-execution after a crash changes no
// state the session or any external system can observe (`Spec-005 §Tool
// Metadata`: "safe to re-execute ... either a pure read ... or a write whose
// external target is server-side idempotent"). Each such claim carries its
// one-line rationale inline. No Codex built-in qualifies as `compensable` —
// that class requires a remote side honoring a client-supplied idempotency
// key, and none of these invocations exposes one — so the class is absent
// here by evidence, not by oversight.
//
// -- Deliberate omissions (each is a decision, not a gap) --
//
//   * `mcpToolCall` — MCP-discovered tools are keyed by (server, tool), not by
//     the item discriminant, and are ALWAYS `manual_reconcile_only` with
//     derivation from `ToolAnnotations` prohibited (`Spec-005 §Tool
//     Metadata`). Declaring a single `"mcpToolCall"` row would assert a class
//     for an identity no receipt ever records. The MCP idempotency floor and
//     the server-status census are Plan-005 T3.13 (PR-B).
//   * `dynamicToolCall` — the daemon-curated callback-tool path. Those tools
//     are registered per session (`SessionCallbackTool`), so their classes
//     come from the session registry, never from this static declaration.
//   * `subAgentActivity` — an activity record emitted BESIDE a peer-agent run,
//     not an invocation the recovery dispatcher can replay or halt.
//   * Non-invocation `ThreadItem` arms (`userMessage`, `hookPrompt`,
//     `agentMessage`, `plan`, `reasoning`, `enteredReviewMode`,
//     `exitedReviewMode`, `contextCompaction`) are message/lifecycle rows and
//     carry no tool identity at all.
//
// SCOPE BOUNDARY: this task declares the census only. The MCP idempotency
// floor + server-status census (T3.13) and the CLI-version floor / refresh
// cadence (T3.12) EXTEND this driver in PR-B and are NOT implemented here.
//
// Spec coverage: `Spec-005 §Required Behavior` (per-tool `idempotency_class`
// required alongside the tool list), `Spec-005 §Tool Metadata`
// (`manual_reconcile_only` conservative default).
//
// Refs: Plan-005 §Phase 3 / T3.4, invariant I-005-3,
// `docs/reference/provider-wire/codex.md` (wire surface at the pinned
// `codex-cli` build; regenerate-don't-transcribe).

import { McpServerStatusEmissionSchema } from "@ai-sidekicks/contracts";
import type {
  IdempotencyClass,
  McpServerStatus,
  McpServerStatusEmission,
  NormalizedProviderToolMetadata,
} from "@ai-sidekicks/contracts";

/**
 * The conservative floor an unannotated tool closes to (I-005-3).
 *
 * Exported so a consumer asserting the floor names the same constant this
 * module defaults with, rather than restating the literal.
 */
export const DEFAULT_CODEX_TOOL_IDEMPOTENCY_CLASS: IdempotencyClass = "manual_reconcile_only";

/**
 * The Codex tool-identity namespace: `ThreadItem.type` discriminants for the
 * arms that represent an invocation whose crash-recovery disposition matters.
 *
 * Ordered deliberately — mutating (floor) entries first, then the classified
 * read-only ones — so a reader sees the conservative bulk before the
 * exceptions. Order is not load-bearing for correctness: `driver_tools` is
 * keyed by `(driver_name, tool_name)`.
 */
export const CODEX_TOOL_NAMES = [
  "commandExecution",
  "fileChange",
  "collabAgentToolCall",
  "imageGeneration",
  "webSearch",
  "imageView",
  "sleep",
] as const;

/** The closed union of Codex tool identities — the T3.5 normalizer's seam. */
export type CodexToolName = (typeof CODEX_TOOL_NAMES)[number];

/**
 * A tool as AUTHORED in this module.
 *
 * `idempotency_class` is OPTIONAL here and REQUIRED on the way out: that
 * asymmetry IS invariant I-005-3, expressed in the type system rather than in
 * prose. `description` is required because an operator reconciling a halted
 * `manual_reconcile_only` receipt reads it, and an unexplained row is a worse
 * default than a verbose one.
 */
interface CodexToolDeclaration {
  readonly idempotency_class?: IdempotencyClass;
  readonly description: string;
}

/**
 * The census. `Record<CodexToolName, ...>` makes the set TOTAL by
 * construction: adding a name to `CODEX_TOOL_NAMES` without classifying it
 * here is a compile error, so the two never drift.
 */
const CODEX_TOOL_DECLARATIONS: Record<CodexToolName, CodexToolDeclaration> = {
  // Unannotated -> floor: an arbitrary shell command with an arbitrary,
  // undeclared effect; the protocol exposes no dedup handle for a re-run.
  commandExecution: {
    description: "Executes a shell command in the thread's working directory.",
  },
  // Unannotated -> floor: patch application is order- and content-sensitive;
  // re-applying an already-applied change corrupts the working tree.
  fileChange: {
    description: "Applies file creations, edits, and deletions to the working tree.",
  },
  // Unannotated -> floor: spawns, resumes, or feeds a peer agent; a replay
  // duplicates another agent's run and its entire downstream effect.
  collabAgentToolCall: {
    description: "Spawns, messages, resumes, waits on, or closes a peer agent thread.",
  },
  // Unannotated -> floor: a billable remote generation that is not
  // reproducible — a replay returns a DIFFERENT artifact, so the receipt's
  // recorded output would no longer describe what exists.
  imageGeneration: {
    description: "Generates an image through the provider's remote model.",
  },
  // Rationale: a read-only query against an external index — it mutates no
  // local or remote state, so a recovery replay is observationally inert.
  webSearch: {
    idempotency_class: "idempotent",
    description: "Runs a read-only web search and returns results to the model.",
  },
  // Rationale: reads an image from a path into model context; a pure read.
  imageView: {
    idempotency_class: "idempotent",
    description: "Reads an image file at a path into the model's context.",
  },
  // Rationale: a wall-clock delay with no local or remote effect; replaying it
  // costs time and changes nothing else.
  sleep: {
    idempotency_class: "idempotent",
    description: "Pauses the turn for a fixed duration.",
  },
};

/**
 * The single constructor of an emitted tool row. Its REQUIRED
 * `idempotency_class` return field is what closes the set (I-005-3).
 */
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

/**
 * The frozen, fully-classified Codex tool census.
 *
 * Frozen at both levels so a consumer that reads (rather than copies) cannot
 * corrupt every later capability declaration through a shared reference.
 * Callers building a `GetCapabilitiesResult` use `getCodexToolMetadata()`,
 * which hands back fresh, mutable rows.
 */
export const CODEX_TOOL_METADATA: readonly NormalizedProviderToolMetadata[] = Object.freeze(
  CODEX_TOOL_NAMES.map((name) =>
    Object.freeze(closeCodexToolDeclaration(name, CODEX_TOOL_DECLARATIONS[name])),
  ),
);

/**
 * A fresh, independently-mutable copy of the census.
 *
 * `GetCapabilitiesResult.tools` is a mutable array on a contract that crosses
 * the driver boundary; handing out the module constant would let one caller's
 * mutation corrupt every later declaration (the defensive-clone doctrine
 * `provider-registry.ts` applies to the flags snapshot).
 */
export function getCodexToolMetadata(): NormalizedProviderToolMetadata[] {
  return CODEX_TOOL_METADATA.map((tool) => ({ ...tool }));
}

// ==========================================================================
// T3.13 — MCP idempotency floor + MCP server-status census (EXTENDs T3.4)
// ==========================================================================
//
// Three additions, each scoped to what `Spec-005 §Tool Metadata` and Plan-005
// T3.13 (P2-7, P2-10-L1) assign to the DRIVER side:
//
//   1. The MCP idempotency floor: an MCP-discovered tool is ALWAYS
//      `manual_reconcile_only`, and the class is NEVER derived from MCP
//      `ToolAnnotations` self-claims (readOnlyHint / idempotentHint). The
//      only upgrade path is the operator-governed assignment surface
//      (Spec-028 §Tool-Level Overrides) — which is Plan-028's, not here.
//   2. The DORMANT durable-task-handle seam: where an MCP call is dispatched
//      task-augmented (MCP 2025-11-25 Tasks utility), the receiver-generated
//      `taskId` from the `CreateTaskResult` acceptance is the handle Spec-015
//      recovery polls instead of halting. The COLUMN
//      (`command_receipts.mcp_task_id`) does not exist yet — its ALTER is
//      T5.1's, gated on Plan-004 Phase 1 substrate — so this seam is
//      structured to observe the handle at dispatch but WRITES NOTHING: the
//      shipped sink is a no-op, and T5.1 activates the seam by supplying the
//      receipt-column writer. Pre-Phase-5 recovery stays on the
//      `manual_reconcile_only` halt.
//   3. The MCP server-status census normalizers: `mcpServerStatus/list` rows
//      and `mcpServer/startupStatus/updated` notifications, normalized into
//      the closed `McpServerStatus` enum and Zod-bounded
//      (`McpServerStatusEmissionSchema` — `serverName` is untrusted
//      provider output) BEFORE anything reaches the daemon-injected
//      `onMcpServerStatus` producer. SERVERS ONLY — no per-server tool-list
//      assumption (support is not visibility). Producer-only: the consumer
//      is Plan-028's `McpStatusNormalizer` (CP-028-2).
//
// Wire grounding (first-party, generated JSON Schema at the pinned codex-cli
// `0.150.1` — regenerate per
// `docs/reference/provider-wire/codex.md §Regeneration`):
//   * `McpServerStatus` list row: required `name` + `authStatus`
//     (`unknown | unsupported | notLoggedIn | bearerToken | oAuth`), optional
//     `runtimeStatus` (`McpServerConnectionStatus`: `notStarted | starting |
//     connected | authenticationRequired | failed | cancelled | disabled`),
//     null "when unavailable or the configuration changed".
//   * `McpServerStatusUpdatedNotification`: required `name` + `status`
//     (`McpServerStartupState`: `starting | ready | failed | cancelled`),
//     optional `failureReason` (`reauthenticationRequired`) and `error`.

/**
 * The class of EVERY MCP-discovered tool (`Spec-005 §Tool Metadata`).
 *
 * Exported as its own constant — rather than reusing
 * {@link DEFAULT_CODEX_TOOL_IDEMPOTENCY_CLASS} at call sites — because the two
 * rules are different: the default is what an UNANNOTATED builtin closes to;
 * this is what an MCP tool is REGARDLESS of annotation. They share a value by
 * spec, and the test pins that identity so a future divergence is loud.
 */
export const MCP_DISCOVERED_TOOL_IDEMPOTENCY_CLASS: IdempotencyClass = "manual_reconcile_only";

/**
 * The MCP `ToolAnnotations` self-claims a server may attach to a tool
 * (MCP 2025-11-25 Tools). Modeled here ONLY so the floor's signature can name
 * what it deliberately ignores — the negative test drives this function with
 * every hint set to its most permissive value and asserts the floor holds.
 */
export interface McpToolAnnotationHints {
  readonly readOnlyHint?: boolean | undefined;
  readonly idempotentHint?: boolean | undefined;
  readonly destructiveHint?: boolean | undefined;
  readonly openWorldHint?: boolean | undefined;
}

/**
 * Classify an MCP-discovered tool's `idempotency_class`.
 *
 * Always {@link MCP_DISCOVERED_TOOL_IDEMPOTENCY_CLASS}. The `annotations`
 * parameter is accepted and IGNORED — that is the contract, not an oversight:
 * MCP 2025-11-25 binds clients to treat `ToolAnnotations` as untrusted unless
 * from trusted servers, and `Spec-005 §Tool Metadata` forbids deriving the
 * class from them at MUST strength. A `readOnlyHint: true` /
 * `idempotentHint: true` self-claim therefore has NO effect on recovery
 * dispatch. The only upgrade path is the operator-governed, Cedar-gated,
 * always-audited assignment surface (Spec-028 §Tool-Level Overrides), which
 * is Plan-028's and never consulted at this seam.
 */
export function classifyMcpDiscoveredTool(
  annotations?: McpToolAnnotationHints | undefined,
): IdempotencyClass {
  // The parameter is intentionally unread. Void it so the intent is explicit
  // to both the reader and the linter: consulted-never-derived.
  void annotations;
  return MCP_DISCOVERED_TOOL_IDEMPOTENCY_CLASS;
}

// --------------------------------------------------------------------------
// Dormant durable-task-handle seam (T5.1 activates)
// --------------------------------------------------------------------------

/**
 * A task-augmented MCP dispatch whose acceptance carried a receiver-generated
 * `taskId`. Keyed by (server, tool) — the MCP identity namespace — plus the
 * handle itself. This is the value T5.1's receipt-column writer persists into
 * `command_receipts.mcp_task_id`; until then it goes nowhere.
 */
export interface McpTaskHandleObservation {
  readonly serverName: string;
  readonly toolName: string;
  readonly mcpTaskId: string;
}

/**
 * Where an observed task handle lands. The shipped binding is
 * {@link DORMANT_MCP_TASK_HANDLE_SINK}; T5.1 replaces it with the
 * `command_receipts.mcp_task_id` writer once the column's ALTER has shipped.
 */
export type McpTaskHandleSink = (observation: McpTaskHandleObservation) => void;

/**
 * The DORMANT sink: observes and discards.
 *
 * Deliberately a named export rather than an inline `() => {}` at call sites,
 * so activation is a one-line substitution at the dispatch seam and the
 * dormancy is grep-able. Writing anything here before T5.1 would invent a
 * persistence surface the schema does not have.
 */
export const DORMANT_MCP_TASK_HANDLE_SINK: McpTaskHandleSink = () => {
  // Dormant by design (Plan-005 T3.13 phase split, Codex round 3): the
  // `command_receipts.mcp_task_id` column does not exist until T5.1 lands its
  // ALTER on Plan-004's `command_receipts` substrate. Recovery for an MCP
  // receipt therefore stays on the `manual_reconcile_only` halt.
};

/**
 * Extract the receiver-generated `taskId` from a task-augmented dispatch's
 * acceptance response (MCP 2025-11-25 Tasks `CreateTaskResult`: the id lives
 * at `task.taskId` and exists only once the receiver ACCEPTS).
 *
 * Tolerant by design — the utility is experimental upstream and the response
 * is untrusted wire input, so anything not carrying a non-empty string at
 * that path yields `undefined`, which keeps the receipt on the floor's halt
 * (a crash before a durably-stored acceptance leaves no handle; an absent
 * handle must never be fabricated).
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
 * The dispatch-seam observation step: parse the acceptance, and hand the sink
 * an observation ONLY when a handle actually exists. No handle → no call —
 * the sink never has to distinguish "no task" from "malformed acceptance",
 * and the floor's halt is the default for both.
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
 * A raw row or notification this normalizer could not turn into a bounded
 * emission. Rejections are RETURNED, never dropped: the wiring seam routes
 * them to the driver diagnostic surface so a malformed row is visible instead
 * of a silent census gap. (This module stays dependency-free of the
 * diagnostic module — the census is pure normalization.)
 */
export interface McpServerStatusIngestRejection {
  readonly reason: string;
}

/** The outcome of normalizing one raw wire payload into bounded emissions. */
export interface McpServerStatusIngestResult {
  readonly emissions: readonly McpServerStatusEmission[];
  readonly rejections: readonly McpServerStatusIngestRejection[];
}

/**
 * `McpServerConnectionStatus` (list-row `runtimeStatus`) → unified enum.
 *
 * The mapping is total over the schema-published vocabulary; a value outside
 * it lands at `unknown` (the honest floor — an unrecognized state is not an
 * observation of anything). Two entries deserve their rationale:
 *   * `cancelled` → `failed`: startup was attempted and terminated without a
 *     connection — a terminal not-connected state, not an absent observation.
 *   * `disabled` → `unknown`: deliberately not running; there IS no live
 *     connection state. The enabled/disabled semantics live on the CONSUMER's
 *     inventory entry (Spec-028 §Status Observation), never in this enum.
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

/** `McpServerStartupState` (startup notification `status`) → unified enum. */
const CODEX_STARTUP_STATE_MAP: Readonly<Record<string, McpServerStatus>> = {
  starting: "starting",
  ready: "connected",
  failed: "failed",
  cancelled: "failed",
};

/**
 * Bound one (serverName, status) pair through the CONTRACT schema.
 *
 * `McpServerStatusEmissionSchema` is the trust boundary the plan names:
 * `serverName` is untrusted provider output and is `wireFreeFormString`-
 * bounded (length 1..128, non-whitespace, no NUL) HERE, before the emission
 * can reach the daemon-injected producer.
 */
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
 * Normalize a `mcpServerStatus/list` response's `data` rows into bounded
 * emissions — the per-session init census.
 *
 * Status resolution per row (first-party schema semantics):
 *   1. `runtimeStatus` present → the connection-status map above.
 *   2. `runtimeStatus` null/absent ("unavailable or the configuration
 *      changed") → `authStatus === "notLoggedIn"` is still a definite
 *      needs-auth observation; anything else is honestly `unknown` — an auth
 *      MODE (`bearerToken`, `oAuth`, `unsupported`) says nothing about
 *      whether the server is up.
 *
 * Accepts the raw `data` array (unknown — untrusted wire). A non-array input
 * yields one rejection and no emissions.
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
    const bounded = boundEmission(row["name"], status);
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
 * Normalize one `mcpServer/startupStatus/updated` notification into a bounded
 * emission — the live status-change feed.
 *
 * One refinement beyond the state map: a `failed` startup whose
 * `failureReason` is `reauthenticationRequired` is a needs-auth observation,
 * not a generic failure — the schema publishes exactly that one reason, and
 * collapsing it into `failed` would hide the one state an operator can
 * actually fix from the census.
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
  const bounded = boundEmission(notification["name"], status);
  return {
    emissions: bounded.emission !== undefined ? [bounded.emission] : [],
    rejections: bounded.rejection !== undefined ? [bounded.rejection] : [],
  };
}
