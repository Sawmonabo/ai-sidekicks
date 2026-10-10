// A helper Codex starts is a child run beneath the run whose tool call spawned it: its start and
// end are delivered as the child run and as the `subagent.started` / `subagent.completed` rows,
// which name that tool call where Codex gave one, and its own rows, which arrive on its own
// thread, are delivered on the child run between the two, in frame order.

import type { AgentId } from "@ai-sidekicks/contracts/agent/definition";
import type { RunId } from "@ai-sidekicks/contracts/run/id";

import { eventIdOf, type InboundOutcome } from "../../../../session/run/inbound.js";
import { CODEX_DRIVER_NAME } from "../capabilities.js";
import type { CodexRunBinding } from "../run/routes.js";
import { soleActiveRunIdIn, type CodexSessionRecord } from "../session/state.js";
import { composeCodexChildTerminal } from "../turn-evidence.js";
import type { CodexDeliveryDispatch } from "./dispatch.js";
import type { CodexChildRun, CodexSpawnCall, CodexStartedChildRun } from "./memory.js";
import type { CodexRowRun } from "./rows.js";

/** The collaborating-agent tool that starts a helper. */
const CODEX_SPAWN_AGENT_TOOL = "spawnAgent";

/** Whether an item is the tool call that starts a helper. */
export function isCodexSpawnCall(item: Readonly<Record<string, unknown>>): boolean {
  return item["type"] === "collabAgentToolCall" && item["tool"] === CODEX_SPAWN_AGENT_TOOL;
}

/** Delivers each helper's start and end for one lifecycle's sessions. */
export class CodexChildRuns {
  readonly #dispatch: CodexDeliveryDispatch;
  readonly #bindingFor: (runId: RunId) => CodexRunBinding | undefined;

  constructor(
    dispatch: CodexDeliveryDispatch,
    bindingFor: (runId: RunId) => CodexRunBinding | undefined,
  ) {
    this.#dispatch = dispatch;
    this.#bindingFor = bindingFor;
  }

  /** Remembers a spawn call in flight on its thread, so the helper it starts names it. */
  noteSpawnCall(
    record: CodexSessionRecord,
    threadId: string,
    toolCallId: string,
    run: CodexRowRun,
  ): void {
    const calls = record.delivery.spawnCallsByThreadId.get(threadId) ?? [];
    calls.push({ toolCallId, run });
    record.delivery.spawnCallsByThreadId.set(threadId, calls);
  }

  /** Forgets a spawn call that started no helper, because it failed. */
  settleSpawnCall(record: CodexSessionRecord, threadId: string, toolCallId: string): void {
    const calls = record.delivery.spawnCallsByThreadId.get(threadId);
    const remaining = calls?.filter((call) => call.toolCallId !== toolCallId) ?? [];
    if (remaining.length === 0) {
      record.delivery.spawnCallsByThreadId.delete(threadId);
    } else {
      record.delivery.spawnCallsByThreadId.set(threadId, remaining);
    }
  }

  /** Forgets every spawn call still waiting on a thread whose turn ended. */
  settleThreadSpawnCalls(record: CodexSessionRecord, threadId: string): void {
    record.delivery.spawnCallsByThreadId.delete(threadId);
  }

