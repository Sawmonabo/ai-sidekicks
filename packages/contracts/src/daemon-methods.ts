// The daemon's method map, composed from each namespace's descriptor table. It leaves out
// the methods the desktop's main process answers (the page host's table) and the control
// plane's own procedures, which travel inside `controlPlane.call`.
import type {
  AnyMethodDescriptor,
  MethodEmissionOf,
  MethodRequestOf,
  MethodResponseOf,
} from "./method-descriptor.js";
import type { AgentMethodDescriptors } from "./agent.js";
import type { ApprovalMethodDescriptors } from "./approval.js";
import type { ArtifactMethodDescriptors } from "./artifacts/methods.js";
import type { AttentionMethodDescriptors } from "./attention.js";
import type { BrowserMethodDescriptors } from "./browser.js";
import type { CallbackToolMethodDescriptors } from "./callback-tool.js";
import type { CloudMethodDescriptors } from "./cloud.js";
import type { CommandMethodDescriptors } from "./command.js";
import type { DaemonBackupMethodDescriptors } from "./daemon-backup.js";
import type { DaemonConfigMethodDescriptors } from "./daemon-config.js";
import type { DaemonDataMethodDescriptors } from "./daemon-data.js";
import type { DaemonLifecycleMethodDescriptors } from "./daemon-lifecycle.js";
import type { DaemonRetentionMethodDescriptors } from "./daemon-retention.js";
import type { DaemonStatusMethodDescriptors } from "./daemon-status.js";
import type { ControlPlaneMethodDescriptors, DeviceMethodDescriptors } from "./device.js";
import type { DriverEventMethodDescriptors } from "./driver-event.js";
import type { GitflowMethodDescriptors } from "./gitflow/methods.js";
import type { HighlightMethodDescriptors } from "./highlight.js";
import type { MachineSettingsMethodDescriptors } from "./machine-settings.js";
import type { McpEventMethodDescriptors } from "./mcp-event.js";
import type { McpMethodDescriptors } from "./mcp-governance.js";
import type { OrchestrationMethodDescriptors } from "./orchestration.js";
import type { PlanMethodDescriptors } from "./plan.js";
import type { PluginMethodDescriptors } from "./plugin.js";
import type { PresenceMethodDescriptors } from "./presence.js";
import type { PreviewPageLinkMethodDescriptors } from "./preview-page-host.js";
import type { PreviewPortMethodDescriptors } from "./preview-port.js";
import type { PreviewMethodDescriptors } from "./preview.js";
import type { ProviderAccountMethodDescriptors } from "./provider-account-methods.js";
import type { DriverMethodDescriptors } from "./provider-driver-wire.js";
import type { SessionImportMethodDescriptors } from "./provider-import.js";
import type { ProviderMethodDescriptors } from "./provider.js";
import type { PtyMethodDescriptors, TerminalControlMethodDescriptors } from "./pty.js";
import type { QuestionMethodDescriptors } from "./question.js";
import type { RelayMethodDescriptors } from "./relay.js";
import type { RepoMethodDescriptors } from "./repo-methods.js";
import type { ReviewNoteMethodDescriptors } from "./review-note.js";
import type { RunControlMethodDescriptors } from "./run-control.js";
import type { SessionControlMethodDescriptors } from "./session-controls.js";
import type { SessionDirectoryMethodDescriptors } from "./session-directory.js";
import type { SessionDraftMethodDescriptors } from "./session-draft.js";
import type { SessionGoalMethodDescriptors } from "./session-goal.js";
import type { SessionInspectorMethodDescriptors } from "./session-inspector.js";
import type { SessionRestoreMethodDescriptors } from "./session-restore.js";
import type { SessionMethodDescriptors } from "./session.js";
import type { SkillMethodDescriptors } from "./skill.js";
import type { TimelineMethodDescriptorRegistry } from "./timeline/methods.js";
import type { TurnMethodDescriptors } from "./turn.js";
import type { VoiceMethodDescriptors } from "./voice.js";
import type { WorkflowDefinitionMethodDescriptors } from "./workflow-definition-methods.js";
import type { WorkflowKindMethodDescriptors } from "./workflow-kind.js";
import type { WorkflowRunControlMethodDescriptors } from "./workflow-run-control.js";
import type { WorkflowRunRecordMethodDescriptors } from "./workflow-run-records.js";
import type { WorkflowStepMethodDescriptors } from "./workflow-run-step.js";
import type { WorkflowSecretMethodDescriptors } from "./workflow-secret.js";

