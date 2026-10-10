// The reorder buffer releases every provider event in pairing order, losing none on overflow,
// timeout or eviction, and reports each of them on the diagnostic channel.

import { describe, expect, it } from "vitest";

import { DriverDiagnosticsEmitter, InMemoryDriverDiagnosticCounterSink } from "../diagnostics.js";
import { NormalizedEventReorderBuffer } from "../reorder-buffer.js";
import { makeSilentDriverDiagnostics } from "../../__fixtures__/silent-driver-diagnostics.js";

describe("NormalizedEventReorderBuffer", () => {
  function makeBuffer(options?: { maxBufferedEvents?: number; pairingTimeoutMs?: number }) {
    const emitter = makeSilentDriverDiagnostics();
    const buffer = new NormalizedEventReorderBuffer<string>({
      provider: "codex",
      diagnostics: emitter,
      maxBufferedEvents: options?.maxBufferedEvents ?? 4,
      pairingTimeoutMs: options?.pairingTimeoutMs ?? 1_000,
    });
    return { buffer, emitter };
  }

  it("passes initiations, unpaired events and already-paired completions straight through", () => {
    const { buffer } = makeBuffer();
    expect(
      buffer.admit({ toolCallId: "tool-1", pairingRole: "initiation", event: "start-1" }, 0),
    ).toEqual(["start-1"]);
    expect(buffer.admit({ toolCallId: null, pairingRole: "unpaired", event: "delta" }, 1)).toEqual([
      "delta",
    ]);
    expect(
      buffer.admit({ toolCallId: "tool-1", pairingRole: "completion", event: "done-1" }, 2),
    ).toEqual(["done-1"]);
  });

  it("holds a completion that outran its initiation and releases the pair in order", () => {
    const { buffer } = makeBuffer();
    expect(
      buffer.admit({ toolCallId: "tool-1", pairingRole: "completion", event: "done-1" }, 0),
    ).toEqual([]);
    // The initiation releases itself first, then the completion it unblocks.
    expect(
      buffer.admit({ toolCallId: "tool-1", pairingRole: "initiation", event: "start-1" }, 1),
    ).toEqual(["start-1", "done-1"]);
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
    expect(emitter.recentRecordsOfKind("reorder_buffer_overflow")).toHaveLength(1);
    expect(counterSink.totalFor("driver.reorder_buffer.overflow")).toBe(1);
  });

  it("sheds unpaired completions past pairingTimeoutMs with a diagnostic, in arrival order", () => {
    const { buffer, emitter } = makeBuffer({ pairingTimeoutMs: 500 });
    buffer.admit({ toolCallId: "tool-1", pairingRole: "completion", event: "done-1" }, 0);
    expect(buffer.flushExpired(499)).toEqual([]);
    expect(buffer.flushExpired(500)).toEqual(["done-1"]);
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

  it("bounds the seen-initiation set: oldest evicted first, each eviction a diagnostic", () => {
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

    const evictions = emitter.recentRecordsOfKind("reorder_seen_initiation_evicted");
    expect(evictions).toHaveLength(1);
    // Oldest first: the survivors are the ones a late completion is most likely still racing.
    expect(evictions[0]?.details["toolCallId"]).toBe("tool-1");
    expect(counterSink.totalFor("driver.reorder_buffer.seen_initiation_evicted")).toBe(1);

    // An evicted call's late completion is held, then shed at the pairing timeout with its own
    // diagnostic.
    expect(
      buffer.admit({ toolCallId: "tool-1", pairingRole: "completion", event: "done-1" }, 4),
    ).toEqual([]);
    expect(buffer.flushExpired(60_004)).toEqual(["done-1"]);
    expect(emitter.recentRecordsOfKind("tool_pairing_timeout")).toHaveLength(1);
  });
});
