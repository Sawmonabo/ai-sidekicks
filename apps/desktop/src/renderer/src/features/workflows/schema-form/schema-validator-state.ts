// Where a form stands with the schema compiler, and the arm a person answers in. A failed chunk
// fetch is `checker-unavailable`, never `uncompilable`, whose reason would blame a good
// definition; both open the raw editor.

import type { SchemaFallback, SchemaFormPlan } from "./plan/schema-fields.js";
import type { SchemaValidator } from "./json-schema-validator.js";

/**
 * What a compile round settled on: the compiler's verdict, or the fact that the chunk never
 * arrived. Excludes `compiling`, which is the absence of a settlement.
 */
export type SettledSchemaValidator =
  | SchemaValidator
  | {
      readonly status: "checker-unavailable";
      /** One sentence for the person looking at the form. */
      readonly detail: string;
    };

/**
 * Where a form is with the compiler it needs: still fetching it, or how that ended. Kept out of
 * `SchemaValidator`, whose two arms are both answers, so its readers need not check whether one
 * arrived.
 */
export type SchemaValidatorState = { readonly status: "compiling" } | SettledSchemaValidator;

/**
 * The one key a form's compile round is claimed under. One key, not one per schema, so a schema
 * that supersedes another abandons its round.
 */
export const VALIDATOR_COMPILE_KEY = "schema-validator-compile";

/** The validator state before any answer exists; held once so renders share one value. */
export const COMPILING_VALIDATOR: SchemaValidatorState = { status: "compiling" };

/**
 * The arm a form takes when the compiler's chunk did not arrive. The sentence states the
 * consequence: the answer can still be sent, and the run decides what is admissible.
 */
export const CHECKER_UNAVAILABLE: SettledSchemaValidator = {
  status: "checker-unavailable",
  detail:
    "Nothing typed here is checked against this phase's schema. The answer can still be sent, and the run itself decides whether it is admissible.",
};

/**
 * What a settled compile round installs, with the schema it is about, so a settlement for a schema
 * the form has just left is never read as the current verdict. Covers a failed fetch as well.
 */
export interface CompiledForSchema {
  readonly inputSchema: unknown;
  readonly validator: SettledSchemaValidator;
}

/**
 * Why a schema whose members are all drawable is answered as JSON anyway. It does not repeat the
 * compiler's detail, which the raw editor renders beneath the document.
 */
const UNCHECKABLE_SCHEMA_FALLBACK: SchemaFallback = {
  cause: "schema-uncheckable",
  memberPath: [],
  detail:
    "This phase's schema could not be compiled here, so the answer is given as JSON rather than in controls that could check nothing you type.",
};

/**
 * Why a schema the mapper drew is answered as JSON when the compiler never arrived; the raw
 * editor renders {@link CHECKER_UNAVAILABLE} beneath the document for what is unchecked.
 */
const UNAVAILABLE_CHECKER_FALLBACK: SchemaFallback = {
  cause: "checker-unavailable",
  memberPath: [],
  detail:
    "The part of this window that checks an answer against a schema did not load, so the controls that would have relied on it are not drawn and the answer is given as JSON.",
};

/**
 * Which validator states send a drawn schema to the raw editor, and with which sentence. A table
 * total over the union, so a new arm must decide here (a `!==` test would keep the controls by
 * accident, the failing side).
 */
const RAW_ARM_FALLBACKS: Record<SchemaValidatorState["status"], SchemaFallback | undefined> = {
  compiling: undefined,
  compiled: undefined,
  uncompilable: UNCHECKABLE_SCHEMA_FALLBACK,
  "checker-unavailable": UNAVAILABLE_CHECKER_FALLBACK,
};

/**
 * The arm a form opens on: the mapper's reading, unless nothing could check it. While `compiling`
 * the drawn controls stay, since moving to the raw editor would show a reason not yet known to be
 * true; the closed act keeps the promise instead. A failed fetch moves the arm like a refused
 * compile, since a window with no compiler cannot refuse a wrong value either.
 */
export function choosePlanForValidator(
  plan: SchemaFormPlan,
  validator: SchemaValidatorState,
): SchemaFormPlan {
  const fallback = RAW_ARM_FALLBACKS[validator.status];
  if (plan.shape === "raw" || fallback === undefined) {
    return plan;
  }
  return { shape: "raw", fallback };
}
