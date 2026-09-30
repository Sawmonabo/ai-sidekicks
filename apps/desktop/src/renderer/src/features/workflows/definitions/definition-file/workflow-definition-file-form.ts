// The definition file itself: the bytes an export writes and the reading of an import, in one
// module so a file this console wrote is a file it reads. It is YAML (JSON reads too, being
// YAML), so a file the CLI or SDK writes imports here and the reverse. The document is a schema
// marker plus the hashed body and an optional `layout` that is ignored; any other top-level key
// is refused, as a conforming reader does. The marker is written double-quoted because unquoted
// `1.0` resolves to the number 1, is read off the scalar node, is checked for the `N.N` shape
// and never against a constant, and is not sent in the create request. The parser is imported
// statically because the codec reaches this module through `import()`, keeping it in one
// on-demand chunk; the two entries are synchronous.

import { Document, Scalar, isScalar, parseAllDocuments } from "yaml";

import {
  DEFINITION_BODY_KEYS,
  definitionBodyFileRecord,
  readDefinitionBody,
} from "./workflow-definition-file-body.js";
import {
  firstUnadmittedKey,
  type WorkflowDefinitionCreateBody,
  type WorkflowVersionBody,
} from "@renderer/services/wire-shapes/workflow-definition-body.js";
import type { WorkflowDefinitionScope } from "@ai-sidekicks/contracts";
import { isWireRecord } from "@renderer/lib/wire-record.js";

/** The top-level member a definition file carries its schema marker under. */
const SCHEMA_MARKER_KEY = "ai-sidekicks-schema";

/**
 * The shape a stored schema version has, and the whole of what is checked: `N.N`, the store's
 * own CHECK read as a pattern.
 */
const SCHEMA_MARKER_STORAGE_SHAPE = /^[0-9]+\.[0-9]+$/;

/** The second top-level part: canvas geometry, outside the hash, and ignored here. */
const LAYOUT_KEY = "layout";

/**
 * Every top-level key a definition file may carry: the marker, the hashed body's members and
 * the optional layout, so the body's membership stays declared in one place.
 */
const FILE_TOP_LEVEL_KEYS: readonly string[] = [
  SCHEMA_MARKER_KEY,
  ...DEFINITION_BODY_KEYS,
  LAYOUT_KEY,
];

/**
 * How the document is read. `1.2` and the `core` schema avoid 1.1's octal, sexagesimal and
 * timestamp resolutions. `uniqueKeys` makes a repeated key an error instead of a silent
 * last-one-wins. `prettyErrors` puts a line and column in the sentence a person reads.
 */
const YAML_READER_OPTIONS = {
  version: "1.2",
  schema: "core",
  uniqueKeys: true,
  prettyErrors: true,
} as const;

/**
 * How the document is written: a fixed key order, two-space indentation, no folding. Folding
 * would move every following line when an unrelated word changes, which muddies the diff of a
 * file kept in a repository.
 */
const YAML_WRITER_OPTIONS = { indent: 2, lineWidth: 0 } as const;

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
 * Serialize one served version body into the file form. Takes the version body, not the
 * definition read, which carries no schema marker. Synchronous: only the chunk fetch, owned by
 * the codec, can fail ahead of it.
 */
export function serializeDefinitionFile(body: WorkflowVersionBody): string {
  const fileDocument = new Document({}, { version: "1.2", schema: "core" });
  // Double-quoted so the value stays a string on the way back in.
  const marker = new Scalar(body.schemaVersion);
  marker.type = Scalar.QUOTE_DOUBLE;
  fileDocument.set(SCHEMA_MARKER_KEY, marker);
  const bodyRecord = definitionBodyFileRecord(body);
  for (const key of DEFINITION_BODY_KEYS) {
    fileDocument.set(key, bodyRecord[key]);
  }
  return fileDocument.toString(YAML_WRITER_OPTIONS);
}

/**
 * Read pasted text as a definition file, and compose the create body it stands for. The target
 * is the caller's and not the file's: a file that chose its own scope would decide where it
 * lands, which the daemon's operator-scope authorization is keyed on. Every refusal is a
 * sentence, never a throw, so the caller can render which member is wrong beside the paste box.
 */
export function parseDefinitionFile(
  text: string,
  target: WorkflowDefinitionImportTarget,
): WorkflowDefinitionFileReading {
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
      // Spread only on the arm that has one: `scopeRef` is optional under
      // `exactOptionalPropertyTypes`, and a `shared` target has no narrower reference.
      ...(target.scopeRef === undefined ? {} : { scopeRef: target.scopeRef }),
      // Only where the file states one: the daemon materializes the only start mode, and
      // inventing it here would answer a question the file left open.
      ...(definitionBody.entry === undefined ? {} : { entry: definitionBody.entry }),
      phaseDefinitions: definitionBody.phaseDefinitions,
    },
  };
}

/**
 * The document's value as a keyed record, or the sentence refusing it. Guarded because
 * resolving aliases is the one step that can throw: the library's alias cap raises on a
 * document whose anchors expand from anchors.
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
    // Nothing is stringified from the value; a person needs only that it could not be resolved.
    return "This document could not be resolved — it refers to itself more times than a file is read for.";
  }
}

/**
 * The marker a scalar node states. The resolved string comes first, since it is already
 * unescaped; an unquoted `1.0` resolves to the number 1 under the core schema, so only the
 * source text says which minor was written.
 */
function schemaMarkerOf(node: Scalar): string | undefined {
  if (typeof node.value === "string") {
    return node.value.length > 0 ? node.value : undefined;
  }
  return typeof node.source === "string" && node.source.length > 0 ? node.source : undefined;
}

/**
 * The first line of a parser error, which is the sentence in it. The rest is an excerpt of the
 * pasted text with a caret under the offending column.
 */
function firstLineOf(message: string): string {
  const [sentence] = message.split("\n");
  return sentence ?? message;
}

/** One invalid reading, so the arm is composed in one place. */
function invalid(reason: string): WorkflowDefinitionFileReading {
  return { status: "invalid", reason };
}
