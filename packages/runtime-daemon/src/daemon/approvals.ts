// The daemon's approval pipeline, built once with the provider side: the permission check every
// sensitive action passes, the asks and their answers, the rules the providers keep and a purge
// takes out of them, the reviewer's blocks, the hold an
// ask puts on its run, and the `approval.*` methods. Its ports are registered as it is built, so
// no ask waits on a missing intake; its log follows begin at `start`, once the start's recovery
// pass has settled the runs.

import path from "node:path";

import type { MethodRegistry } from "@ai-sidekicks/contracts/jsonrpc/registry";
import type { NodeId } from "@ai-sidekicks/contracts/runtime-node/id";

import { PermissionAsks } from "../approvals/permission-asks.js";
import { ApprovalProjectionService } from "../approvals/projection-service.js";
import { ReviewerDenials } from "../approvals/reviewer-denials.js";
import { ApprovalRules } from "../approvals/rules.js";
import { ApprovalRunBlocking } from "../approvals/run-blocking.js";
import { ApprovalService } from "../approvals/service.js";
import type { DatabaseConnections } from "../database/connection/lifecycle.js";
import type { EventLogService } from "../events/log-service.js";
import type { ProjectRuleWithdrawal } from "../events/session/purge.js";
import type { WorkingFolderWatcher } from "../git/worktree/watch.js";
import {
  resolveDriverForRunOrThrow,
  resolveDriverForSessionOrThrow,
  type DriverDispatchDeps,
  type SessionDriverDeps,
} from "../ipc/handlers/driver/resolution.js";
import { registerApprovalMethods } from "../ipc/handlers/approval.js";
import { NodeRegistry } from "../node-registry.js";
import type { Authorizer } from "../policy/authorizer.js";
import type { ExecutionPostureService } from "../policy/execution-posture-service.js";
import { PermissionCheckService } from "../policy/permission-check.js";
import type { PermissionAskPort } from "../provider/port/permission-ask.js";
import type { PortRegistration } from "../provider/port/registration.js";
import type { ReviewerDenialPort } from "../provider/port/reviewer-denial.js";
import type { SessionRulePort } from "../provider/port/session-rules.js";
import { RunAgentReader } from "../session/run/agent.js";
import type { RunEngine } from "../session/run/engine.js";
import type { ServiceLogWriter } from "./service-log.js";

// The one all-projects agent-memory folder, inside the daemon's data folder.
const AGENT_MEMORY_FOLDER_NAME = "agent-memory";

/** What the approval pipeline is built over. */
export interface DaemonApprovalsContext {
  readonly database: DatabaseConnections;
  readonly eventLog: EventLogService;
  /** The machine whose providers keep the rules made here. */
  readonly nodeId: NodeId;
  /** The daemon's data folder, which holds the agent-memory folder. */
  readonly dataFolder: string;
  /** The workflow actions' rules, loaded and checked at the daemon's start. */
  readonly authorizer: Authorizer;
  /** The posture each live run runs at, which the workflow rules read. */
  readonly executionPostures: Pick<ExecutionPostureService, "resolvedPostureFor">;
  readonly runEngine: RunEngine;
  /** The driver a run or a session runs on. */
  readonly runDispatch: DriverDispatchDeps;
  readonly sessionDrivers: SessionDriverDeps;
  readonly workingFolders: Pick<WorkingFolderWatcher, "raiseStaleness">;
  readonly ports: {
    readonly permissionAsks: PortRegistration<PermissionAskPort>;
    readonly reviewerDenials: PortRegistration<ReviewerDenialPort>;
    readonly sessionRules: PortRegistration<SessionRulePort>;
    readonly projectRules: PortRegistration<ProjectRuleWithdrawal>;
  };
  readonly methods: MethodRegistry;
  readonly writeServiceLog: ServiceLogWriter;
}

/** Builds and runs the approval pipeline. */
export class DaemonApprovals {
  /**
   * The permission check, which a workflow start an agent or a trigger asks for passes.
   * @consumedBy the workflow engine's run-start path, which checks each start through it
   */
  readonly permissionCheck: PermissionCheckService;
  readonly #service: ApprovalService;
  readonly #rules: ApprovalRules;
  readonly #reviewerDenials: ReviewerDenials;
  readonly #runBlocking: ApprovalRunBlocking;

  constructor(context: DaemonApprovalsContext) {
    const { database, eventLog, runEngine, ports } = context;
    const followAll = eventLog.followAll.bind(eventLog);
    this.#service = new ApprovalService({
      reader: database.reader,
      sessionEvents: eventLog,
      followAll,
      workingFolders: context.workingFolders,
      writeServiceLog: context.writeServiceLog,
    });
    this.#rules = new ApprovalRules({
      reader: database.reader,
      sessionEvents: eventLog,
      nodeId: context.nodeId,
      followAll,
      revokeAtProvider: async (revocation) => {
        const { driver } = resolveDriverForSessionOrThrow(
          context.sessionDrivers,
          revocation.sessionId,
        );
        await driver.revokeRule(revocation);
      },
      writeServiceLog: context.writeServiceLog,
    });
    this.#reviewerDenials = new ReviewerDenials({
      reader: database.reader,
      sessionEvents: eventLog,
      followAll,
      resolveDriver: (sessionId) =>
        resolveDriverForSessionOrThrow(context.sessionDrivers, sessionId).driver,
    });
    const agents = new RunAgentReader(database.reader);
    const nodes = new NodeRegistry(database);
    this.permissionCheck = new PermissionCheckService({
      authorizer: context.authorizer,
      approvals: this.#service,
      rules: this.#rules,
      agentMemoryFolder: path.join(context.dataFolder, AGENT_MEMORY_FOLDER_NAME),
      readRunAgent: (sessionId, runId) => agents.readAgent(sessionId, runId),
      readOwner: () => nodes.readOwner(context.nodeId),
      readPosture: (runId) => context.executionPostures.resolvedPostureFor(runId),
    });
    const asks = new PermissionAsks({
      approvals: this.#service,
      permissionCheck: this.permissionCheck,
      rules: this.#rules,
      respondToRequest: async (params) => {
        await resolveDriverForRunOrThrow(context.runDispatch, params.runId).driver.respondToRequest(
          params,
        );
      },
    });
    this.#runBlocking = new ApprovalRunBlocking({
      runEngine,
      approvals: this.#service,
      forgetRun: (runId) => {
        asks.forgetRun(runId);
      },
      followAll,
      writeServiceLog: context.writeServiceLog,
    });
    this.#service.registerApprovalOutcomeListener(this.#runBlocking);
    runEngine.registerSetupGate(this.#runBlocking);
    ports.permissionAsks.register(asks);
    ports.reviewerDenials.register(this.#reviewerDenials);
    ports.sessionRules.register(this.#rules);
    ports.projectRules.register(this.#rules);
    registerApprovalMethods(context.methods, {
      asks,
      projection: new ApprovalProjectionService(database.reader),
      rules: this.#rules,
      reviewerDenials: this.#reviewerDenials,
    });
  }

  /**
   * Follows the log: cancels the asks and ends the session rules of every session that closes,
   * those closed while the daemon was down at once, holds each run that runs again with an ask
   * open, and records the reviewer blocks waiting for their call's row.
   */
  start(): void {
    this.#service.start();
    this.#rules.start();
    this.#runBlocking.start();
    this.#reviewerDenials.start();
  }

  /** Stops following the log and waits for the work under way; a block still waiting is refused. */
  async stop(): Promise<void> {
    this.#reviewerDenials.stop();
    await Promise.all([this.#service.stop(), this.#rules.stop(), this.#runBlocking.stop()]);
  }
}
