// Driver diagnostics emitter and reorder buffer. An unrecognized wire shape reaches the log
// sink, the counter sink under its instrument name, and the bounded recent-record ring. Buffer
// overflow flushes in arrival order and a pairing timeout sheds; each emits a diagnostic.

import { describe, expect, it } from "vitest";

import {
  DRIVER_DIAGNOSTIC_COUNTER_NAMES,
  DriverDiagnosticsEmitter,
  InMemoryDriverDiagnosticCounterSink,
  NormalizedEventReorderBuffer,
  type DriverDiagnosticRecord,
} from "../driver-diagnostics.js";

function makeRecord(overrides?: Partial<DriverDiagnosticRecord>): DriverDiagnosticRecord {
  return {
    provider: "codex",
    kind: "unmapped_wire_kind",
    rawWireType: "thread/unheard-of",
    dispositionReason: "test record",
    details: {},
    ...overrides,
  };
}

describe("DriverDiagnosticsEmitter", () => {
  it("delivers every record to the log sink, the counter sink, and the ring", () => {
    const loggedRecords: DriverDiagnosticRecord[] = [];
    const counterSink = new InMemoryDriverDiagnosticCounterSink();
    const emitter = new DriverDiagnosticsEmitter({
      logSink: { record: (record) => loggedRecords.push(record) },
      counterSink,
    });

    emitter.emit(makeRecord());
    emitter.emit(makeRecord({ kind: "payload_variant_pending" }));

    expect(loggedRecords).toHaveLength(2);
    expect(emitter.emittedRecordCount()).toBe(2);
    expect(emitter.recentRecords()).toHaveLength(2);
    expect(emitter.recentRecordsOfKind("unmapped_wire_kind")).toHaveLength(1);
    expect(counterSink.totalFor(DRIVER_DIAGNOSTIC_COUNTER_NAMES.unmapped_wire_kind)).toBe(1);
    expect(counterSink.totalFor(DRIVER_DIAGNOSTIC_COUNTER_NAMES.payload_variant_pending)).toBe(1);
  });

  it("pairs EVERY diagnostic kind with a counter name in the `driver.<band>.<condition>` shape", () => {
    // The `Record<DriverDiagnosticKind, string>` type makes a kind without a counter a build
    // error but cannot check the name, which dashboards read; assert its shape over the whole
    // table.
    const counterNames = Object.entries(DRIVER_DIAGNOSTIC_COUNTER_NAMES);
    expect(counterNames.length).toBeGreaterThan(0);
    for (const [kind, counterName] of counterNames) {
      expect(counterName, `counter name for kind ${kind}`).toMatch(
        /^driver\.[a-z0-9_]+\.[a-z0-9_]+$/,
      );
    }
    // A shared counter would make two conditions indistinguishable.
    expect(new Set(counterNames.map(([, counterName]) => counterName)).size).toBe(
      counterNames.length,
    );
  });

  it("pins the reorder-buffer overflow instrument name verbatim", () => {
    // Dashboards read this name literally; a rename is a contract change.
    expect(DRIVER_DIAGNOSTIC_COUNTER_NAMES.reorder_buffer_overflow).toBe(
      "driver.reorder_buffer.overflow",
    );
  });

  it("bounds the recent-record ring at its declared capacity, oldest shed first", () => {
    const emitter = new DriverDiagnosticsEmitter({
      logSink: { record: () => undefined },
      recentRecordCapacity: 3,
    });
    for (let sequence = 0; sequence < 5; sequence += 1) {
      emitter.emit(makeRecord({ rawWireType: `frame-${sequence}` }));
    }
    expect(emitter.emittedRecordCount()).toBe(5);
    expect(emitter.recentRecords().map((record) => record.rawWireType)).toEqual([
      "frame-2",
      "frame-3",
      "frame-4",
    ]);
  });

  it("contains a throwing sink — a failing sink never takes the boundary down", () => {
    const emitter = new DriverDiagnosticsEmitter({
      logSink: {
        record: () => {
          throw new Error("log sink outage");
        },
      },
      counterSink: {
        increment: () => {
          throw new Error("metrics outage");
        },
      },
    });
    expect(() => emitter.emit(makeRecord())).not.toThrow();
    expect(emitter.emittedRecordCount()).toBe(1);
  });

  it("freezes emitted records so consumers cannot mutate the diagnostic trail", () => {
    const emitter = new DriverDiagnosticsEmitter({ logSink: { record: () => undefined } });
    emitter.emit(makeRecord());
    const retained = emitter.recentRecords()[0];
    expect(Object.isFrozen(retained)).toBe(true);
    expect(Object.isFrozen(retained?.details)).toBe(true);
  });
});

