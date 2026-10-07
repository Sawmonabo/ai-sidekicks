// The inbound dispatch over a real database: what a provider delivers after an undo's cut, on a
// binding the cut kept and on one a fork and restart froze, and after its run has ended.

import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { RunId } from "@ai-sidekicks/contracts/run/id";

import { makeSilentDriverDiagnostics } from "../../../provider/__fixtures__/silent-driver-diagnostics.js";
import type { DriverDiagnosticsEmitter } from "../../../provider/driver/diagnostics.js";
import type { RunEngine, RunTransitionRequest } from "../engine.js";
import { ExecutionEpochs, type DeliveryOperation, type EpochBinding } from "../epochs.js";
import {
  RunInboundDispatch,
  type InboundDelivery,
  type InboundOutcome,
  type LateAppendableRow,
} from "../inbound.js";
import { openRunEngineFixture, type RunEngineFixture } from "./engine.test-support.js";

describe("run inbound dispatch", () => {
  let fixture: RunEngineFixture;
  let diagnostics: DriverDiagnosticsEmitter;
  // Every change that reached the engine's transition path, the terminal emitter among them.
  let changesReachingEngine: RunTransitionRequest[];

  beforeEach(async () => {
    fixture = await openRunEngineFixture();
    diagnostics = makeSilentDriverDiagnostics();
    changesReachingEngine = [];
  });

  afterEach(async () => {
    await fixture.close();
  });

  function openDispatch(maxAssociationsPerBinding?: number): {
    dispatch: (delivery: InboundDelivery) => Promise<InboundOutcome>;
    epochs: ExecutionEpochs;
  } {
    const epochs = new ExecutionEpochs({
      diagnostics,
      ...(maxAssociationsPerBinding === undefined ? {} : { maxAssociationsPerBinding }),
    });
    const engine: Pick<RunEngine, "applyProviderStateChange"> = {
      applyProviderStateChange: (change) => {
        changesReachingEngine.push(change);
        return fixture.engine.applyProviderStateChange(change);
      },
    };
    const inbound = new RunInboundDispatch({
      engine,
      epochs,
      diagnostics,
      sessionEvents: fixture.sessionEvents,
    });
    return { dispatch: (delivery) => inbound.dispatch(delivery), epochs };
  }

  function makeBinding(runId: RunId): EpochBinding {
    return { id: randomUUID(), runId, driverName: "codex" };
  }

  function usageRow(runId: RunId, toModel: string): LateAppendableRow {
    return {
      type: "usage.model_rerouted",
      payload: {
        sessionId: fixture.sessionId,
        runId,
        fromModel: "gpt-5.5",
        toModel,
        scope: "turn",
        cause: "model_unavailable",
      },
    };
  }

  function opening(correlationKey: string): DeliveryOperation {
    return { correlationKey, isOpening: true };
  }

  function continuing(correlationKey: string): DeliveryOperation {
    return { correlationKey, isOpening: false };
  }

  // Each usage row's payload, keyed by the model it names, in log order.
  function readUsageRows(): Map<string, Record<string, unknown>> {
    const rows = fixture.database.reader
      .prepare<[], { payload: string }>(
        "SELECT payload FROM session_events WHERE type = 'usage.model_rerouted' ORDER BY sequence",
      )
      .all()
      .map((row) => JSON.parse(row.payload) as Record<string, unknown>);
    return new Map(rows.map((payload) => [String(payload["toModel"]), payload]));
  }

  function countSessionEvents(): number {
    return (
      fixture.database.reader.prepare("SELECT COUNT(*) AS total FROM session_events").get() as {
        total: number;
      }
    ).total;
  }

  function absorbedRecords(): readonly Readonly<Record<string, unknown>>[] {
    return diagnostics.recentRecordsOfKind("late_event_absorbed").map((record) => record.details);
  }

  // Opens `turns` turns on the binding, each through a turn boundary it delivered.
  async function openTurns(
    dispatch: (delivery: InboundDelivery) => Promise<InboundOutcome>,
    bindingId: string,
    turns: number,
  ): Promise<void> {
    for (let turn = 0; turn < turns; turn += 1) {
      expect(await dispatch({ kind: "turn_boundary", bindingId })).toEqual({
        disposition: "turn_opened",
      });
    }
  }

  it.each<{ name: string; change: (runId: RunId) => RunTransitionRequest }>([
    {
      name: "run.completed",
      change: (runId) => ({ runId, newState: "completed", completionKind: "turn" }),
    },
    {
      name: "run.failed",
      change: (runId) => ({ runId, newState: "failed", failureCategory: "provider failure" }),
    },
  ])(
    "absorbs a stale $name from before a cut at the epoch check, short of the terminal emitter",
    async ({ change }) => {
      const runId = await fixture.runThrough(["starting", "running"]);
      const { dispatch, epochs } = openDispatch();
      const binding = makeBinding(runId);
      epochs.openBinding(binding, { epoch: 0, position: 0 });
      await openTurns(dispatch, binding.id, 3);
      await dispatch({
        kind: "session_row",
        bindingId: binding.id,
        operation: opening("turn-3"),
        row: usageRow(runId, "turn-3-usage"),
      });
      epochs.fenceCut({ mode: "in_place", bindingId: binding.id, point: 2 });
      const runBefore = fixture.runs.getRun(runId);
      const eventsBefore = countSessionEvents();

      const outcome = await dispatch({
        kind: "run_lifecycle",
        bindingId: binding.id,
        operation: continuing("turn-3"),
        change: change(runId),
      });

      expect(outcome).toEqual({ disposition: "absorbed", reason: "before_cut" });
      expect(changesReachingEngine).toEqual([]);
      expect(countSessionEvents()).toBe(eventsBefore);
      expect(fixture.runs.getRun(runId)).toEqual(runBefore);
      expect(absorbedRecords()).toEqual([
        expect.objectContaining({ reason: "before_cut", sourceEpoch: 0, sourcePosition: 3 }),
      ]);
    },
  );

  it("absorbs a permission ask from before a cut, so it never reaches the approval normalizer", async () => {
    const runId = await fixture.runThrough(["starting", "running"]);
    const { dispatch, epochs } = openDispatch();
    const binding = makeBinding(runId);
    epochs.openBinding(binding, { epoch: 0, position: 0 });
    await openTurns(dispatch, binding.id, 4);
    await dispatch({
      kind: "session_row",
      bindingId: binding.id,
      operation: opening("tool-call-4"),
      row: usageRow(runId, "turn-4-usage"),
    });
    epochs.fenceCut({ mode: "in_place", bindingId: binding.id, point: 1 });
    const asksReachingNormalizer: InboundDelivery[] = [];
    // What the driver's wiring does with each ask: hand the normalizer only what was admitted.
    const deliverAsk = async (operation: DeliveryOperation): Promise<void> => {
      const ask: InboundDelivery = { kind: "permission_ask", bindingId: binding.id, operation };
      if ((await dispatch(ask)).disposition === "ask_admitted") {
        asksReachingNormalizer.push(ask);
      }
    };
    const runBefore = fixture.runs.getRun(runId);
    const eventsBefore = countSessionEvents();

    await deliverAsk(continuing("tool-call-4"));

    expect(asksReachingNormalizer).toEqual([]);
    expect(countSessionEvents()).toBe(eventsBefore);
    expect(fixture.runs.getRun(runId)).toEqual(runBefore);
    expect(absorbedRecords()).toEqual([
      expect.objectContaining({ reason: "before_cut", deliveryKind: "permission_ask" }),
    ]);

    // An ask the new execution opens is handed on.
    await deliverAsk(opening("tool-call-2"));
    expect(asksReachingNormalizer).toHaveLength(1);
  });

  it.each<{ name: string; change: (runId: RunId) => RunTransitionRequest }>([
    {
      name: "a terminal",
      change: (runId) => ({ runId, newState: "completed", completionKind: "turn" }),
    },
    { name: "a re-open to running", change: (runId) => ({ runId, newState: "running" }) },
    { name: "a wait", change: (runId) => ({ runId, newState: "waiting_for_approval" }) },
  ])(
    "absorbs $name against an ended run with no row, no state change and no version advance",
    async ({ change }) => {
      const runId = await fixture.runThrough(["starting", "running", "interrupted"]);
      const { dispatch, epochs } = openDispatch();
      const binding = makeBinding(runId);
      epochs.openBinding(binding, { epoch: 0, position: 1 });
      const eventsBefore = fixture.readRunEvents(runId);
      const runBefore = fixture.runs.getRun(runId);

      const outcome = await dispatch({
        kind: "run_lifecycle",
        bindingId: binding.id,
        change: change(runId),
      });

      expect(outcome).toEqual({ disposition: "absorbed", reason: "run_ended" });
      expect(changesReachingEngine).toHaveLength(1);
      expect(fixture.readRunEvents(runId)).toEqual(eventsBefore);
      expect(fixture.runs.getRun(runId)).toEqual(runBefore);
      expect(absorbedRecords()).toEqual([expect.objectContaining({ reason: "run_ended" })]);
    },
  );

  it("absorbs a straggler that meets the run's terminal still queued, refused inside its own write", async () => {
    const runId = await fixture.runThrough(["starting", "running"]);
    const { dispatch, epochs } = openDispatch();
    const binding = makeBinding(runId);
    epochs.openBinding(binding, { epoch: 0, position: 1 });

    // Both read the run running; the interrupt queues first, so the straggler's swap meets it.
    const interrupt = fixture.engine.transition({ runId, newState: "interrupted" });
    const straggler = dispatch({
      kind: "run_lifecycle",
      bindingId: binding.id,
      change: { runId, newState: "waiting_for_approval" },
    });

    await interrupt;
    expect(await straggler).toEqual({ disposition: "absorbed", reason: "run_ended" });
    expect(fixture.readRunEvents(runId).map((row) => row.type)).toEqual([
      "run.queued",
      "run.starting",
      "run.running",
      "run.interrupted",
    ]);
    expect(fixture.runs.getRun(runId)).toMatchObject({ state: "interrupted", version: 3 });
  });

  it("stamps late usage rows with the turn each operation opened at, on both sides of the cut's point", async () => {
    const runId = await fixture.runThrough(["starting", "running"]);
    const { dispatch, epochs } = openDispatch();
    const binding = makeBinding(runId);
    epochs.openBinding(binding, { epoch: 0, position: 0 });
    for (const turn of [1, 2, 3, 4, 5]) {
      await dispatch({ kind: "turn_boundary", bindingId: binding.id });
      await dispatch({
        kind: "session_row",
        bindingId: binding.id,
        operation: opening(`message-${String(turn)}`),
        row: usageRow(runId, `opened-${String(turn)}`),
      });
    }
    epochs.fenceCut({ mode: "in_place", bindingId: binding.id, point: 3 });

    const kept = await dispatch({
      kind: "session_row",
      bindingId: binding.id,
      operation: continuing("message-2"),
      row: usageRow(runId, "late-for-turn-2"),
    });
    const cutAway = await dispatch({
      kind: "session_row",
      bindingId: binding.id,
      operation: continuing("message-4"),
      row: usageRow(runId, "late-for-turn-4"),
    });

    expect(kept).toEqual({ disposition: "appended_stamped", source: { epoch: 0, position: 2 } });
    expect(cutAway).toEqual({ disposition: "appended_stamped", source: { epoch: 0, position: 4 } });
    const rows = readUsageRows();
    expect(rows.get("late-for-turn-2")).toMatchObject({ runId, sourceEpoch: 0, sourcePosition: 2 });
    expect(rows.get("late-for-turn-4")).toMatchObject({ runId, sourceEpoch: 0, sourcePosition: 4 });
  });

  it("keeps a late assistant message's body beside its stamped row", async () => {
    const runId = await fixture.runThrough(["starting", "running"]);
    const { dispatch, epochs } = openDispatch();
    const binding = makeBinding(runId);
    epochs.openBinding(binding, { epoch: 0, position: 0 });
    await openTurns(dispatch, binding.id, 2);
    await dispatch({
      kind: "session_row",
      bindingId: binding.id,
      operation: opening("message-2"),
      row: usageRow(runId, "opened-2"),
    });
    epochs.fenceCut({ mode: "in_place", bindingId: binding.id, point: 1 });

    await dispatch({
      kind: "session_row",
      bindingId: binding.id,
      operation: continuing("message-2"),
      row: {
        type: "assistant.message",
        payload: { sessionId: fixture.sessionId, runId, contentType: "text/markdown" },
      },
      content: { body: "The retry is in place." },
    });

    const stored = fixture.database.reader
      .prepare(
        "SELECT payload, content_payload FROM session_events WHERE type = 'assistant.message'",
      )
      .get() as { payload: string; content_payload: string | null };
    expect(stored.content_payload).toBe("The retry is in place.");
    expect(JSON.parse(stored.payload)).toMatchObject({ runId, sourceEpoch: 0, sourcePosition: 2 });
  });

  it("rotates the generation at an in-place fence: a re-executed turn's row is current, its twin stays stamped", async () => {
    const runId = await fixture.runThrough(["starting", "running"]);
    const { dispatch, epochs } = openDispatch();
    const binding = makeBinding(runId);
    epochs.openBinding(binding, { epoch: 0, position: 0 });
    await openTurns(dispatch, binding.id, 4);
    await dispatch({
      kind: "session_row",
      bindingId: binding.id,
      operation: opening("tool-call-first-try"),
      row: usageRow(runId, "first-try-opened"),
    });
    epochs.fenceCut({ mode: "in_place", bindingId: binding.id, point: 3 });
    // The turn re-executes at the same ordinal, 4.
    await openTurns(dispatch, binding.id, 1);
    await dispatch({
      kind: "session_row",
      bindingId: binding.id,
      operation: opening("tool-call-second-try"),
      row: usageRow(runId, "second-try-opened"),
    });

    const reExecuted = await dispatch({
      kind: "session_row",
      bindingId: binding.id,
      operation: continuing("tool-call-second-try"),
      row: usageRow(runId, "second-try-late"),
    });
    const twin = await dispatch({
      kind: "session_row",
      bindingId: binding.id,
      operation: continuing("tool-call-first-try"),
      row: usageRow(runId, "first-try-late"),
    });

    expect(reExecuted).toEqual({ disposition: "appended" });
    expect(twin).toEqual({ disposition: "appended_stamped", source: { epoch: 0, position: 4 } });
    const rows = readUsageRows();
    for (const current of ["second-try-opened", "second-try-late"]) {
      expect(rows.get(current)).not.toHaveProperty("sourceEpoch");
      expect(rows.get(current)).not.toHaveProperty("sourcePosition");
    }
    expect(rows.get("first-try-late")).toMatchObject({ sourceEpoch: 0, sourcePosition: 4 });
  });

  it("freezes the old binding whole at a fork and restart, while the new binding's deliveries are current", async () => {
    const runId = await fixture.runThrough(["starting", "running"]);
    const { dispatch, epochs } = openDispatch();
    const oldBinding = makeBinding(runId);
    const newBinding = makeBinding(runId);
    epochs.openBinding(oldBinding, { epoch: 0, position: 0 });
    await openTurns(dispatch, oldBinding.id, 6);
    epochs.fenceCut({ mode: "fork_restart", bindingId: oldBinding.id, point: 2, newBinding });
    const retained = { epoch: 0, position: 6 };

    const onOld = [
      await dispatch({ kind: "turn_boundary", bindingId: oldBinding.id }),
      await dispatch({
        kind: "session_row",
        bindingId: oldBinding.id,
        row: usageRow(runId, "old-without-operation"),
      }),
      await dispatch({
        kind: "session_row",
        bindingId: oldBinding.id,
        operation: opening("old-new-operation"),
        row: usageRow(runId, "old-opening"),
      }),
      await dispatch({
        kind: "run_lifecycle",
        bindingId: oldBinding.id,
        change: { runId, newState: "completed", completionKind: "turn" },
      }),
    ];
    await openTurns(dispatch, newBinding.id, 1);
    const onNew = await dispatch({
      kind: "session_row",
      bindingId: newBinding.id,
      operation: opening("new-operation"),
      row: usageRow(runId, "new-opening"),
    });

    expect(onOld).toEqual([
      { disposition: "absorbed", reason: "before_cut" },
      { disposition: "appended_stamped", source: retained },
      { disposition: "appended_stamped", source: retained },
      { disposition: "absorbed", reason: "before_cut" },
    ]);
    expect(changesReachingEngine).toEqual([]);
    expect(onNew).toEqual({ disposition: "appended" });
    const rows = readUsageRows();
    expect(rows.get("old-without-operation")).toMatchObject({ sourceEpoch: 0, sourcePosition: 6 });
    expect(rows.get("new-opening")).not.toHaveProperty("sourceEpoch");
    expect(fixture.runs.getRun(runId)?.state).toBe("running");
  });

  it("reads a straggler whose association was evicted by kind: its row stamped with the closed generation's pair, its lifecycle event and ask current", async () => {
    const runId = await fixture.runThrough(["starting", "running"]);
    const { dispatch, epochs } = openDispatch(1);
    const binding = makeBinding(runId);
    epochs.openBinding(binding, { epoch: 0, position: 0 });
    await openTurns(dispatch, binding.id, 2);
    await dispatch({
      kind: "session_row",
      bindingId: binding.id,
      operation: opening("evicted-operation"),
      row: usageRow(runId, "evicted-opened"),
    });
    await openTurns(dispatch, binding.id, 3);
    await dispatch({
      kind: "session_row",
      bindingId: binding.id,
      operation: opening("kept-operation"),
      row: usageRow(runId, "kept-opened"),
    });
    epochs.fenceCut({ mode: "in_place", bindingId: binding.id, point: 1 });

    const evictedLate = await dispatch({
      kind: "session_row",
      bindingId: binding.id,
      operation: continuing("evicted-operation"),
      row: usageRow(runId, "evicted-late"),
    });
    const afterFence = await dispatch({
      kind: "session_row",
      bindingId: binding.id,
      row: usageRow(runId, "after-fence"),
    });

    // The retained pair sits above the cut's point, so the row is superseded with its epoch.
    expect(evictedLate).toEqual({
      disposition: "appended_stamped",
      source: { epoch: 0, position: 5 },
    });
    expect(readUsageRows().get("evicted-late")).toMatchObject({
      sourceEpoch: 0,
      sourcePosition: 5,
    });
    expect(afterFence).toEqual({ disposition: "appended" });
    expect(diagnostics.recentRecordsOfKind("epoch_association_evicted")).toHaveLength(1);

    // A live terminal or ask absorbed here would leave the provider waiting, so both are current.
    const lifecycle = await dispatch({
      kind: "run_lifecycle",
      bindingId: binding.id,
      operation: continuing("evicted-operation"),
      change: { runId, newState: "waiting_for_approval" },
    });
    const ask = await dispatch({
      kind: "permission_ask",
      bindingId: binding.id,
      operation: continuing("evicted-operation"),
    });
    expect(lifecycle).toMatchObject({ disposition: "transitioned" });
    expect(ask).toEqual({ disposition: "ask_admitted" });
    expect(fixture.runs.getRun(runId)?.state).toBe("waiting_for_approval");
    expect(absorbedRecords()).toEqual([]);
  });

  it("records an opening whose key a closed generation holds afresh, so the reused operation is current", async () => {
    const runId = await fixture.runThrough(["starting", "running"]);
    const { dispatch, epochs } = openDispatch(2);
    const binding = makeBinding(runId);
    epochs.openBinding(binding, { epoch: 0, position: 0 });
    await openTurns(dispatch, binding.id, 2);
    for (const key of ["tool-call-1", "old-operation"]) {
      await dispatch({
        kind: "session_row",
        bindingId: binding.id,
        operation: opening(key),
        row: usageRow(runId, `${key}-opened`),
      });
    }
    epochs.fenceCut({ mode: "in_place", bindingId: binding.id, point: 1 });
    await openTurns(dispatch, binding.id, 1);

    // The provider reuses the operation id in the new execution.
    const reusedAsk = await dispatch({
      kind: "permission_ask",
      bindingId: binding.id,
      operation: opening("tool-call-1"),
    });
    // At the cap, the oldest association goes: the old operation, not the reused one.
    await dispatch({
      kind: "session_row",
      bindingId: binding.id,
      operation: opening("new-operation"),
      row: usageRow(runId, "new-operation-opened"),
    });
    const lifecycle = await dispatch({
      kind: "run_lifecycle",
      bindingId: binding.id,
      operation: continuing("tool-call-1"),
      change: { runId, newState: "waiting_for_approval" },
    });
    const row = await dispatch({
      kind: "session_row",
      bindingId: binding.id,
      operation: continuing("tool-call-1"),
      row: usageRow(runId, "reused-late"),
    });

    expect(reusedAsk).toEqual({ disposition: "ask_admitted" });
    expect(lifecycle).toMatchObject({ disposition: "transitioned" });
    expect(row).toEqual({ disposition: "appended" });
    expect(readUsageRows().get("reused-late")).not.toHaveProperty("sourceEpoch");
    expect(absorbedRecords()).toEqual([]);
    expect(
      diagnostics.recentRecordsOfKind("epoch_association_evicted").map((record) => record.details),
    ).toEqual([expect.objectContaining({ evictedEpoch: 0 })]);
  });
});
