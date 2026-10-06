// Codex inbound frames: an unmapped method lands on a diagnostic, connection-scoped frames are
// never quarantined, and each run epoch settles one terminal.

import { describe, expect, it } from "vitest";

import { makeSilentDriverDiagnostics } from "../../../__fixtures__/silent-driver-diagnostics.js";
import {
  classifyCodexFrameFamilyForRouting,
  resolveCodexFrameEmissionRoute,
} from "../event-normalizer.js";
import { TerminalEmissionGate, type TerminalRunFrame } from "../../../terminal-emission-gate.js";

describe("resolveCodexFrameEmissionRoute", () => {
  function makeDiagnostics() {
    return makeSilentDriverDiagnostics();
  }

  it(
    "routes an unmapped method to the diagnostic default branch, emitted, never thrown, never " +
      "enveloped",
    () => {
      const diagnostics = makeDiagnostics();
      const route = resolveCodexFrameEmissionRoute("thread/unheard-of", diagnostics);
      expect(route.route).toBe("diagnostic");
      if (route.route === "diagnostic") {
        expect(route.record.kind).toBe("unmapped_wire_kind");
        expect(route.record.rawWireType).toBe("thread/unheard-of");
        expect(route.record.provider).toBe("codex");
      }
      expect(diagnostics.emittedRecordCount()).toBe(1);
    },
  );
});

describe("classifyCodexFrameFamilyForRouting", () => {
  it("classifies the account-plane and notice families connection-scoped", () => {
    for (const connectionScopedMethod of [
      "error",
      "account/rateLimits/updated",
      "account/chatgptAuthTokens/refresh",
      "project/changed",
      // Its payload is the empty object, so it names no thread; an unlisted method quarantines,
      // which would emit a router diagnostic on every skill-file save.
      "skills/changed",
    ]) {
      expect(classifyCodexFrameFamilyForRouting(connectionScopedMethod)).toEqual({
        scope: "connection",
      });
    }
  });
});

// The terminal-emission boundary. A daemon-initiated close is stamped `intendedClose` so recovery
// reads a clean shutdown as clean rather than as a crash, and the ordinary post-interrupt double
// terminal for one `(runId, runVersion)` epoch is absorbed at the driver rather than failing
// against the partial unique index on terminal session events.

describe("TerminalEmissionGate", () => {
  const PROJECTED_ROUTE = { decision: "project" } as const;

  function terminalFrame(overrides: Partial<TerminalRunFrame> = {}): TerminalRunFrame {
    return {
      runId: "run-1",
      runVersion: 1,
      rawWireType: "turn/completed",
      route: PROJECTED_ROUTE,
      ...overrides,
    };
  }

  it("stamps `intendedClose: false` for a terminal no close preceded", () => {
    const gate = new TerminalEmissionGate();

    expect(gate.admitTerminalFrame(terminalFrame())).toStrictEqual({
      emit: true,
      runId: "run-1",
      runVersion: 1,
      intendedClose: false,
    });
  });

  it("stamps `intendedClose: true` once a daemon-initiated close is signaled", () => {
    const gate = new TerminalEmissionGate();

    gate.signalIntendedClose();

    expect(gate.intendedCloseSignaled()).toBe(true);
    expect(gate.admitTerminalFrame(terminalFrame())).toMatchObject({
      emit: true,
      intendedClose: true,
    });
  });

  it("suppresses a second terminal for the SAME epoch", () => {
    // The ordinary post-interrupt double, absorbed here rather than failing against the schema
    // backstop.
    const gate = new TerminalEmissionGate();
    gate.admitTerminalFrame(terminalFrame());

    expect(gate.admitTerminalFrame(terminalFrame({ rawWireType: "turn/failed" }))).toStrictEqual({
      emit: false,
      suppressionReason: "duplicate-terminal-epoch",
    });
    expect(gate.hasSettledEpoch("run-1", 1)).toBe(true);
  });

  it("admits a NEW epoch for the same run", () => {
    // The key is the epoch, not the run: a re-dispatched run version is a separate settlement.
    const gate = new TerminalEmissionGate();
    gate.admitTerminalFrame(terminalFrame());

    expect(gate.admitTerminalFrame(terminalFrame({ runVersion: 2 }))).toMatchObject({ emit: true });
    expect(gate.hasSettledEpoch("run-1", 2)).toBe(true);
  });

  it("settles no run for a frame the router did not route to the session's thread", () => {
    // Routing is consumed, not re-decided: a child thread's terminal must not settle the parent's
    // run.
    const gate = new TerminalEmissionGate();

    const decision = gate.admitTerminalFrame(
      terminalFrame({ route: { decision: "suppress-child-transcript", childThreadId: "child-1" } }),
    );

    expect(decision).toStrictEqual({ emit: false, suppressionReason: "not-the-session-thread" });
    // It consumed no epoch, so the parent's own terminal still settles.
    expect(gate.hasSettledEpoch("run-1", 1)).toBe(false);
  });

  it("evicts oldest-first so the memory stays proportional to the hazard", () => {
    // A long session's run count is unbounded; the window in which a duplicate arrives is not.
    const gate = new TerminalEmissionGate({ settledEpochMemory: 2 });
    gate.admitTerminalFrame(terminalFrame({ runId: "run-a" }));
    gate.admitTerminalFrame(terminalFrame({ runId: "run-b" }));
    gate.admitTerminalFrame(terminalFrame({ runId: "run-c" }));

    expect(gate.hasSettledEpoch("run-a", 1)).toBe(false);
    expect(gate.hasSettledEpoch("run-b", 1)).toBe(true);
    expect(gate.hasSettledEpoch("run-c", 1)).toBe(true);
  });
});
