// The one call this console makes into a schema library, and the wrapper that makes it
// safe to make.
//
// IT LIVES IN THIS FAMILY BECAUSE THIS IS THE FAMILY THAT MAY HOLD A VALIDATOR. The
// console bans the schema library everywhere above `bridge/`, and the ban's own reason is
// the layer rather than the file: a validator sits below every surface, so no surface can
// hold a second reading of one. `workflow-definition-file-form.ts` is the same shape one
// directory over — pasted text narrowed into a typed request — and this is its sibling: a
// schema the wire delivered, compiled once into something a locally composed answer can be
// checked against. What is checked here is a DRAFT and never a daemon reply; a reply is
// parsed at `daemon/daemon-reply.ts` and nowhere else, and nothing in this module can
// reach one.
//
// WHY IT IS WRAPPED RATHER THAN CALLED. `Spec-023 §Console Libraries` admits Zod's
// JSON-Schema reader for exactly this job and nothing else, and the library's own
// documentation calls that reader experimental and outside its stable API. It THROWS —
// it does not return a verdict — on the draft-07 constructs it does not implement:
// `$ref`, `if`/`then`/`else`, `dependentRequired`. A form that let that throw would take
// the pane down over a definition somebody authored, which is the opposite of the rule
// this whole subtree is built on: an unusual schema is answered in the raw editor and
// never refused.
//
// SO THE VERDICT IS A VALUE. Compiling either succeeds or reports why it did not, and a
// caller that got no validator still has a working editor — it validates the JSON's
// syntax and says plainly that the schema itself could not be checked. Two different
// honesties, and the type keeps them apart.
//
// THE ISSUE PATH IS A STRING BECAUSE THAT IS WHAT A LABEL IS KEYED BY. The library
// reports a path of property keys and array indices; the form addresses its controls by
// the same dotted member path the mapper composes, so the join happens once, here, and
// no surface re-derives it.
//
// NO SCHEMA COMPILATION IS CACHED. A validator is minted per schema per mount and lives
// as long as the form does — the console keeps no unbounded cache keyed on values it
// does not own, and a phase definition's schema is read once per open.

import * as zod from "zod";

/** One thing wrong with an answer, addressed the way the form addresses its controls. */
export interface SchemaValidationIssue {
  /** The dotted member path, or the empty string for an issue about the whole answer. */
  readonly memberPath: string;
  /** The library's own sentence, carried verbatim. */
  readonly message: string;
}

/** What checking one answer against one schema came back with. */
export interface SchemaValidationReport {
  readonly status: "valid" | "invalid";
  readonly issues: readonly SchemaValidationIssue[];
}

/** A schema that can be checked against, or the honest statement that it cannot be. */
export type SchemaValidator =
  | { readonly status: "compiled"; readonly check: (answer: unknown) => SchemaValidationReport }
  | { readonly status: "uncompilable"; readonly detail: string };

/** The verdict every caller wants when there is nothing to check. */
const NOTHING_WRONG: SchemaValidationReport = { status: "valid", issues: [] };

/** A library issue path, in the console's own dotted spelling. */
function memberPathOf(path: readonly PropertyKey[]): string {
  return path.map((segment) => String(segment)).join(".");
}

/**
 * Read a thrown value's sentence without asserting anything about its shape.
 *
 * The library throws a plain `Error` for an unimplemented construct today, and the
 * console's rule for a caught value is that it is `unknown` until something proves
 * otherwise — so this reads a message where there is one and says so where there is not.
 */
function thrownDetail(thrown: unknown): string {
  return thrown instanceof Error && thrown.message.length > 0
    ? thrown.message
    : "the schema reader gave no reason";
}

/**
 * Compile one input schema into something an answer can be checked against.
 *
 * Total: every schema resolves to one of the two arms and none of them escapes as a
 * throw, which is what lets the form's own fallback stay a fallback rather than a crash.
 */
export function compileSchemaValidator(inputSchema: unknown): SchemaValidator {
  let compiled: zod.ZodType;
  try {
    compiled = zod.fromJSONSchema(inputSchema as Parameters<typeof zod.fromJSONSchema>[0]);
  } catch (error) {
    return {
      status: "uncompilable",
      detail: `This phase's schema could not be checked here (${thrownDetail(error)}), so only the JSON itself is checked.`,
    };
  }
  return {
    status: "compiled",
    check: (answer) => {
      const parsed = compiled.safeParse(answer);
      if (parsed.success) {
        return NOTHING_WRONG;
      }
      return {
        status: "invalid",
        issues: parsed.error.issues.map((issue) => ({
          memberPath: memberPathOf(issue.path),
          message: issue.message,
        })),
      };
    },
  };
}