  /**
   * Starts the child run of a helper Codex announced on `childThreadId`: beneath the run whose
   * oldest unclaimed spawn call on the parent thread started it, else the parent helper's own
   * child run, else the session's one live run. A helper whose parent run cannot be told is left
   * unstarted, since no run can own it. A parent already known is delivered to at once; beneath a
   * helper whose own start is still on its way, the start follows that one.
   */
  startChild(
    record: CodexSessionRecord,
    childThreadId: string,
    parentThreadId: string,
    subagentId: string,
  ): void {
    const spawnCall = record.delivery.spawnCallsByThreadId.get(parentThreadId)?.[0];
    if (spawnCall !== undefined) {
      this.settleSpawnCall(record, parentThreadId, spawnCall.toolCallId);
    }
    const parentChild = record.delivery.childRunByThreadId.get(parentThreadId);
    let started: Promise<CodexStartedChildRun | undefined>;
    let agentId: AgentId;
    let bindingId: string;
    if (spawnCall !== undefined) {
      ({ agentId, bindingId } = spawnCall.run);
      started = this.#deliverStart(record, childThreadId, subagentId, spawnCall.run.runId, {
        bindingId,
        spawnCall,
      });
    } else if (parentChild !== undefined) {
      ({ agentId, bindingId } = parentChild);
      started = parentChild.started.then(async (parent) =>
        parent === undefined
          ? undefined
          : await this.#deliverStart(record, childThreadId, subagentId, parent.childRunId, {
              bindingId,
              spawnCall: undefined,
            }),
      );
    } else {
      const leadRunId = soleActiveRunIdIn(record);
      const leadBinding = leadRunId === null ? undefined : this.#bindingFor(leadRunId);
      if (leadRunId === null || leadBinding === undefined) {
        return;
      }
      ({ agentId, bindingId } = leadBinding);
      started = this.#deliverStart(record, childThreadId, subagentId, leadRunId, {
        bindingId,
        spawnCall: undefined,
      });
    }
    const child: CodexChildRun = {
      started,
      rows: started.then(() => undefined),
      agentId,
      bindingId,
      subagentId,
      parentToolCallId: spawnCall?.toolCallId,
    };
    record.delivery.childRunByThreadId.set(childThreadId, child);
  }

  /**
   * Hands `deliver` the helper's child run, and the event of its `subagent.started` row, once its
   * start settled, after every earlier frame of that helper; `false` for a thread that is no helper
   * of the session. A helper whose start was absorbed or refused has no run to own its rows, so
   * they are not delivered.
   */
  deliverOnChild(
    record: CodexSessionRecord,
    threadId: string,
    deliver: (run: CodexRowRun, startRowEventId: Promise<string | undefined>) => void,
  ): boolean {
    const child = record.delivery.childRunByThreadId.get(threadId);
    if (child === undefined) {
      return false;
    }
    child.rows = child.rows.then(async () => {
      const started = await child.started;
      if (started !== undefined) {
        deliver(
          {
            sessionId: record.sessionId,
            runId: started.childRunId,
            agentId: child.agentId,
            bindingId: child.bindingId,
          },
          started.startRowEventId,
        );
      }
    });
    return true;
  }

  /**
   * Ends a helper's child run on its thread's last turn, with the `subagent.completed` row; the
   * end waits for the child's start and its rows, and only that helper's deliveries wait with it.
   */
  completeChild(record: CodexSessionRecord, childThreadId: string, turnParams: unknown): void {
    const child = record.delivery.childRunByThreadId.get(childThreadId);
    if (child === undefined) {
      return;
    }
    record.delivery.childRunByThreadId.delete(childThreadId);
    void child.rows.then(async () => {
      const started = await child.started;
      if (started === undefined) {
        return;
      }
      record.delivery.childThreadIdByRunId.delete(started.childRunId);
      void this.#dispatch.send(
        record.sessionId,
        {
          kind: "session_row",
          bindingId: child.bindingId,
          row: {
            type: "subagent.completed",
            payload: {
              sessionId: record.sessionId,
              runId: started.parentRunId,
              provider: CODEX_DRIVER_NAME,
              subagentId: child.subagentId,
              ...(child.parentToolCallId === undefined
                ? {}
                : { parentToolCallId: child.parentToolCallId }),
            },
          },
        },
        "turn/completed",
      );
      await this.#dispatch.send(
        record.sessionId,
        {
          kind: "run_lifecycle",
          bindingId: child.bindingId,
          operation: { correlationKey: childThreadId, isOpening: false },
          change: composeCodexChildTerminal(started.childRunId, turnParams),
        },
        "turn/completed",
      );
    });
  }

  // The child run and its `subagent.started` row, dispatched together now; resolves with the
  // child's run id once the run engine started it.
  async #deliverStart(
    record: CodexSessionRecord,
    childThreadId: string,
    subagentId: string,
    parentRunId: RunId,
    origin: { readonly bindingId: string; readonly spawnCall: CodexSpawnCall | undefined },
  ): Promise<CodexStartedChildRun | undefined> {
    const childStart: Promise<InboundOutcome | undefined> = this.#dispatch.send(
      record.sessionId,
      {
        kind: "child_run",
        bindingId: origin.bindingId,
        operation: { correlationKey: childThreadId, isOpening: true },
        parentRunId,
      },
      "thread/started",
    );
    const startRowSent = this.#dispatch.send(
      record.sessionId,
      {
        kind: "session_row",
        bindingId: origin.bindingId,
        row: {
          type: "subagent.started",
          payload: {
            sessionId: record.sessionId,
            runId: parentRunId,
            provider: CODEX_DRIVER_NAME,
            subagentId,
            ...(origin.spawnCall === undefined
              ? {}
              : { parentToolCallId: origin.spawnCall.toolCallId }),
          },
        },
      },
      "thread/started",
    );
    const outcome = await childStart;
    if (outcome?.disposition !== "child_run_started") {
      return undefined;
    }
    record.delivery.childThreadIdByRunId.set(outcome.runId, childThreadId);
    return {
      childRunId: outcome.runId,
      parentRunId,
      startRowEventId: startRowSent.then(eventIdOf),
    };
  }
}
