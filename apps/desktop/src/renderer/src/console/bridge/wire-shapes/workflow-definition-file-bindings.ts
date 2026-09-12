// A phase's tool bindings in the definition file: the reference a definition may carry,
// and the policy it may not.
//
// ONE MODULE FOR BOTH SIDES, which is the rule the file form's other two modules keep
// for the same reason: the member names and the arm shapes are stated once, so a
// binding this console wrote is a binding this console reads.
//
// IT IS ITS OWN MODULE BECAUSE THE RULE IS ITS OWN. Tool bindings are references
// and never inline policy — a rule about what a definition may not
// say, and it is enforced HERE rather than at launch: a binding carrying `enabled`,
// `approvalMode` or `idempotencyClass` is refused at parse, so a definition exported
// from one machine cannot import a weakened posture onto another. Holding that beside
// the phase sequence would bury a security rule inside a shape reader.
//
// THE THREE ARMS ARE READ AS THREE ARMS. `McpServerBindingRef` is a discriminated
// union, not one shape with two optional members — `user` carries no `scopeRef` at all
// and `local` is admissible only with `claude` — so the reader dispatches on the scope
// and composes the arm it landed on. A flat read would admit the `(codex, local)`
// combination the union rejects at the schema layer, which is precisely the shape the
// contracts document says a restatement must not create.

import {
  MCP_BINDING_PROVIDERS,
  MCP_BINDING_SCOPES,
  firstUnadmittedKey,
  readVocabularyMember,
  type McpServerBindingRef,
  type WorkflowToolBinding,
} from "./workflow-definition-body.js";
import { isWireRecord, readWireString } from "../../core/index.js";

/**
 * The members one tool binding carries, in the order a file writes them.
 *
 * One tuple for the write order and the admitted set, because they are the same fact:
 * a member the writer does not write is a member the reader must not accept, and two
 * spellings of one closed shape drift the first time either grows.
 */
const TOOL_BINDING_KEYS = ["binding", "toolName"] as const;

/** The members a binding reference carries on the arm that names no narrower scope. */
const USER_SCOPED_BINDING_KEYS = ["provider", "scope", "serverName"] as const;

/** The members it carries on the two arms that do, which is the same set plus one. */
const REF_SCOPED_BINDING_KEYS = ["provider", "scope", "scopeRef", "serverName"] as const;

/**
 * The three facets a definition may never carry, named so a refusal can say which.
 *
 * They are already refused by the admitted-key check above — neither tuple carries one
 * — so this exists for the SENTENCE and not for the decision. A person who pasted a
 * binding with an `approvalMode` in it needs to read that the facet is the node
 * operator's and not that a key was unrecognised.
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
 * One phase's bindings, or the sentence naming what is wrong with one of them.
 *
 * A STRING FOR THE FAILURE ARM rather than a second result type, which is the shape
 * every reader of this file form takes: the caller widens whichever it gets into the
 * one reading a surface renders, and a result type per level would be four unions
 * describing one outcome.
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
  // The `scopeRef` member is spread on the arms that HAVE one rather than written as
  // `undefined`: a YAML writer handed an undefined value writes a null, and a null
  // `scopeRef` is a binding that names a scope reference and leaves it empty.
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
    // The rule, in the sentence rather than only in the code: these three are set
    // through the node's own governance surface and resolved live at phase launch, so
    // a definition carrying one is refused rather than imported and ignored.
    return `${bindingProse} carries \`${facet}\`, which is the node operator's setting and never a definition's.`;
  }
  const provider = readVocabularyMember(value["provider"], MCP_BINDING_PROVIDERS);
  if (provider === undefined) {
    return `${bindingProse} names no provider this console knows in \`provider\`.`;
  }
  const scope = readVocabularyMember(value["scope"], MCP_BINDING_SCOPES);
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
  if (scope === "project") {
    return { provider, scope, scopeRef, serverName };
  }
  // The one combination the union rejects, refused by name rather than by a shape
  // check that would leave the reader guessing which half was wrong.
  return provider === "claude"
    ? { provider, scope, scopeRef, serverName }
    : `${bindingProse} is \`local\`-scoped under \`${provider}\`, and only \`claude\` carries local bindings.`;
}
