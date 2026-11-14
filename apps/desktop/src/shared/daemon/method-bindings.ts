// The daemon methods a window reaches through the client helper, each bound to its generated
// checks: the renderer's `callDaemon` checks a request before it is sent and the reply before the
// page reads it. A method's shape is stated once, by the generated tables; this module names the
// tables a window reaches and keys each method by its generated name.
//
// The calls and the streams are split by each descriptor's `procedureType`: `DAEMON_METHOD_BINDINGS`
// holds the queries and mutations, and `DaemonStreamMethod` names the subscriptions, which have no
// reply to bind and which `streams.ts` names. What only main sends is not here: the daemon's stop
// and restart, which go through main's supervisor; the app's diagnostics, which main redacts and
// rate-limits; the machine's settings, which main relays to each window; and the presence
// heartbeat, which main sends for the app.

import {
  AGENT_METHOD_DESCRIPTORS,
  type AgentMethodDescriptors,
} from "@ai-sidekicks/contracts/agent/methods";
import {
  ARTIFACT_METHOD_DESCRIPTORS,
  type ArtifactMethodDescriptors,
} from "@ai-sidekicks/contracts/artifacts/methods";
import {
  COMMAND_METHOD_DESCRIPTORS,
  type CommandMethodDescriptors,
} from "@ai-sidekicks/contracts/command";
import {
  DAEMON_STATUS_METHOD_DESCRIPTORS,
  type DaemonStatusMethodDescriptors,
} from "@ai-sidekicks/contracts/daemon/status";
import {
  GIT_METHOD_DESCRIPTORS,
  type GitMethodDescriptors,
} from "@ai-sidekicks/contracts/git/methods";
import {
  HIGHLIGHT_METHOD_DESCRIPTORS,
  type HighlightMethodDescriptors,
} from "@ai-sidekicks/contracts/highlight";
import {
  MCP_EVENT_METHOD_DESCRIPTORS,
  type McpEventMethodDescriptors,
} from "@ai-sidekicks/contracts/mcp/event";
import {
  MCP_METHOD_DESCRIPTORS,
  type McpMethodDescriptors,
} from "@ai-sidekicks/contracts/mcp/governance";
import {
  ORCHESTRATION_METHOD_DESCRIPTORS,
  type OrchestrationMethodDescriptors,
} from "@ai-sidekicks/contracts/orchestration";
import {
  PRESENCE_METHOD_DESCRIPTORS,
  type PresenceMethodDescriptors,
} from "@ai-sidekicks/contracts/presence";
import {
  PROVIDER_ACCOUNT_METHOD_DESCRIPTORS,
  type ProviderAccountMethodDescriptors,
} from "@ai-sidekicks/contracts/provider/account/methods";
import {
  PROVIDER_DRIVER_METHOD_DESCRIPTORS,
  type ProviderDriverMethodDescriptors,
} from "@ai-sidekicks/contracts/provider/driver/methods";
import {
  PROVIDER_METHOD_DESCRIPTORS,
  type ProviderMethodDescriptors,
} from "@ai-sidekicks/contracts/provider/settings";
import {
  QUESTION_METHOD_DESCRIPTORS,
  type QuestionMethodDescriptors,
} from "@ai-sidekicks/contracts/question";
import {
  REPO_METHOD_DESCRIPTORS,
  type RepoMethodDescriptors,
} from "@ai-sidekicks/contracts/repo/methods";
import {
  RUN_CONTROL_METHOD_DESCRIPTORS,
  type RunControlMethodDescriptors,
} from "@ai-sidekicks/contracts/run/control";
import type { SchemaCheck } from "@ai-sidekicks/contracts/schema-check";
import {
  SESSION_CONTROL_METHOD_DESCRIPTORS,
  type SessionControlMethodDescriptors,
} from "@ai-sidekicks/contracts/session/controls/methods";
import {
  SESSION_DIRECTORY_METHOD_DESCRIPTORS,
  type SessionDirectoryMethodDescriptors,
} from "@ai-sidekicks/contracts/session/directory";
import {
  SESSION_DRAFT_METHOD_DESCRIPTORS,
  type SessionDraftMethodDescriptors,
} from "@ai-sidekicks/contracts/session/draft";
import {
  SESSION_INSPECTOR_METHOD_DESCRIPTORS,
  type SessionInspectorMethodDescriptors,
} from "@ai-sidekicks/contracts/session/inspector";
import {
  SESSION_METHOD_DESCRIPTORS,
  type SessionMethodDescriptors,
} from "@ai-sidekicks/contracts/session/methods";
import {
  SKILL_METHOD_DESCRIPTORS,
  type SkillMethodDescriptors,
} from "@ai-sidekicks/contracts/skill";
import {
  TERMINAL_CONTROL_METHOD_DESCRIPTORS,
  TERMINAL_METHOD_DESCRIPTORS,
  type TerminalControlMethodDescriptors,
  type TerminalMethodDescriptors,
} from "@ai-sidekicks/contracts/terminal";
import {
  TRANSCRIPT_METHOD_DESCRIPTORS,
  type TranscriptMethodDescriptors,
} from "@ai-sidekicks/contracts/transcript/methods";
import {
  WORKFLOW_DEFINITION_METHOD_DESCRIPTORS,
  type WorkflowDefinitionMethodDescriptors,
} from "@ai-sidekicks/contracts/workflow/definition/methods";
import {
  WORKFLOW_KEPT_VALUE_METHOD_DESCRIPTORS,
  type WorkflowKeptValueMethodDescriptors,
} from "@ai-sidekicks/contracts/workflow/kept-values";
import {
  WORKFLOW_RUN_CONTROL_METHOD_DESCRIPTORS,
  type WorkflowRunControlMethodDescriptors,
} from "@ai-sidekicks/contracts/workflow/run/control";
import {
  WORKFLOW_RUN_RECORD_METHOD_DESCRIPTORS,
  type WorkflowRunRecordMethodDescriptors,
} from "@ai-sidekicks/contracts/workflow/run/records";
import {
  WORKFLOW_STEP_METHOD_DESCRIPTORS,
  type WorkflowStepMethodDescriptors,
} from "@ai-sidekicks/contracts/workflow/run/step/methods";
import {
  WORKFLOW_SUBSCRIPTION_METHOD_DESCRIPTORS,
  type WorkflowSubscriptionMethodDescriptors,
} from "@ai-sidekicks/contracts/workflow/subscription";

