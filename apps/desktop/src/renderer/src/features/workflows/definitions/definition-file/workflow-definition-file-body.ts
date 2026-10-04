// The hashed part of a definition file (name, entry record, phase sequence), written and read in
// one module so the member names and write order are stated once. Every present member is
// carried and an unknown one is refused: dropping `toolBindings` or `config` would hand back a
// definition that hashes differently while reporting success. Absence is never read as a value.

import type { WorkflowToolBinding } from "@ai-sidekicks/contracts/workflow-definition";

import {
  WORKFLOW_FAILURE_BEHAVIORS,
  WORKFLOW_GATE_TYPES,
  WORKFLOW_PARALLEL_JOIN_POLICIES,
  WORKFLOW_PHASE_TYPES,
  WORKFLOW_START_MODES,
  firstUnadmittedKey,
  readVocabularyMember,
  type WorkflowEntry,
  type WorkflowParallelJoinPolicy,
  type WorkflowPhaseDefinition,
  type WorkflowVersionBody,
} from "@renderer/services/wire-shapes/workflow-definition-body.js";
import { readToolBindings, toolBindingFileRecords } from "./workflow-definition-file-bindings.js";
import { isWireRecord } from "@renderer/lib/wire-record.js";
import { readWireString } from "@renderer/lib/wire-strings.js";

/**
 * The hashed body's top-level members in write order. The document module builds its admitted
 * key set from this tuple, so membership is declared once.
 */
export const DEFINITION_BODY_KEYS = ["name", "entry", "phaseDefinitions"] as const;

/** The members one phase carries, in the order a file writes them. */
const PHASE_KEYS = [
  "phaseId",
  "name",
  "type",
  "gateType",
  "failureBehavior",
  "toolBindings",
  "goBackTo",
  "dependsOn",
  "parallelJoinPolicy",
  "config",
] as const;

/** The one member an entry record carries. */
const ENTRY_KEYS = ["startMode"] as const;

/**
 * What the hashed body of a file states. `entry` is optional here and required on the served
 * body: the daemon materializes it, and a create request may omit it.
 */
export interface WorkflowDefinitionFileBody {
  readonly name: string;
  readonly entry?: WorkflowEntry;
  readonly phaseDefinitions: readonly WorkflowPhaseDefinition[];
}

/** The served body's hashed members, keyed and ordered as a file writes them. */
export function definitionBodyFileRecord(
  body: WorkflowVersionBody,
): Readonly<Record<(typeof DEFINITION_BODY_KEYS)[number], unknown>> {
  return {
    name: body.name,
    entry: { startMode: body.entry.startMode },
    phaseDefinitions: body.phaseDefinitions.map(phaseFileRecord),
  };
}

/** The hashed body a document states, or the sentence naming what is wrong with it. */
export function readDefinitionBody(
  document: Readonly<Record<string, unknown>>,
): WorkflowDefinitionFileBody | string {
  const name = readWireString(document["name"]);
  if (name === undefined) {
    return "A definition file carries a non-empty `name`; this one does not.";
  }
  const entry = readEntry(document);
  if (typeof entry === "string") {
    return entry;
  }
  const phaseDefinitions = readPhaseDefinitions(document["phaseDefinitions"]);
  if (typeof phaseDefinitions === "string") {
    return phaseDefinitions;
  }
  return { name, ...entry, phaseDefinitions };
}

/** One phase as a file writes it: the required members, then whichever it carries. */
function phaseFileRecord(phase: WorkflowPhaseDefinition): Readonly<Record<string, unknown>> {
  return {
    phaseId: phase.phaseId,
    name: phase.name,
    type: phase.type,
    gateType: phase.gateType,
    failureBehavior: phase.failureBehavior,
    ...(phase.toolBindings === undefined
      ? {}
      : { toolBindings: toolBindingFileRecords(phase.toolBindings) }),
    ...(phase.goBackTo === undefined ? {} : { goBackTo: phase.goBackTo }),
    ...(phase.dependsOn === undefined ? {} : { dependsOn: phase.dependsOn }),
    ...(phase.parallelJoinPolicy === undefined
      ? {}
      : { parallelJoinPolicy: phase.parallelJoinPolicy }),
    ...(phase.config === undefined ? {} : { config: phase.config }),
  };
}

/**
 * The entry record where the file states one, or the sentence refusing it. An absent entry is
 * not a refusal (the daemon materializes `manual`), but an unsupported one is: reading
 * `schedule` as `manual` would change when the workflow runs and report success.
 */
function readEntry(
  document: Readonly<Record<string, unknown>>,
): { readonly entry?: WorkflowEntry } | string {
  if (!("entry" in document)) {
    return {};
  }
  const entry = document["entry"];
  if (!isWireRecord(entry)) {
    return "This file states an `entry` that is not an entry record.";
  }
  const unadmitted = firstUnadmittedKey(entry, ENTRY_KEYS);
  if (unadmitted !== undefined) {
    return `This file's entry record carries \`${unadmitted}\`, which an entry record does not.`;
  }
  const supplied = entry["startMode"];
  const startMode = readVocabularyMember(supplied, WORKFLOW_START_MODES);
  if (startMode !== undefined) {
    return { entry: { startMode } };
  }
  const named = readWireString(supplied);
  return named === undefined
    ? "This file's entry record states no `startMode`, so there is no way to read how it starts."
    : `This file's entry record states \`startMode: ${named}\`, which ` +
        "is not a start mode this build runs.";
}

