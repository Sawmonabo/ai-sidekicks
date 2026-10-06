// The daemon methods the app calls, and the schemas each is parsed against in both directions:
// by main's relay, where a call from the untrusted page enters main, and by the renderer's
// `callDaemon`, where the reply enters the page. A method's shape is stated once, by the contract;
// this module names the closed set and binds each name to its namespace's descriptor.
//
// The set is closed at compile time. The table is built from `REGISTERED_DAEMON_METHODS` alone,
// each entry looked up in its namespace's descriptor table, so a name no table holds is a type
// error. Subscriptions are not in it: a stream has no reply to bind, and `streams.ts` names
// the ones the app opens.

import { ARTIFACT_METHOD_DESCRIPTORS } from "@ai-sidekicks/contracts/artifacts/methods";
import { DRIVER_METHOD_DESCRIPTORS } from "@ai-sidekicks/contracts/provider/driver/methods";
import { GITFLOW_METHOD_DESCRIPTORS } from "@ai-sidekicks/contracts/gitflow/methods";
import { HIGHLIGHT_METHOD_DESCRIPTORS } from "@ai-sidekicks/contracts/highlight";
import { MCP_METHOD_DESCRIPTORS } from "@ai-sidekicks/contracts/mcp/governance";
import { PRESENCE_METHOD_DESCRIPTORS } from "@ai-sidekicks/contracts/presence";
import { QUESTION_METHOD_DESCRIPTORS } from "@ai-sidekicks/contracts/question";
import { PROVIDER_ACCOUNT_METHOD_DESCRIPTORS } from "@ai-sidekicks/contracts/provider/account/methods";
import { SESSION_DIRECTORY_METHOD_DESCRIPTORS } from "@ai-sidekicks/contracts/session/directory";
import { SESSION_METHOD_DESCRIPTORS } from "@ai-sidekicks/contracts/session/methods";
import { SESSION_INSPECTOR_METHOD_DESCRIPTORS } from "@ai-sidekicks/contracts/session/inspector";
import { TRANSCRIPT_METHOD_DESCRIPTORS } from "@ai-sidekicks/contracts/transcript/methods";
import { WORKFLOW_DEFINITION_METHOD_DESCRIPTORS } from "@ai-sidekicks/contracts/workflow/definition/methods";
import { WORKFLOW_RUN_CONTROL_METHOD_DESCRIPTORS } from "@ai-sidekicks/contracts/workflow/run/control";
import { WORKFLOW_RUN_RECORD_METHOD_DESCRIPTORS } from "@ai-sidekicks/contracts/workflow/run/records";
import { WORKFLOW_STEP_METHOD_DESCRIPTORS } from "@ai-sidekicks/contracts/workflow/run/step/methods";
import type { AnyMethodDescriptor } from "@ai-sidekicks/contracts/method-descriptor";
import type { DaemonParams, DaemonResult } from "@ai-sidekicks/contracts/daemon/method-map";
import type { ZodType } from "@ai-sidekicks/contracts/jsonrpc/registry";

/**
 * Every daemon method the app calls, closed.
 *
 * Each entry must be a query or mutation the daemon's method map names: `DaemonMethodBindings`
 * types entries with `DaemonParams` and `DaemonResult`, so a misspelled method or a subscription is
 * a compile error.
 */