/** Every generated method table a window reaches, merged and keyed by each method's wire name. */
type WindowMethodTables = AgentMethodDescriptors &
  ArtifactMethodDescriptors &
  CommandMethodDescriptors &
  DaemonStatusMethodDescriptors &
  GitMethodDescriptors &
  HighlightMethodDescriptors &
  McpEventMethodDescriptors &
  McpMethodDescriptors &
  OrchestrationMethodDescriptors &
  Omit<PresenceMethodDescriptors, "presence.heartbeat.send"> &
  ProviderAccountMethodDescriptors &
  ProviderDriverMethodDescriptors &
  ProviderMethodDescriptors &
  QuestionMethodDescriptors &
  RepoMethodDescriptors &
  RunControlMethodDescriptors &
  SessionControlMethodDescriptors &
  SessionDirectoryMethodDescriptors &
  SessionDraftMethodDescriptors &
  SessionInspectorMethodDescriptors &
  SessionMethodDescriptors &
  SkillMethodDescriptors &
  TerminalControlMethodDescriptors &
  TerminalMethodDescriptors &
  TranscriptMethodDescriptors &
  WorkflowDefinitionMethodDescriptors &
  WorkflowKeptValueMethodDescriptors &
  WorkflowRunControlMethodDescriptors &
  WorkflowRunRecordMethodDescriptors &
  WorkflowStepMethodDescriptors &
  WorkflowSubscriptionMethodDescriptors;

/** What is read of any one method's generated descriptor without knowing which method it is. */
export interface WindowMethodDescriptor {
  readonly procedureType: "query" | "mutation" | "subscription";
  readonly requestCheck: SchemaCheck<unknown>;
}

/** One daemon query or mutation a window calls, by its wire name. */
export type RegisteredDaemonMethod = {
  [MethodName in keyof WindowMethodTables]: WindowMethodTables[MethodName] extends {
    readonly procedureType: "subscription";
  }
    ? never
    : MethodName;
}[keyof WindowMethodTables];

/** One daemon subscription a window opens, by its wire name. */
export type DaemonStreamMethod = Exclude<keyof WindowMethodTables, RegisteredDaemonMethod>;

/** The value a generated check admits. */
type CheckedValue<Check> = Check extends SchemaCheck<infer Value> ? Value : never;

/** The request one daemon method takes, as its generated check states it. */
export type DaemonParams<MethodName extends RegisteredDaemonMethod> = CheckedValue<
  WindowMethodTables[MethodName]["requestCheck"]
>;

/** The reply one daemon method serves, as its generated check states it. */
export type DaemonResult<MethodName extends RegisteredDaemonMethod> = CheckedValue<
  WindowMethodTables[MethodName]["responseCheck"]
>;

/**
 * Each callable method's generated descriptor: its kind and its request and reply checks, keyed
 * so that indexing by a generic method name keeps the checks tied to that method's types.
 */
export type DaemonMethodBindings = {
  readonly [MethodName in RegisteredDaemonMethod]: {
    readonly method: MethodName;
    readonly procedureType: "query" | "mutation";
    readonly mutating: boolean;
    readonly requestCheck: SchemaCheck<DaemonParams<MethodName>>;
    readonly responseCheck: SchemaCheck<DaemonResult<MethodName>>;
  };
};

