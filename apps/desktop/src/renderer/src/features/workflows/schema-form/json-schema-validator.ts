// Compiles a workflow input schema into a validator for a person's draft answer. The only module
// that imports the schema library, and it is reached through `json-schema-validator-loader.ts`
// so the library arrives on its own chunk.
// The schema reader throws on constructs it does not implement (`$ref`, `if`/`then`/`else`,
// `dependentRequired`); that failure is returned as a value so the raw editor keeps working.

import * as zod from "zod";

import type { SchemaMemberPath } from "./schema-member-path.js";

/** One thing wrong with an answer, addressed the way the form addresses its controls. */
export interface SchemaValidationIssue {
  /** Where the finding is, as segments. Empty for an issue about the whole answer. */
  readonly memberPath: SchemaMemberPath;
  /**
   * The library's own sentence, carried verbatim, except for a required member nobody has
   * answered (see `sentenceOf`).
   */
  readonly message: string;
}

/**
 * What checking one answer against one schema came back with. Two arms because the accepted
 * value exists only on the valid one.
 */
export type SchemaValidationReport =
  | {
      readonly status: "valid";
      readonly issues: readonly SchemaValidationIssue[];
      /**
       * The value the schema accepted, which a submission must carry: the reader supplies
       * declared defaults, so `{}` can be valid as `{ approver: "ada" }`. The reader has no
       * switch to compile without defaults. Measured at zod 4.3.6: defaults are its only change
       * (an unknown member passes, `format` transforms nothing, `additionalProperties: false`
       * refuses), so nothing typed is lost.
       */
      readonly acceptedValue: unknown;
    }
  | { readonly status: "invalid"; readonly issues: readonly SchemaValidationIssue[] };

/** A schema that can be checked against, or the honest statement that it cannot be. */
export type SchemaValidator =
  | { readonly status: "compiled"; readonly check: (answer: unknown) => SchemaValidationReport }
  | { readonly status: "uncompilable"; readonly detail: string };

/** The finding list of a clean verdict; shared and never written to. */
const NOTHING_WRONG: readonly SchemaValidationIssue[] = [];

/**
 * Compile one input schema into a validator, uncached. Total: every schema resolves to one of
 * the two arms and none throws.
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
        // `parsed.data`, not the answer: the verdict and the submission describe one value.
        return { status: "valid", issues: NOTHING_WRONG, acceptedValue: parsed.data };
      }
      return {
        status: "invalid",
        issues: parsed.error.issues.map((issue) => ({
          memberPath: memberPathOf(issue.path),
          message: sentenceOf(issue, answer),
        })),
      };
    },
  };
}

/** A library issue path as segments; a number stays a number (an array position). */
function memberPathOf(path: readonly PropertyKey[]): SchemaMemberPath {
  return path.map((segment) => (typeof segment === "number" ? segment : String(segment)));
}

/** The value at an issue path in the answer as composed, or `undefined` where it holds none. */
function memberAt(answer: unknown, path: readonly PropertyKey[]): unknown {
  let current: unknown = answer;
  for (const segment of path) {
    if (current === null || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<PropertyKey, unknown>)[segment];
  }
  return current;
}

/** `"a"`, `"a" or "b"`, `"a", "b" or "c"`: the members an enumeration offers, quoted. */
function offeredMembers(values: readonly unknown[]): string {
  const quoted = values.map((value) => JSON.stringify(value));
  if (quoted.length <= 1) {
    return quoted.join("");
  }
  return `${quoted.slice(0, -1).join(", ")} or ${quoted[quoted.length - 1]}`;
}

/**
 * The sentence for one finding: the library's, except for a member the answer does not hold at
 * all. The library words that as a wrong value ("Invalid option", "received undefined"), which
 * misleads beside a control reading "Not answered". A whole-answer path is never rephrased.
 */
function sentenceOf(issue: zod.core.$ZodIssue, answer: unknown): string {
  if (issue.path.length === 0 || memberAt(answer, issue.path) !== undefined) {
    return issue.message;
  }
  if (issue.code === "invalid_value") {
    return `Not answered — one of ${offeredMembers(issue.values)} is required.`;
  }
  return "Not answered — required.";
}

/** A thrown value's message, or a stated absence of one. */
function thrownDetail(thrown: unknown): string {
  return thrown instanceof Error && thrown.message.length > 0
    ? thrown.message
    : "the schema reader gave no reason";
}