/** The phase sequence, or the sentence saying which phase is wrong and how. */
function readPhaseDefinitions(value: unknown): readonly WorkflowPhaseDefinition[] | string {
  if (!Array.isArray(value) || value.length === 0) {
    return "A definition file carries at least one phase in `phaseDefinitions`.";
  }
  const phases: WorkflowPhaseDefinition[] = [];
  for (const [index, candidate] of value.entries()) {
    const phase = readPhaseDefinition(candidate, `Phase ${String(index + 1)}`);
    if (typeof phase === "string") {
      return phase;
    }
    phases.push(phase);
  }
  return phases;
}

/** One phase record, or the sentence naming what is wrong with it. */
function readPhaseDefinition(value: unknown, phaseProse: string): WorkflowPhaseDefinition | string {
  if (!isWireRecord(value)) {
    return `${phaseProse} is not a phase record.`;
  }
  const unadmitted = firstUnadmittedKey(value, PHASE_KEYS);
  if (unadmitted !== undefined) {
    return `${phaseProse} carries \`${unadmitted}\`, which a phase does not.`;
  }
  const phaseId = readWireString(value["phaseId"]);
  const name = readWireString(value["name"]);
  if (phaseId === undefined || name === undefined) {
    return `${phaseProse} is missing its \`phaseId\` or its \`name\`.`;
  }
  const type = readVocabularyMember(value["type"], WORKFLOW_PHASE_TYPES);
  const gateType = readVocabularyMember(value["gateType"], WORKFLOW_GATE_TYPES);
  const failureBehavior = readVocabularyMember(
    value["failureBehavior"],
    WORKFLOW_FAILURE_BEHAVIORS,
  );
  if (type === undefined || gateType === undefined || failureBehavior === undefined) {
    return (
      `${phaseProse} states a \`type\`, \`gateType\` or ` +
      `\`failureBehavior\` this console does not know.`
    );
  }
  const toolBindings = readPhaseToolBindings(value, phaseProse);
  if (typeof toolBindings === "string") {
    return toolBindings;
  }
  const goBackTo = readGoBackTo(value, phaseProse);
  if (typeof goBackTo === "string") {
    return goBackTo;
  }
  const dependsOn = readDependsOn(value, phaseProse);
  if (typeof dependsOn === "string") {
    return dependsOn;
  }
  const parallelJoinPolicy = readParallelJoinPolicy(value, phaseProse);
  if (typeof parallelJoinPolicy === "string") {
    return parallelJoinPolicy;
  }
  const config = readPhaseConfig(value, phaseProse);
  if (typeof config === "string") {
    return config;
  }
  return {
    phaseId,
    name,
    type,
    gateType,
    failureBehavior,
    ...toolBindings,
    ...goBackTo,
    ...dependsOn,
    ...parallelJoinPolicy,
    ...config,
  };
}

/** The phase's tool bindings where it carries any. */
function readPhaseToolBindings(
  value: Readonly<Record<string, unknown>>,
  phaseProse: string,
): { readonly toolBindings?: readonly WorkflowToolBinding[] } | string {
  if (!("toolBindings" in value)) {
    return {};
  }
  const toolBindings = readToolBindings(value["toolBindings"], phaseProse);
  return typeof toolBindings === "string" ? toolBindings : { toolBindings };
}

/** The state-reset target where the phase's failure behavior names one. */
function readGoBackTo(
  value: Readonly<Record<string, unknown>>,
  phaseProse: string,
): { readonly goBackTo?: string } | string {
  if (!("goBackTo" in value)) {
    return {};
  }
  const goBackTo = readWireString(value["goBackTo"]);
  return goBackTo === undefined
    ? `${phaseProse} states a \`goBackTo\` that is not a phase id.`
    : { goBackTo };
}

/**
 * The predecessor list where the file carries one. An empty list is admitted and differs from
 * an absent one: an entry-node successor has an empty list, while omitting the member on every
 * phase declares the sequential chain by array order.
 */
function readDependsOn(
  value: Readonly<Record<string, unknown>>,
  phaseProse: string,
): { readonly dependsOn?: readonly string[] } | string {
  if (!("dependsOn" in value)) {
    return {};
  }
  const supplied = value["dependsOn"];
  if (!Array.isArray(supplied)) {
    return `${phaseProse} states a \`dependsOn\` that is not a list of phase ids.`;
  }
  const dependsOn = supplied.filter(
    (entry): entry is string => readWireString(entry) !== undefined,
  );
  return dependsOn.length === supplied.length
    ? { dependsOn }
    : `${phaseProse} states a predecessor in \`dependsOn\` that is not a phase id.`;
}

/** The join policy where the phase carries one. */
function readParallelJoinPolicy(
  value: Readonly<Record<string, unknown>>,
  phaseProse: string,
): { readonly parallelJoinPolicy?: WorkflowParallelJoinPolicy } | string {
  if (!("parallelJoinPolicy" in value)) {
    return {};
  }
  const parallelJoinPolicy = readVocabularyMember(
    value["parallelJoinPolicy"],
    WORKFLOW_PARALLEL_JOIN_POLICIES,
  );
  return parallelJoinPolicy === undefined
    ? `${phaseProse} states a \`parallelJoinPolicy\` this console does not know.`
    : { parallelJoinPolicy };
}

/**
 * The phase's execution and human-form configuration where it carries one. Carried verbatim:
 * the registered shape is an open record, and what config means is the engine's.
 */
function readPhaseConfig(
  value: Readonly<Record<string, unknown>>,
  phaseProse: string,
): { readonly config?: Readonly<Record<string, unknown>> } | string {
  if (!("config" in value)) {
    return {};
  }
  const config = value["config"];
  return isWireRecord(config)
    ? { config }
    : `${phaseProse} states a \`config\` that is not a record of settings.`;
}
