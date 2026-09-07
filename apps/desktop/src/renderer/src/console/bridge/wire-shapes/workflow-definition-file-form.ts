// The definition file itself: the bytes an export writes, and the reading of the bytes
// an import was handed.
//
// ONE MODULE FOR BOTH SIDES, which is `apps/desktop/AGENTS.md`'s rule for a producer
// and a consumer of one encoding: the marker, the top-level parts, and the target a
// caller supplies are stated once, so a file this console wrote is a file this console
// reads. `workflow-definition-file-body.ts` beside this one owns what goes INSIDE the
// hashed part, on the same terms and for the same reason.
//
// AND IT IS IN `bridge/` BECAUSE THE IMPORT SIDE IS A VALIDATOR. What arrives is text a
// person pasted, and what has to come out is a typed request body — so this reads an
// untyped value against closed sets and refuses what does not fit, which is precisely
// what a view family may not hold. A pane consumes the ANSWER, here a parsed body or a
// reason, and never the reading that produced one. `approvals/approval-records.ts` is
// the same call made for the same reason one directory over.
//
// WHAT THE FILE IS. YAML, and one dialect of it. `Spec-017 §Definition file form —
// export and import (C-17)` gives a definition exactly one canonical file form and
// requires the round trip to close in both directions — builder to file to CLI, and CLI
// to file back to the builder — so a file the SDK writes as ordinary block mappings has
// to import here, and a file written here has to parse in a conforming CLI. JSON is
// valid YAML, so a JSON-shaped document still reads; the reverse was not true while
// this parsed JSON, which is what made the console incompatible with one of the form's
// primary producers.
//
// AND THE DOCUMENT HAS EXACTLY TWO TOP-LEVEL PARTS, plus the marker that says which
// schema they are in: the hashed definition body, and an optional `layout` section that
// is outside the hash and is IGNORED here — an importer that does not want canvas
// geometry loses nothing executable. There is no third section. Provenance a read
// carries — the version id, the content hash, where a file came from — is a fact about
// the SERVER's copy, and writing it into the portable dialect would make every file
// this console exported unreadable to a conforming parser, which treats an unknown
// top-level key as a refusal. A surface that wants to show where a version came from
// reads it from the version read it already holds.
//
// THE MARKER IS A STRING THAT YAML WOULD OTHERWISE MAKE A NUMBER. `1.0` unquoted
// resolves to the number 1 under the core schema — the minor is gone, and `1.10` and
// `1.1` become the same value — so an export writes it double-quoted and an import
// reads it off the scalar NODE rather than off the resolved value, which is what lets a
// hand-written or CLI-written file that left it unquoted still read as `1.0`.
//
// AND THE MARKER IS CHECKED FOR SHAPE, NEVER AGAINST A CONSTANT. The daemon stores the
// schema version as an `N.N` string under a CHECK of that shape, so that shape is what
// a file can carry; a parser comparing against a literal would instead reject the
// daemon's own files the first time it revised the marker. What the check is for is
// telling a workflow definition from the other text a person might paste, and telling a
// marker apart from a version string nothing could have stored.
//
// AND THE MARKER IS NOT SENT. `WorkflowDefinitionCreateBody` carries no schema member:
// it is a property of the FILE, so it is read to recognise one and then dropped, and a
// parser that smuggled it into the request would be widening a registered shape.
//
// WHY THE CODEC ARRIVES THROUGH `import()`. This module is on the console's initial
// import graph — the bridge door publishes it and the renderer root reaches that door —
// while the only surface that exports or imports a definition is a lazily loaded pane
// body. A static `import "yaml"` would therefore charge the parser to every launch,
// including every launch that never opens a definition, against the initial-bundle
// budget `Spec-023 §Console Design (Meridian)` sets; the package declares no
// side-effect-free flag, so a bundler cannot drop it on its own. Reached only through
// `import()`, it is emitted as its own chunk and fetched the first time somebody
// presses export or import. No memo is kept beside it: the module map is already the
// memo, there is no render state to observe, and a third copy of the loader class
// `terminal/emulator/emulator-loader.ts` and the phase graph's own already carry would
// be a class written for a caller that has no use for it.

import type { Scalar } from "yaml";

import {
  DEFINITION_BODY_KEYS,
  definitionBodyFileRecord,
  readDefinitionBody,
} from "./workflow-definition-file-body.js";
import {
  firstUnadmittedKey,
  type WorkflowDefinitionCreateBody,
  type WorkflowVersionBody,
} from "./workflow-definition-body.js";
import type { WorkflowDefinitionScope } from "./workflow-projection.js";
import { isWireRecord } from "../../core/index.js";

/** The top-level member a definition file carries its schema marker under. */
const SCHEMA_MARKER_KEY = "ai-sidekicks-schema";

