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

import type { IdempotencyClass, NormalizedProviderToolMetadata } from "@ai-sidekicks/contracts";

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
