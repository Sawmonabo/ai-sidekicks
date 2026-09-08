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
// THE ISSUE PATH TRAVELS AS SEGMENTS, BECAUSE A JOINED PATH IS NOT INJECTIVE. The library
// reports a path of property keys and array indices, and joining those with a dot
// collapses members a schema keeps apart: a property literally named `items.0` and the
// first entry of an array named `items` both spell `items.0`, and so do a property named
// `a.b` and a `b` nested inside an `a`. A surface keyed on that string draws one member's
// verdict under another member's control — or under both — which is a finding rendered
// about a value the schema said nothing about. So the segments travel whole, the lookup
// that matches a control to its findings compares them element by element through
// `isSameMemberPath`, and the one place a path has to become a string — a React key, an
// element id, a sentence naming the member — takes the RFC 6901 JSON Pointer that
// `encodeMemberPointer` composes, which escapes rather than collapses. One representation,
// one encoder, and no surface re-derives either.
//
// THE VERDICT DESCRIBES THE BYTES SENT, WHICH IS WHY IT CARRIES THEM. `safeParse` does
// not answer about the value it was handed — it answers about the value the schema READS
// that value as, and hands that reading back. A member declaring a `default` makes `{}`
// valid, because the reader supplies the member, so a report carrying only `valid` would
// be a verdict on `{ approver: "ada" }` rendered beside a form about to send `{}`. The
// accepted value therefore travels ON the clean arm, for the caller that has no other
// way to show it: the form's raw editor submits THAT, because its display is the person's
// own document and nothing rewrites it. A caller whose controls can show every member
// seeds them instead and submits what they hold — same rule, closed at the display rather
// than at the wire (`workflows/forms/use-schema-form.ts`).
//
// AND THE LIBRARY CANNOT BE ASKED FOR LESS. `FromJSONSchemaParams` declares exactly two
// members, `defaultTarget` and `registry` (`zod/v4/classic/from-json-schema.d.ts` at the
// 4.3.6 pin), so there is no switch that compiles a schema without its defaults — the
// choice is between carrying the accepted value and describing a value nobody sends.
// Measured at that same pin, default application is also the only difference the reader
// introduces: an unknown member passes through rather than being stripped,
// `additionalProperties: false` refuses rather than trims, and a `format` annotation
// transforms nothing. So an accepted value is the composed answer plus the members the
// schema itself declares a value for, and never less than what somebody typed.
//
// NO SCHEMA COMPILATION IS CACHED. A validator is minted per schema per mount and lives
// as long as the form does — the console keeps no unbounded cache keyed on values it
// does not own, and a phase definition's schema is read once per open.

import * as zod from "zod";

/**
 * Where one member sits inside an answer: property keys and array positions, in order.
 *
 * `number` is not decoration. The reader reports an array position AS a number, and that
 * is the only thing keeping it apart from a property whose name happens to be a digit —
 * a distinction any single-string spelling of the path throws away.
 */
export type SchemaMemberPath = readonly (string | number)[];

/** One thing wrong with an answer, addressed the way the form addresses its controls. */
export interface SchemaValidationIssue {
  /** Where the finding is, as segments. Empty for an issue about the whole answer. */
  readonly memberPath: SchemaMemberPath;
  /** The library's own sentence, carried verbatim. */
  readonly message: string;
}

/**
 * What checking one answer against one schema came back with.
 *
 * Two arms rather than one shape with an optional member, because the accepted value
 * exists on exactly one of them: a refused answer has no reading for the schema to hand
 * back, and a member that is sometimes there is a member every caller has to re-decide
 * whether to trust.
 */
export type SchemaValidationReport =
  | {
      readonly status: "valid";
      readonly issues: readonly SchemaValidationIssue[];
      /**
       * The value the schema accepted — what a submission composed from this answer
       * must carry.
       *
       * `unknown` for the reason the answer is: what a schema accepts is whatever that
       * schema describes, and this module proves nothing about the shape of it.
       */
      readonly acceptedValue: unknown;
    }
  | { readonly status: "invalid"; readonly issues: readonly SchemaValidationIssue[] };

/** A schema that can be checked against, or the honest statement that it cannot be. */
export type SchemaValidator =
  | { readonly status: "compiled"; readonly check: (answer: unknown) => SchemaValidationReport }
  | { readonly status: "uncompilable"; readonly detail: string };

/** The finding list a clean verdict carries. Held once; nothing ever writes to it. */
const NOTHING_WRONG: readonly SchemaValidationIssue[] = [];

/**
 * One segment as an RFC 6901 reference token.
 *
 * The escape character is replaced FIRST. Doing the separator first would then escape the
 * `~` this step just wrote, turning `a/b` into `a~01b` — a token that decodes to something
 * nobody wrote.
 */
function referenceTokenOf(segment: string | number): string {
  return String(segment).replace(/~/g, "~0").replace(/\//g, "~1");
}

/**
 * One member path as the RFC 6901 JSON Pointer that names it — the string spelling, where
 * a string is what the platform takes.
 *
 * Reversible where a join is not: `/` and `~` are the two characters that grammar gives
 * meaning to, so a segment carrying either is escaped rather than left to read as a
 * boundary. The empty path encodes as the empty string, which is that grammar's own name
 * for the whole document and is what an issue about the answer itself carries.
 */
export function encodeMemberPointer(path: SchemaMemberPath): string {
  return path.map((segment) => `/${referenceTokenOf(segment)}`).join("");
}

/**
 * Whether two member paths address the same member.
 *
 * Element by element and by identity, so a property named `"0"` and the array position `0`
 * stay apart. This is the comparison every lookup makes, and it is here rather than beside
 * one of them because a second comparison is how two readings of one path come apart.
 */
export function isSameMemberPath(left: SchemaMemberPath, right: SchemaMemberPath): boolean {
  return left.length === right.length && left.every((segment, at) => segment === right[at]);
}

/**
 * A library issue path, carried as segments and never as one joined string.
 *
 * A number stays a number, which is what the array position is. Everything else becomes a
 * string, so the mapping is total over the `PropertyKey` the library declares.
 */
function memberPathOf(path: readonly PropertyKey[]): SchemaMemberPath {
  return path.map((segment) => (typeof segment === "number" ? segment : String(segment)));
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
        // `parsed.data` and never the answer that went in: the header's rule, and the
        // one line that makes the verdict and the submission be about one value.
        return { status: "valid", issues: NOTHING_WRONG, acceptedValue: parsed.data };
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