/** The request one subscription is opened with, as its generated check states it. */
export type DaemonStreamRequest<StreamMethod extends DaemonStreamMethod> = CheckedValue<
  WindowMethodTables[StreamMethod]["requestCheck"]
>;

/** One value a subscription delivers, as its generated check states it. */
export type DaemonStreamEmission<StreamMethod extends DaemonStreamMethod> = CheckedValue<
  (WindowMethodTables[StreamMethod] & { readonly emissionCheck: unknown })["emissionCheck"]
>;

/**
 * Every generated method a window calls or opens, merged and frozen: the one list main's helper
 * checks a window's requests against and the calls below are bound from.
 */
export const WINDOW_METHOD_DESCRIPTORS: Readonly<Record<string, WindowMethodDescriptor>> =
  Object.freeze({
    ...AGENT_METHOD_DESCRIPTORS,
    ...ARTIFACT_METHOD_DESCRIPTORS,
    ...COMMAND_METHOD_DESCRIPTORS,
    ...DAEMON_STATUS_METHOD_DESCRIPTORS,
    ...GIT_METHOD_DESCRIPTORS,
    ...HIGHLIGHT_METHOD_DESCRIPTORS,
    ...MCP_EVENT_METHOD_DESCRIPTORS,
    ...MCP_METHOD_DESCRIPTORS,
    ...ORCHESTRATION_METHOD_DESCRIPTORS,
    "presence.read": PRESENCE_METHOD_DESCRIPTORS["presence.read"],
    "presence.subscribe": PRESENCE_METHOD_DESCRIPTORS["presence.subscribe"],
    ...PROVIDER_ACCOUNT_METHOD_DESCRIPTORS,
    ...PROVIDER_DRIVER_METHOD_DESCRIPTORS,
    ...PROVIDER_METHOD_DESCRIPTORS,
    ...QUESTION_METHOD_DESCRIPTORS,
    ...REPO_METHOD_DESCRIPTORS,
    ...RUN_CONTROL_METHOD_DESCRIPTORS,
    ...SESSION_CONTROL_METHOD_DESCRIPTORS,
    ...SESSION_DIRECTORY_METHOD_DESCRIPTORS,
    ...SESSION_DRAFT_METHOD_DESCRIPTORS,
    ...SESSION_INSPECTOR_METHOD_DESCRIPTORS,
    ...SESSION_METHOD_DESCRIPTORS,
    ...SKILL_METHOD_DESCRIPTORS,
    ...TERMINAL_CONTROL_METHOD_DESCRIPTORS,
    ...TERMINAL_METHOD_DESCRIPTORS,
    ...TRANSCRIPT_METHOD_DESCRIPTORS,
    ...WORKFLOW_DEFINITION_METHOD_DESCRIPTORS,
    ...WORKFLOW_KEPT_VALUE_METHOD_DESCRIPTORS,
    ...WORKFLOW_RUN_CONTROL_METHOD_DESCRIPTORS,
    ...WORKFLOW_RUN_RECORD_METHOD_DESCRIPTORS,
    ...WORKFLOW_STEP_METHOD_DESCRIPTORS,
    ...WORKFLOW_SUBSCRIPTION_METHOD_DESCRIPTORS,
  });

/** The method-to-descriptor table of every query and mutation a window calls, frozen. */
export const DAEMON_METHOD_BINDINGS: DaemonMethodBindings =
  bindCallableMethods(WINDOW_METHOD_DESCRIPTORS);

/** Every daemon query and mutation a window calls, by its wire name. */
export const REGISTERED_DAEMON_METHODS: readonly RegisteredDaemonMethod[] = Object.freeze(
  Object.keys(DAEMON_METHOD_BINDINGS) as RegisteredDaemonMethod[],
);

/**
 * The descriptor for one method name known only at runtime, or `undefined` for a name no window
 * calls. For the fixture bridge and the scenario checks, each handed a call name at runtime; typed
 * callers index the table directly.
 */
export function daemonMethodBindingFor(
  method: string,
): DaemonMethodBindings[RegisteredDaemonMethod] | undefined {
  return Object.hasOwn(DAEMON_METHOD_BINDINGS, method)
    ? DAEMON_METHOD_BINDINGS[method as RegisteredDaemonMethod]
    : undefined;
}

// The merged tables arrive as an argument, so the subscriptions dropped from them are not kept in a
// second table beside the generated ones.
function bindCallableMethods(
  windowMethodTables: Readonly<Record<string, WindowMethodDescriptor>>,
): DaemonMethodBindings {
  // The one cast narrows `Object.fromEntries`' string-keyed record to the mapped type; each entry
  // is the descriptor its own method's table holds.
  return Object.freeze(
    Object.fromEntries(
      Object.entries(windowMethodTables).filter(
        ([, descriptor]) => descriptor.procedureType !== "subscription",
      ),
    ) as DaemonMethodBindings,
  );
}