describe("NormalizedEventReorderBuffer", () => {
  function makeBuffer(options?: { maxBufferedEvents?: number; pairingTimeoutMs?: number }) {
    const emitter = new DriverDiagnosticsEmitter({ logSink: { record: () => undefined } });
    const buffer = new NormalizedEventReorderBuffer<string>({
      provider: "codex",
      diagnostics: emitter,
      maxBufferedEvents: options?.maxBufferedEvents ?? 4,
      pairingTimeoutMs: options?.pairingTimeoutMs ?? 1_000,
    });
    return { buffer, emitter };
  }

  it("passes initiations and unpaired events straight through in arrival order", () => {
    const { buffer } = makeBuffer();
    expect(
      buffer.admit({ toolCallId: "tool-1", pairingRole: "initiation", event: "start-1" }, 0),
    ).toEqual(["start-1"]);
    expect(buffer.admit({ toolCallId: null, pairingRole: "unpaired", event: "delta" }, 1)).toEqual([
      "delta",
    ]);
    expect(buffer.heldEventCount()).toBe(0);
  });

  it("holds a completion that outran its initiation and releases the pair in order", () => {
    const { buffer } = makeBuffer();
    expect(
      buffer.admit({ toolCallId: "tool-1", pairingRole: "completion", event: "done-1" }, 0),
    ).toEqual([]);
    expect(buffer.heldEventCount()).toBe(1);
    // The initiation releases itself first, then the completion it unblocks.
    expect(
      buffer.admit({ toolCallId: "tool-1", pairingRole: "initiation", event: "start-1" }, 1),
    ).toEqual(["start-1", "done-1"]);
    expect(buffer.heldEventCount()).toBe(0);
  });

  it("releases a completion immediately once its initiation has been seen", () => {
    const { buffer } = makeBuffer();
    buffer.admit({ toolCallId: "tool-1", pairingRole: "initiation", event: "start-1" }, 0);
    expect(
      buffer.admit({ toolCallId: "tool-1", pairingRole: "completion", event: "done-1" }, 1),
    ).toEqual(["done-1"]);
  });

  it("flushes everything in arrival order on overflow, with the diagnostic + counter", () => {
    const counterSink = new InMemoryDriverDiagnosticCounterSink();
    const emitter = new DriverDiagnosticsEmitter({
      logSink: { record: () => undefined },
      counterSink,
    });
    const buffer = new NormalizedEventReorderBuffer<string>({
      provider: "codex",
      diagnostics: emitter,
      maxBufferedEvents: 2,
      pairingTimeoutMs: 60_000,
    });
    buffer.admit({ toolCallId: "tool-a", pairingRole: "completion", event: "done-a" }, 0);
    buffer.admit({ toolCallId: "tool-b", pairingRole: "completion", event: "done-b" }, 1);
    const released = buffer.admit(
      { toolCallId: "tool-c", pairingRole: "completion", event: "done-c" },
      2,
    );
    expect(released).toEqual(["done-a", "done-b", "done-c"]);
    expect(buffer.heldEventCount()).toBe(0);
    expect(emitter.recentRecordsOfKind("reorder_buffer_overflow")).toHaveLength(1);
    expect(counterSink.totalFor("driver.reorder_buffer.overflow")).toBe(1);
  });

  it("sheds an unpaired completion past pairingTimeoutMs with a diagnostic, in arrival order", () => {
    const { buffer, emitter } = makeBuffer({ pairingTimeoutMs: 500 });
    buffer.admit({ toolCallId: "tool-1", pairingRole: "completion", event: "done-1" }, 0);
    expect(buffer.flushExpired(499)).toEqual([]);
    expect(buffer.flushExpired(500)).toEqual(["done-1"]);
    expect(buffer.heldEventCount()).toBe(0);
    const timeoutRecords = emitter.recentRecordsOfKind("tool_pairing_timeout");
    expect(timeoutRecords).toHaveLength(1);
    expect(timeoutRecords[0]?.details["toolCallId"]).toBe("tool-1");
  });

  it("expires overdue holds on the next admission as well, ahead of the new event", () => {
    const { buffer } = makeBuffer({ pairingTimeoutMs: 500 });
    buffer.admit({ toolCallId: "tool-1", pairingRole: "completion", event: "done-1" }, 0);
    const released = buffer.admit(
      { toolCallId: null, pairingRole: "unpaired", event: "later-delta" },
      1_000,
    );
    expect(released).toEqual(["done-1", "later-delta"]);
  });

  it("drops a tool call from the seen-initiation ledger once its pair closes", () => {
    const { buffer } = makeBuffer();
    buffer.admit({ toolCallId: "tool-1", pairingRole: "initiation", event: "start-1" }, 0);
    expect(buffer.seenInitiationCount()).toBe(1);

    // A closed pair never needs its ledger entry again; keeping it would grow the ledger with
    // every tool call for the life of the session.
    buffer.admit({ toolCallId: "tool-1", pairingRole: "completion", event: "done-1" }, 1);
    expect(buffer.seenInitiationCount()).toBe(0);
  });

  it("drops the ledger entry on the other closing path too — an initiation releasing held completions", () => {
    const { buffer } = makeBuffer();
    buffer.admit({ toolCallId: "tool-1", pairingRole: "completion", event: "done-1" }, 0);
    buffer.admit({ toolCallId: "tool-1", pairingRole: "initiation", event: "start-1" }, 1);
    expect(buffer.seenInitiationCount()).toBe(0);
  });

  it("bounds the seen-initiation ledger: oldest evicted first, each eviction a diagnostic", () => {
    const counterSink = new InMemoryDriverDiagnosticCounterSink();
    const emitter = new DriverDiagnosticsEmitter({
      logSink: { record: () => undefined },
      counterSink,
    });
    const buffer = new NormalizedEventReorderBuffer<string>({
      provider: "codex",
      diagnostics: emitter,
      maxBufferedEvents: 4,
      pairingTimeoutMs: 60_000,
      maxSeenInitiationIds: 2,
    });

    // Initiations that never complete, as when a turn is interrupted mid-tool.
    for (const ordinal of [1, 2, 3]) {
      buffer.admit(
        {
          toolCallId: `tool-${String(ordinal)}`,
          pairingRole: "initiation",
          event: `start-${String(ordinal)}`,
        },
        ordinal,
      );
    }
    expect(buffer.seenInitiationCount()).toBe(2);

    const evictions = emitter.recentRecordsOfKind("reorder_initiation_ledger_evicted");
    expect(evictions).toHaveLength(1);
    // Oldest first: the survivors are the ones a late completion is most likely still racing.
    expect(evictions[0]?.details["toolCallId"]).toBe("tool-1");
    expect(counterSink.totalFor("driver.reorder_buffer.initiation_ledger_evicted")).toBe(1);

    // An evicted call's late completion is held, then shed at the pairing timeout with its own
    // diagnostic.
    expect(
      buffer.admit({ toolCallId: "tool-1", pairingRole: "completion", event: "done-1" }, 4),
    ).toEqual([]);
    expect(buffer.flushExpired(60_004)).toEqual(["done-1"]);
    expect(emitter.recentRecordsOfKind("tool_pairing_timeout")).toHaveLength(1);
  });
});
