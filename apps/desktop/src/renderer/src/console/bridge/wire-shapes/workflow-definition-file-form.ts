// The definition file form: the bytes an export writes, and the reading of the bytes
// an import was handed.
//
// ONE MODULE FOR BOTH SIDES, which is `apps/desktop/AGENTS.md`'s rule for a producer
// and a consumer of one encoding: the member names, the marker, and the phase-record
// shape are stated once, so a file this console wrote is a file this console reads.
// Split in two they would agree until one of them grew a member.
//
// AND IT IS IN `bridge/` BECAUSE THE IMPORT SIDE IS A VALIDATOR. What arrives is text
// a person pasted, and what has to come out is a typed request body — so this reads an
// untyped value against closed sets and refuses what does not fit, which is precisely
// what a view family may not hold. A pane consumes the ANSWER, here a parsed body or a
// reason, and never the reading that produced one. `approvals/approval-records.ts` is
// the same call made for the same reason one directory over.
//
// WHAT THE FILE IS, AND WHAT IT DELIBERATELY IS NOT
//
// It is JSON with a fixed key order and two-space indentation — a file a person opens,
// diffs, and puts in a repository. It is NOT the RFC 8785 canonicalization the content
// hash is computed over, and the difference matters: this console computes no hash and
// must not look as though it did. The daemon canonicalizes what it is sent and answers
// with the hash it computed; a renderer that emitted canonical bytes would be inviting
// the reader to compare a string it produced against a hash it did not.
//
// THE MARKER IS CHECKED FOR PRESENCE AND NEVER FOR VALUE. No corpus document registers
// a schema-version string, so a parser that compared one against a constant would be
// enforcing a wire fact traceable to nothing — and would reject the daemon's own files
// the first time it revised the marker. What the check is for is telling a workflow
// definition from the other JSON a person might paste, which presence answers.
//
// AND THE MARKER IS NOT SENT. `WorkflowDefinitionCreateBody` carries no schema member:
// it is a property of the FILE, so it is read to recognise one and then dropped, and a
// parser that smuggled it into the request would be widening a registered shape.

import {
  WORKFLOW_FAILURE_BEHAVIORS,
  WORKFLOW_GATE_TYPES,
  WORKFLOW_PARALLEL_JOIN_POLICIES,
  WORKFLOW_PHASE_TYPES,
  type WorkflowDefinitionCreateBody,
  type WorkflowPhaseDefinition,
  type WorkflowVersionBody,
} from "./workflow-definition-body.js";
import type { WorkflowDefinitionScope } from "./workflow-projection.js";
import { isWireRecord } from "../../core/index.js";

/** The member an exported file carries its marker under, read and written once. */
const SCHEMA_MEMBER = "schemaVersion";

/**
 * Serialize one served version body into the file form.
 *
 * The VERSION body and not the definition read, because a file is one version's bytes:
 * the definition read carries the identity and the phase sequence and no content hash
 * or marker, so a file written from it would be a definition file with no way to say
 * which schema it is in or which version it came from.
 *
 * `contentHash` and `workflowVersionId` ride along as provenance. They are not sent
 * back on an import — the create request carries neither, and a hash is the daemon's
 * answer rather than a caller's claim — but a file that could not say which version it
 * was exported from is a file nobody can trace.
 */