/**
 * The shape a stored schema version has, and the whole of what is checked.
 *
 * `N.N`, which is the store's own `GLOB '[0-9]*.[0-9]*'` CHECK read as a pattern: a
 * marker outside it is a string the daemon could not have stored and this console could
 * not have been sent, whatever it says.
 */
const SCHEMA_MARKER_STORAGE_SHAPE = /^[0-9]+\.[0-9]+$/;

/** The second top-level part: canvas geometry, outside the hash, and ignored here. */
const LAYOUT_KEY = "layout";

/**
 * Every top-level key a definition file may carry, added up rather than restated.
 *
 * The marker, the hashed body's own members, and the optional layout section — so the
 * body's membership stays declared in one place and this set moves when it does.
 */
const FILE_TOP_LEVEL_KEYS: readonly string[] = [
  SCHEMA_MARKER_KEY,
  ...DEFINITION_BODY_KEYS,
  LAYOUT_KEY,
];

/**
 * How the document is read, and every option is a decision.
 *
 * `1.2` and the `core` schema are the dialect the form is written in — 1.1's octal and
 * sexagesimal resolutions and its timestamp type would make a value's meaning depend on
 * which YAML a producer used. `uniqueKeys` turns a repeated key into a document error
 * rather than a silent last-one-wins, which on a phase record would change what runs.
 * `prettyErrors` is what puts a line and a column in the sentence a person reads.
 */
const YAML_READER_OPTIONS = {
  version: "1.2",
  schema: "core",
  uniqueKeys: true,
  prettyErrors: true,
} as const;

/**
 * How the document is written: a fixed key order, two-space indentation, no folding.
 *
 * `lineWidth: 0` disables the writer's line folding. A folded long instruction is legal
 * YAML that reads back identically, and it also moves every following line whenever an
 * unrelated word changes — which is the diff of a file people are meant to keep in a
 * repository.
 */
const YAML_WRITER_OPTIONS = { indent: 2, lineWidth: 0 } as const;

/**
 * Serialize one served version body into the file form.
 *
 * The VERSION body and not the definition read, because a file is one version's bytes:
 * the definition read carries the identity and the phase sequence and no schema marker,
 * so a file written from it could not say which schema it is in.
 *
 * ASYNCHRONOUS BECAUSE THE WRITER ARRIVES IN A CHUNK — see the header. The only way
 * this rejects is a chunk that did not load, which is a fact about the install rather
 * than about the definition, so it travels as a rejection to the surface's own
 * rejection seam rather than as a sentence about a file that is perfectly fine.
 */
export async function serializeWorkflowDefinitionFile(body: WorkflowVersionBody): Promise<string> {
  const { Document, Scalar: ScalarNode } = await import("yaml");
  const fileDocument = new Document({}, { version: "1.2", schema: "core" });
  // Double-quoted deliberately and not left to the writer's own judgement: the value is
  // a string, and the quoting is what keeps it one on the way back in.
  const marker = new ScalarNode(body.schemaVersion);
  marker.type = ScalarNode.QUOTE_DOUBLE;
  fileDocument.set(SCHEMA_MARKER_KEY, marker);
  const bodyRecord = definitionBodyFileRecord(body);
  for (const key of DEFINITION_BODY_KEYS) {
    fileDocument.set(key, bodyRecord[key]);
  }
  return fileDocument.toString(YAML_WRITER_OPTIONS);
}

/** What a parse answers with: the request body, or the reason there is none. */
export type WorkflowDefinitionFileReading =
  | { readonly status: "parsed"; readonly body: WorkflowDefinitionCreateBody }
  | { readonly status: "invalid"; readonly reason: string };

/** Everything an imported file does not carry and the caller has to supply. */
export interface WorkflowDefinitionImportTarget {
  readonly sessionId: string;
  readonly scope: WorkflowDefinitionScope;
  readonly scopeRef: string | undefined;
}

/**
 * Read pasted text as a definition file, and compose the create body it stands for.
 *
 * THE TARGET IS THE CALLER'S AND NOT THE FILE'S. A file carries no session and no
 * scope — it is bytes that travelled between machines — and a parser that took a scope
 * out of one would let a pasted file decide where it lands, which is the decision the
 * daemon's operator-scope authorization is keyed on. So the caller states the target
 * and the file states the definition.
 *
 * EVERY REFUSAL IS A SENTENCE AND NEVER A THROW. The caller renders this beside the
 * paste box, so what a person needs is which member is wrong; an exception would reach
 * a boundary that can only say that something failed. The one thing that still rejects
 * is the chunk fetch above it, which is not a fact about the text at all.
 */