export const REGISTERED_DAEMON_METHODS = [
  "driver.interruptRun",
  "driver.compactContext",
  "driver.listProviderCommands",
  "driver.listCapabilities",
  "driver.listModels",
  "transcript.reasoningSurfaceRead",
  "transcript.childRunExpand",
  "session.create",
  "session.read",
  "session.memoryRead",
  "presence.read",
  "highlight.read",
  "question.resolve",
  "gitflow.diffRead",
  "artifact.read",
  "mcp.list",
  "mcp.get",
  "mcp.registrySearch",
  "mcp.upsertServer",
  "mcp.removeServer",
  "mcp.setEnabled",
  "mcp.setToolOverride",
  "mcp.clearToolOverride",
  "mcp.oauthLogin",
  "mcp.oauthLogout",
  "mcp.reconnect",
  "providerAccount.list",
  "providerAccount.register",
  "providerAccount.update",
  "providerAccount.remove",
  "providerAccount.setCurrent",
  "providerAccount.probe",
  "providerAccount.resetCredentialHome",
  "providerAccount.login",
  "providerAccount.loginCancel",
  "providerAccount.memoryImport",
  "providerAccount.usageRead",
  "workflow.definitionList",
  "workflow.versionRead",
  "workflow.versionChainRead",
  "workflow.pinDataSet",
  "workflow.runList",
  "workflow.runRead",
  "workflow.runAttentionList",
  "workflow.runsPauseSet",
  "workflow.runDelete",
  "workflow.runsDeletePreview",
  "workflow.runsDelete",
  "workflow.runKeepSet",
  "workflow.runStart",
  "workflow.runCancel",
  "workflow.runResume",
  "workflow.runRetry",
  "workflow.runRerun",
  "workflow.stepRead",
  "workflow.gateResolve",
  "workflow.humanFormRead",
  "workflow.humanFormDraftSave",
  "workflow.humanFormSubmit",
  "workflow.fixSessionCreate",
] as const;

/** One daemon method the app calls. */
export type RegisteredDaemonMethod = (typeof REGISTERED_DAEMON_METHODS)[number];

/**
 * Each method's descriptor, with its two schemas typed from the method map. Typed against the
 * contracts package's `ZodType` so callers need no direct `zod` import (the lint config enforces).
 */
export type DaemonMethodBindings = {
  readonly [MethodName in RegisteredDaemonMethod]: AnyMethodDescriptor & {
    readonly requestSchema: ZodType<DaemonParams<MethodName>>;
    readonly responseSchema: ZodType<DaemonResult<MethodName>>;
  };
};

/** The namespaces the app calls into, merged so one lookup finds any of their methods. */
const DAEMON_NAMESPACE_DESCRIPTORS = {
  ...DRIVER_METHOD_DESCRIPTORS,
  ...TRANSCRIPT_METHOD_DESCRIPTORS,
  ...SESSION_METHOD_DESCRIPTORS,
  ...SESSION_DIRECTORY_METHOD_DESCRIPTORS,
  ...SESSION_INSPECTOR_METHOD_DESCRIPTORS,
  ...PRESENCE_METHOD_DESCRIPTORS,
  ...HIGHLIGHT_METHOD_DESCRIPTORS,
  ...QUESTION_METHOD_DESCRIPTORS,
  ...GITFLOW_METHOD_DESCRIPTORS,
  ...ARTIFACT_METHOD_DESCRIPTORS,
  ...MCP_METHOD_DESCRIPTORS,
  ...PROVIDER_ACCOUNT_METHOD_DESCRIPTORS,
  ...WORKFLOW_DEFINITION_METHOD_DESCRIPTORS,
  ...WORKFLOW_RUN_RECORD_METHOD_DESCRIPTORS,
  ...WORKFLOW_RUN_CONTROL_METHOD_DESCRIPTORS,
  ...WORKFLOW_STEP_METHOD_DESCRIPTORS,
};

/**
 * The method-to-descriptor table, built from the method list so a method is named once and frozen
 * so no module can re-point an entry. The one cast widens `Object.fromEntries`' string-keyed
 * record to the mapped type; each entry is the descriptor its own method's table holds.
 */
export const DAEMON_METHOD_BINDINGS: DaemonMethodBindings = Object.freeze(
  Object.fromEntries(
    REGISTERED_DAEMON_METHODS.map((method) => [method, DAEMON_NAMESPACE_DESCRIPTORS[method]]),
  ) as DaemonMethodBindings,
);

/**
 * The descriptor for one method name known only at runtime, or `undefined`.
 * For main's relay and the fixture bridge, each handed a call name at runtime; typed callers
 * index the table directly.
 */
export function daemonMethodBindingFor(method: string): AnyMethodDescriptor | undefined {
  return Object.hasOwn(DAEMON_METHOD_BINDINGS, method)
    ? DAEMON_METHOD_BINDINGS[method as RegisteredDaemonMethod]
    : undefined;
}