export function serializeWorkflowDefinitionFile(body: WorkflowVersionBody): string {
  return `${JSON.stringify(
    {
      [SCHEMA_MEMBER]: body.schemaVersion,
      name: body.name,
      entry: body.entry,
      phaseDefinitions: body.phaseDefinitions,
      exportedFrom: {
        definitionId: body.definitionId,
        versionNumber: body.versionNumber,
        workflowVersionId: body.workflowVersionId,
        contentHash: body.contentHash,
      },
    },
    undefined,
    2,
  )}\n`;
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
 * a boundary that can only say that something failed.
 */
export function parseWorkflowDefinitionFile(
  text: string,
  target: WorkflowDefinitionImportTarget,
): WorkflowDefinitionFileReading {
  const parsed = parseJson(text);
  if (parsed === undefined) {
    return invalid("This is not JSON, so there is no definition in it to read.");
  }
  if (!isWireRecord(parsed)) {
    return invalid("A definition file is a JSON object; this is not one.");
  }
  if (typeof parsed[SCHEMA_MEMBER] !== "string" || parsed[SCHEMA_MEMBER] === "") {
    return invalid(
      "This file carries no `schemaVersion`, so it is not a workflow definition file.",
    );
  }
  const name = parsed["name"];
  if (typeof name !== "string" || name === "") {
    return invalid("A definition file carries a non-empty `name`; this one does not.");
  }
  const phases = readPhaseDefinitions(parsed["phaseDefinitions"]);
  if (typeof phases === "string") {
    return invalid(phases);
  }
  return {
    status: "parsed",
    body: {
      sessionId: target.sessionId,
      name,
      scope: target.scope,
      // Spread on the arm that has one: `scopeRef` is optional under
      // `exactOptionalPropertyTypes`, and a `shared` target refers to nothing
      // narrower rather than to an empty path.
      ...(target.scopeRef === undefined ? {} : { scopeRef: target.scopeRef }),
      // The entry record is carried only where the file states one the shape admits.
      // `startMode` has exactly one member, so an absent or unrecognised entry is a
      // file that says nothing about how the definition starts — and the create
      // request's own member is optional for exactly that case.
      ...(readEntry(parsed["entry"]) ? { entry: { startMode: "manual" as const } } : {}),
      phaseDefinitions: phases,
    },
  };
}

/** `undefined` for text that is not JSON at all, which is a different fact from a shape. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** Whether the file states the one entry mode the shape admits. */
function readEntry(value: unknown): boolean {
  return isWireRecord(value) && value["startMode"] === "manual";
}

/**
 * The phase sequence, or the sentence saying which phase is wrong.
 *
 * A STRING FOR THE FAILURE ARM rather than a second result type: this is private to
 * the parse above, which widens whichever it gets into the one reading a caller reads.
 * Every closed member is checked against the tuple that DECLARES it — never against a
 * literal spelled here — so a vocabulary the wire shapes widen is admitted by this
 * parser in the same edit.
 */
function readPhaseDefinitions(value: unknown): readonly WorkflowPhaseDefinition[] | string {
  if (!Array.isArray(value) || value.length === 0) {
    return "A definition file carries at least one phase in `phaseDefinitions`.";
  }
  const phases: WorkflowPhaseDefinition[] = [];
  for (const [index, candidate] of value.entries()) {
    const phase = readPhaseDefinition(candidate);
    if (phase === undefined) {
      return `Phase ${String(index + 1)} is missing an id, a name, or one of its type, gate and failure members.`;
    }
    phases.push(phase);
  }
  return phases;
}

/** One phase record, or `undefined` for one this console will not submit. */
function readPhaseDefinition(value: unknown): WorkflowPhaseDefinition | undefined {
  if (!isWireRecord(value)) {
    return undefined;
  }
  const phaseId = value["phaseId"];
  const name = value["name"];
  const type = readMemberOf(value["type"], WORKFLOW_PHASE_TYPES);
  const gateType = readMemberOf(value["gateType"], WORKFLOW_GATE_TYPES);
  const failureBehavior = readMemberOf(value["failureBehavior"], WORKFLOW_FAILURE_BEHAVIORS);
  if (typeof phaseId !== "string" || phaseId === "" || typeof name !== "string" || name === "") {
    return undefined;
  }
  if (type === undefined || gateType === undefined || failureBehavior === undefined) {
    return undefined;
  }
  const goBackTo = value["goBackTo"];
  const parallelJoinPolicy = readMemberOf(
    value["parallelJoinPolicy"],
    WORKFLOW_PARALLEL_JOIN_POLICIES,
  );
  return {
    phaseId,
    name,
    type,
    gateType,
    failureBehavior,
    // THE OPTIONAL MEMBERS ARE CARRIED AND NEVER INVENTED. A file stating no
    // dependency states a phase with no dependency, and a default written here would
    // be this console authoring a sequence nobody typed.
    ...(typeof goBackTo === "string" && goBackTo !== "" ? { goBackTo } : {}),
    ...(parallelJoinPolicy === undefined ? {} : { parallelJoinPolicy }),
    ...(readDependsOn(value["dependsOn"]) ?? {}),
  };
}

/** The dependency list, where the file carries one written entirely in ids. */
function readDependsOn(value: unknown): { readonly dependsOn: readonly string[] } | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const dependsOn = value.filter(
    (entry): entry is string => typeof entry === "string" && entry !== "",
  );
  return dependsOn.length === value.length ? { dependsOn } : undefined;
}

/**
 * One member of a closed vocabulary, read off an untyped value.
 *
 * Generic over the tuple so each caller narrows to its own union rather than to
 * `string`: the four vocabularies are four different closed sets, and one reader
 * answering `string` would push the narrowing back to every call site.
 */
function readMemberOf<TMember extends string>(
  value: unknown,
  vocabulary: readonly TMember[],
): TMember | undefined {
  return typeof value === "string" && (vocabulary as readonly string[]).includes(value)
    ? (value as TMember)
    : undefined;
}

/** One invalid reading, so the arm is composed in one place. */
function invalid(reason: string): WorkflowDefinitionFileReading {
  return { status: "invalid", reason };
}
