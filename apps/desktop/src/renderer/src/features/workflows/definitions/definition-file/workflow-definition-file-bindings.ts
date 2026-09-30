// A phase's tool bindings in the definition file: the reference a definition may carry, and
// the policy it may not. A binding with `enabled`, `approvalMode` or `idempotencyClass` is
// refused at parse, so an exported definition cannot import a weakened posture onto another
// machine. `user` bindings carry no `scopeRef`; `project` and `local` require one.

import {
  MCP_CONFIG_SCOPES,
  PROVIDER_NAMES,
  type McpServerBindingRef,
  type WorkflowToolBinding,
} from "@ai-sidekicks/contracts";

import {
  firstUnadmittedKey,
  readVocabularyMember,
} from "@renderer/services/wire-shapes/workflow-definition-body.js";
import { isWireRecord } from "@renderer/lib/wire-record.js";
import { readWireString } from "@renderer/lib/wire-strings.js";

/**
 * The members one tool binding carries, in write order. The same tuple is the admitted set: a
 * member the writer does not write is one the reader must not accept.
 */
const TOOL_BINDING_KEYS = ["binding", "toolName"] as const;

/** The members a binding reference carries on the arm that names no narrower scope. */
const USER_SCOPED_BINDING_KEYS = ["provider", "scope", "serverName"] as const;

/** The members it carries on the two arms that do, which is the same set plus one. */
const REF_SCOPED_BINDING_KEYS = ["provider", "scope", "scopeRef", "serverName"] as const;

/**
 * The facets a definition may never carry, named so a refusal can say which. The admitted-key
 * check already refuses them; this exists for the sentence, so a person reads that the facet
 * is the node operator's rather than that a key was unrecognized.
 */
const GOVERNANCE_FACET_KEYS = ["enabled", "approvalMode", "idempotencyClass"] as const;

/** One phase's bindings as a file writes them, in each arm's own member order. */
export function toolBindingFileRecords(
  bindings: readonly WorkflowToolBinding[],
): readonly Readonly<Record<string, unknown>>[] {
  return bindings.map((toolBinding) => ({
    binding: bindingReferenceRecord(toolBinding.binding),
    toolName: toolBinding.toolName,
  }));
}

/**
 * One phase's bindings, or the sentence naming what is wrong with one of them. A string is the
 * failure arm, as in every reader of this file form.
 */
export function readToolBindings(
  value: unknown,
  phaseProse: string,
): readonly WorkflowToolBinding[] | string {
  if (!Array.isArray(value)) {
    return `${phaseProse} states \`toolBindings\` as something other than a list of bindings.`;
  }
  const bindings: WorkflowToolBinding[] = [];
  for (const [index, candidate] of value.entries()) {
    const bindingProse = `${phaseProse} binding ${String(index + 1)}`;
    const binding = readToolBinding(candidate, bindingProse);
    if (typeof binding === "string") {
      return binding;
    }
    bindings.push(binding);
  }
  return bindings;
}

/** One binding reference as a file writes it: the arm's own members, in order. */
function bindingReferenceRecord(binding: McpServerBindingRef): Readonly<Record<string, unknown>> {
  // `scopeRef` is spread only on the arms that have one: a YAML writer turns `undefined` into
  // null, which would name a scope reference and leave it empty.
  return {
    provider: binding.provider,
    scope: binding.scope,
    ...(binding.scope === "user" ? {} : { scopeRef: binding.scopeRef }),
    serverName: binding.serverName,
  };
}

/** One tool binding, or the sentence naming what is wrong with it. */
function readToolBinding(value: unknown, bindingProse: string): WorkflowToolBinding | string {
  if (!isWireRecord(value)) {
    return `${bindingProse} is not a binding record.`;
  }
  const unadmitted = firstUnadmittedKey(value, TOOL_BINDING_KEYS);
  if (unadmitted !== undefined) {
    return `${bindingProse} carries \`${unadmitted}\`, which a tool binding does not.`;
  }
  const toolName = readWireString(value["toolName"]);
  if (toolName === undefined) {
    return `${bindingProse} names no tool in \`toolName\`.`;
  }
  const binding = readBindingReference(value["binding"], bindingProse);
  if (typeof binding === "string") {
    return binding;
  }
  return { binding, toolName };
}

/** One scope-qualified binding reference, or the sentence naming what is wrong. */
function readBindingReference(value: unknown, bindingProse: string): McpServerBindingRef | string {
  if (!isWireRecord(value)) {
    return `${bindingProse} names no server in \`binding\`.`;
  }
  const facet = GOVERNANCE_FACET_KEYS.find((key) => key in value);
  if (facet !== undefined) {
    // The rule in the sentence: these three are set through the node's governance settings and
    // resolved live at phase launch, so a definition carrying one is refused, not ignored.
    return `${bindingProse} carries \`${facet}\`, which is the node operator's setting and never a definition's.`;
  }
  const provider = readVocabularyMember(value["provider"], PROVIDER_NAMES);
  if (provider === undefined) {
    return `${bindingProse} names no provider this console knows in \`provider\`.`;
  }
  const scope = readVocabularyMember(value["scope"], MCP_CONFIG_SCOPES);
  if (scope === undefined) {
    return `${bindingProse} names no binding scope this console knows in \`scope\`.`;
  }
  if (scope === "user") {
    const unadmitted = firstUnadmittedKey(value, USER_SCOPED_BINDING_KEYS);
    if (unadmitted !== undefined) {
      return `${bindingProse} carries \`${unadmitted}\`, which a \`user\`-scoped binding does not.`;
    }
    const serverName = readWireString(value["serverName"]);
    return serverName === undefined
      ? `${bindingProse} names no server in \`serverName\`.`
      : { provider, scope, serverName };
  }
  const unadmitted = firstUnadmittedKey(value, REF_SCOPED_BINDING_KEYS);
  if (unadmitted !== undefined) {
    return `${bindingProse} carries \`${unadmitted}\`, which a scope-qualified binding does not.`;
  }
  const scopeRef = readWireString(value["scopeRef"]);
  if (scopeRef === undefined) {
    return `${bindingProse} is \`${scope}\`-scoped and names no scope in \`scopeRef\`.`;
  }
  const serverName = readWireString(value["serverName"]);
  if (serverName === undefined) {
    return `${bindingProse} names no server in \`serverName\`.`;
  }
  return { provider, scope, scopeRef, serverName };
}
