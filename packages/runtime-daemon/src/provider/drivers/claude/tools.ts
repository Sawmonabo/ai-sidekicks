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

import type {
  IdempotencyClass,
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