export async function parseWorkflowDefinitionFile(
  text: string,
  target: WorkflowDefinitionImportTarget,
): Promise<WorkflowDefinitionFileReading> {
  const { isScalar, parseAllDocuments } = await import("yaml");
  const [fileDocument, ...furtherDocuments] = parseAllDocuments(text, YAML_READER_OPTIONS);
  if (fileDocument === undefined) {
    return invalid("This text carries no document, so there is no definition in it to read.");
  }
  if (furtherDocuments.length > 0) {
    return invalid(
      "This text carries more than one YAML document, and a definition file is exactly one.",
    );
  }
  const [documentError] = fileDocument.errors;
  if (documentError !== undefined) {
    return invalid(`This is not YAML that can be read: ${firstLineOf(documentError.message)}`);
  }
  const contents = readDocumentContents(fileDocument);
  if (typeof contents === "string") {
    return invalid(contents);
  }
  const markerNode = fileDocument.get(SCHEMA_MARKER_KEY, true);
  const marker = isScalar(markerNode) ? schemaMarkerOf(markerNode) : undefined;
  if (marker === undefined) {
    return invalid(
      `This file carries no \`${SCHEMA_MARKER_KEY}\`, so it is not a workflow definition file.`,
    );
  }
  if (!SCHEMA_MARKER_STORAGE_SHAPE.test(marker)) {
    return invalid(
      `This file's \`${SCHEMA_MARKER_KEY}\` is \`${marker}\`, and a schema version is written as two numbers with a dot between them.`,
    );
  }
  const unadmitted = firstUnadmittedKey(contents, FILE_TOP_LEVEL_KEYS);
  if (unadmitted !== undefined) {
    return invalid(
      `This file carries a top-level \`${unadmitted}\`, which a definition file does not — a conforming reader refuses one rather than ignoring it.`,
    );
  }
  if (LAYOUT_KEY in contents && !isWireRecord(contents[LAYOUT_KEY])) {
    return invalid(`This file's \`${LAYOUT_KEY}\` is not a section of canvas geometry.`);
  }
  const definitionBody = readDefinitionBody(contents);
  if (typeof definitionBody === "string") {
    return invalid(definitionBody);
  }
  return {
    status: "parsed",
    body: {
      sessionId: target.sessionId,
      name: definitionBody.name,
      scope: target.scope,
      // Spread on the arm that has one: `scopeRef` is optional under
      // `exactOptionalPropertyTypes`, and a `shared` target refers to nothing narrower
      // rather than to an empty path.
      ...(target.scopeRef === undefined ? {} : { scopeRef: target.scopeRef }),
      // Carried only where the file states one. An absent entry is not a refusal: the
      // daemon materializes the one V1 start mode, and inventing it here would be this
      // console answering a question the file deliberately left open.
      ...(definitionBody.entry === undefined ? {} : { entry: definitionBody.entry }),
      phaseDefinitions: definitionBody.phaseDefinitions,
    },
  };
}

/**
 * The document's own value as a record with keys, or the sentence refusing it.
 *
 * THE CONVERSION IS GUARDED because it is the one step of the read that can throw:
 * resolving aliases is where a document with an anchor referenced from an anchor
 * expands, and the library's alias cap raises rather than returning a value. A caller
 * pasting that gets a sentence like every other refusal here.
 *
 * The parameter is STRUCTURAL — the one method this read needs — so the guard is
 * stated here rather than trusted to a caller, and the helper says exactly what it asks
 * of the document it is handed.
 */
function readDocumentContents(parsedDocument: {
  toJS: () => unknown;
}): Readonly<Record<string, unknown>> | string {
  try {
    const contents = parsedDocument.toJS();
    return isWireRecord(contents)
      ? contents
      : "A definition file is a document of named sections; this one is not.";
  } catch {
    // The value is not read, so nothing is stringified out of it: what a person needs
    // is that the document could not be resolved, and the reason it could not be is
    // that resolving it was refused.
    return "This document could not be resolved — it refers to itself more times than a file is read for.";
  }
}

/**
 * The marker a scalar node states, as the file wrote it.
 *
 * THE RESOLVED VALUE FIRST, AND THE SOURCE TEXT WHERE THERE IS NO STRING TO TAKE. A
 * quoted `"1.0"` resolves to the string `1.0`, which is exactly the marker and is
 * already unescaped; an unquoted `1.0` resolves to the NUMBER 1 under the core schema,
 * and only the source text still says which minor was written. Taking the source first
 * would read an escaped spelling back as its escape.
 */
function schemaMarkerOf(node: Scalar): string | undefined {
  if (typeof node.value === "string") {
    return node.value.length > 0 ? node.value : undefined;
  }
  return typeof node.source === "string" && node.source.length > 0 ? node.source : undefined;
}

/**
 * The first line of a parser error, which is the sentence in it.
 *
 * The library's pretty errors carry the sentence, then a blank line, then an excerpt of
 * the source with a caret under the offending column. The excerpt is the text the
 * person just pasted, so what travels is the sentence and the position it names.
 */
function firstLineOf(message: string): string {
  const [sentence] = message.split("\n");
  return sentence ?? message;
}

/** One invalid reading, so the arm is composed in one place. */
function invalid(reason: string): WorkflowDefinitionFileReading {
  return { status: "invalid", reason };
}
