// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// How a workflow run was started and by whom: the run mode, the trigger node's kind, the trigger node that started it, the run's place in its chain, and the person, device, message or parent run that started it.

import type { AgentId } from "../../agent/definition.js";
import type { EventCursor, SessionId } from "../../session/id.js";
import type { DeviceId } from "../../trust-statement.js";
import type { WorkflowNodeId } from "../definition/document.js";
import type { WorkflowRunId } from "./id.js";

/** Every way a run is started. */
export const WORKFLOW_RUN_MODES = [
  "manual",
  "trigger",
  "webhook",
  "chat",
  "agent",
  "retry",
  "subWorkflow",
] as const;

/**
 * Every trigger kind a run can be started by, in the order the runs table's filter lists
 * them.
 */
export const WORKFLOW_TRIGGER_KINDS = [
  "trigger.manual",
  "trigger.schedule",
  "trigger.fileWatch",
  "trigger.webhook",
  "trigger.sessionEvent",
  "trigger.chat",
  "trigger.subWorkflow",
  "trigger.error",
] as const;

/**
 * How a run was started, which is a different question from who started it.
 */
export type WorkflowRunMode =
  | "manual"
  | "trigger"
  | "webhook"
  | "chat"
  | "agent"
  | "retry"
  | "subWorkflow";
/**
 * The kind of trigger node that started a run, which the runs table's trigger column and filter
 * read. A retry keeps its source run's kind; a mode cannot carry this, because `trigger` covers a
 * schedule, a file event, a session event and another workflow failing alike.
 */
export type WorkflowTriggerKind =
  | "trigger.manual"
  | "trigger.schedule"
  | "trigger.fileWatch"
  | "trigger.webhook"
  | "trigger.sessionEvent"
  | "trigger.chat"
  | "trigger.subWorkflow"
  | "trigger.error";
/**
 * A run's place in its chain: it starts a chain of its own, or it joins the chain whose first run
 * is `chain_root_run_id`, through an error trigger when `is_from_error`.
 */
export type WorkflowRunChainPlace =
  | {
      kind: "starts";
    }
  | {
      kind: "joins";
      /**
       * The chain's first run.
       */
      chainRootRunId: WorkflowRunId;
      /**
       * Whether an error trigger started it.
       */
      isFromError: boolean;
    };
/**
 * Who or what started a run, as its row and its header name it. A person's start records the
 * device of the connection that made it, never a person; a chat start carries the message it came
 * from, so the run links back to that message.
 */
export type WorkflowStartedBy =
  | {
      kind: "user";
      /**
       * The device.
       */
      deviceId: DeviceId;
    }
  | {
      kind: "schedule";
    }
  | {
      kind: "chat";
      /**
       * The session the message is in.
       */
      sessionId: SessionId;
      /**
       * The message's place in the session's log.
       */
      messageAnchorCursor?: EventCursor;
    }
  | {
      kind: "agent";
      /**
       * The agent.
       */
      agentId: AgentId;
    }
  | {
      kind: "webhook";
    }
  | {
      kind: "fileEvent";
    }
  | {
      kind: "parentWorkflow";
      /**
       * The parent run.
       */
      parentWorkflowRunId: WorkflowRunId;
    };

/**
 * Which trigger node started a run, as its row's trigger record and its started event carry it.
 */
export interface WorkflowRunTrigger {
  /**
   * The trigger node's kind.
   */
  kind: WorkflowTriggerKind;
  /**
   * The trigger node.
   */
  nodeId: WorkflowNodeId;
}

export {
  validateWorkflowRunChainPlace,
  validateWorkflowRunMode,
  validateWorkflowRunTrigger,
  validateWorkflowStartedBy,
  validateWorkflowTriggerKind,
} from "../../checks/workflow/run/trigger.js";
