// A throwing diagnostics sink never reaches the provider event path, and the diagnostics ring stays
// bounded.

import { describe, expect, it } from "vitest";

import { DriverDiagnosticsEmitter, type DriverDiagnosticRecord } from "../diagnostics.js";

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
  it("bounds the recent-record ring at its declared capacity, oldest shed first", () => {
    const emitter = new DriverDiagnosticsEmitter({
      logSink: { record: () => undefined },
      recentRecordCapacity: 3,
    });
    for (let sequence = 0; sequence < 5; sequence += 1) {
      emitter.emit(makeRecord({ rawWireType: `frame-${sequence}` }));
    }
    expect(emitter.emittedRecordCount()).toBe(5);
    expect(
      emitter.recentRecordsOfKind("unmapped_wire_kind").map((record) => record.rawWireType),
    ).toEqual(["frame-2", "frame-3", "frame-4"]);
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
});