/** Every method the daemon answers, keyed by its name. */
export type DaemonMethodDescriptors = AgentMethodDescriptors &
  ApprovalMethodDescriptors &
  ArtifactMethodDescriptors &
  AttentionMethodDescriptors &
  BrowserMethodDescriptors &
  CallbackToolMethodDescriptors &
  CloudMethodDescriptors &
  CommandMethodDescriptors &
  DaemonBackupMethodDescriptors &
  DaemonConfigMethodDescriptors &
  DaemonDataMethodDescriptors &
  DaemonLifecycleMethodDescriptors &
  DaemonRetentionMethodDescriptors &
  DaemonStatusMethodDescriptors &
  ControlPlaneMethodDescriptors &
  DeviceMethodDescriptors &
  GitflowMethodDescriptors &
  HighlightMethodDescriptors &
  MachineSettingsMethodDescriptors &
  McpMethodDescriptors &
  McpEventMethodDescriptors &
  OrchestrationMethodDescriptors &
  PlanMethodDescriptors &
  PluginMethodDescriptors &
  PresenceMethodDescriptors &
  PreviewPageLinkMethodDescriptors &
  PreviewPortMethodDescriptors &
  PreviewMethodDescriptors &
  ProviderAccountMethodDescriptors &
  DriverMethodDescriptors &
  DriverEventMethodDescriptors &
  SessionImportMethodDescriptors &
  ProviderMethodDescriptors &
  PtyMethodDescriptors &
  TerminalControlMethodDescriptors &
  QuestionMethodDescriptors &
  RelayMethodDescriptors &
  RepoMethodDescriptors &
  ReviewNoteMethodDescriptors &
  RunControlMethodDescriptors &
  SessionControlMethodDescriptors &
  SessionDirectoryMethodDescriptors &
  SessionDraftMethodDescriptors &
  SessionGoalMethodDescriptors &
  SessionInspectorMethodDescriptors &
  SessionRestoreMethodDescriptors &
  SessionMethodDescriptors &
  SkillMethodDescriptors &
  TimelineMethodDescriptorRegistry &
  TurnMethodDescriptors &
  VoiceMethodDescriptors &
  WorkflowDefinitionMethodDescriptors &
  WorkflowKindMethodDescriptors &
  WorkflowRunControlMethodDescriptors &
  WorkflowRunRecordMethodDescriptors &
  WorkflowStepMethodDescriptors &
  WorkflowSecretMethodDescriptors;

type DaemonMethodName = keyof DaemonMethodDescriptors & string;

/** A method answered with one result: a query or a mutation. */
export type DaemonMethod = {
  [MethodName in DaemonMethodName]: DaemonMethodDescriptors[MethodName] extends {
    readonly procedureType: "subscription";
  }
    ? never
    : MethodName;
}[DaemonMethodName];

/** What a caller sends with a method. */
export type DaemonParams<M extends DaemonMethod> =
  DaemonMethodDescriptors[M] extends AnyMethodDescriptor
    ? MethodRequestOf<DaemonMethodDescriptors[M]>
    : never;

/** What a method answers. */
export type DaemonResult<M extends DaemonMethod> =
  DaemonMethodDescriptors[M] extends AnyMethodDescriptor
    ? MethodResponseOf<DaemonMethodDescriptors[M]>
    : never;

/** A subscription: a method that acknowledges and then streams. */
export type DaemonEvent = Exclude<DaemonMethodName, DaemonMethod>;

/** What a caller sends to open a subscription. */
export type DaemonSubscribeParams<E extends DaemonEvent> =
  DaemonMethodDescriptors[E] extends AnyMethodDescriptor
    ? MethodRequestOf<DaemonMethodDescriptors[E]>
    : never;

/** One value a subscription pushes after its acknowledgement. */
export type DaemonEventPayload<E extends DaemonEvent> =
  DaemonMethodDescriptors[E] extends AnyMethodDescriptor
    ? MethodEmissionOf<DaemonMethodDescriptors[E]>
    : never;
