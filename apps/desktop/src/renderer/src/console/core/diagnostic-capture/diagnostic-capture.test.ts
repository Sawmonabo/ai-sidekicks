// What the always-on capture promises: JSONL under named caps, a counted drop rather
// than a silent one, a positive marker when it cannot see, and a forward that loses
// nothing when it fails.

import { describe, expect, it } from "vitest";

import { DIAGNOSTIC_CAPTURE_BOUNDS } from "./diagnostic-capture-bounds.js";
import {
  DIAGNOSTIC_BAND_FORWARD_PROBE,
  DiagnosticCapture,
  type DiagnosticRecord,
  toJsonLines,
} from "./diagnostic-capture.js";
import { routeTripwiresToDiagnosticCapture } from "./tripwire-diagnostic-route.js";
import { TripwireRegistry } from "../tripwires.js";

const AT = "2026-09-08T00:00:00.000Z";

function recordAt(index: number): DiagnosticRecord {
  return {
    at: AT,
    severity: "error",
    source: "console/test",
    kind: "sample",
    detail: `record ${index}`,
  };
}

describe("JSONL encoding", () => {
  it("writes one record per line with a fixed field order", () => {
    expect(toJsonLines([recordAt(1), recordAt(2)])).toBe(
      `{"at":"${AT}","severity":"error","source":"console/test","kind":"sample","detail":"record 1"}\n` +
        `{"at":"${AT}","severity":"error","source":"console/test","kind":"sample","detail":"record 2"}`,
    );
  });

  it("truncates an over-long detail with a suffix rather than dropping the record", () => {
    const overlong = "y".repeat(DIAGNOSTIC_CAPTURE_BOUNDS.detailCharacterCount + 500);
    const line = toJsonLines([{ ...recordAt(1), detail: overlong }]);
    const parsed = JSON.parse(line) as { detail: string };
    expect(parsed.detail.length).toBe(DIAGNOSTIC_CAPTURE_BOUNDS.detailCharacterCount);
    expect(parsed.detail.endsWith("…")).toBe(true);
  });
});

describe("batching and the pending bound", () => {
  it("forwards a full batch as soon as one is full", () => {
    const capture = new DiagnosticCapture();
    const batches: string[] = [];
    capture.installForwarder((jsonLines) => batches.push(jsonLines));
    for (let index = 0; index < DIAGNOSTIC_CAPTURE_BOUNDS.batchRecordCount; index += 1) {
      capture.record(recordAt(index));
    }
    expect(batches).toHaveLength(1);
    expect(batches[0]?.split("\n")).toHaveLength(DIAGNOSTIC_CAPTURE_BOUNDS.batchRecordCount);
    expect(capture.pendingRecordCount).toBe(0);
    expect(capture.forwardedRecordCount).toBe(DIAGNOSTIC_CAPTURE_BOUNDS.batchRecordCount);
  });

  it("drops the oldest past the pending bound and counts what it dropped", () => {
    const capture = new DiagnosticCapture();
    const overflow = DIAGNOSTIC_CAPTURE_BOUNDS.pendingRecordCount + 10;
    for (let index = 0; index < overflow; index += 1) {
      capture.record(recordAt(index));
    }
    expect(capture.pendingRecordCount).toBe(DIAGNOSTIC_CAPTURE_BOUNDS.pendingRecordCount);
    // Ten dropped by the bound, plus the one the blind marker added on the first
    // failed flush — the marker is a record and is bounded like every other one.
    expect(capture.droppedRecordCount).toBeGreaterThanOrEqual(10);
  });
});

describe("the I-am-blind marker", () => {
  it("marks the forward seam blind when nothing is installed, and keeps the records", () => {
    const capture = new DiagnosticCapture();
    capture.record(recordAt(1));
    capture.flush();
    expect(capture.isBlind(DIAGNOSTIC_BAND_FORWARD_PROBE)).toBe(true);
    expect(capture.blindProbes()[0]?.reason).toContain("no diagnostic forwarder");
    // The records are still here: blindness is reported, not paid for by loss.
    expect(capture.pendingRecordCount).toBeGreaterThan(0);
  });

  it("clears the seam's blindness and drains what accumulated when one is installed", () => {
    const capture = new DiagnosticCapture();
    capture.record(recordAt(1));
    capture.flush();
    const batches: string[] = [];
    capture.installForwarder((jsonLines) => batches.push(jsonLines));
    expect(capture.isBlind(DIAGNOSTIC_BAND_FORWARD_PROBE)).toBe(false);
    expect(capture.pendingRecordCount).toBe(0);
    // Both the sample and the blind marker it produced reach the band.
    expect(batches[0]).toContain("probe-unsupported");
    expect(batches[0]).toContain("record 1");
  });

  it("marks a probe once however many times it is reported", () => {
    const capture = new DiagnosticCapture();
    capture.markBlind("frame-timing", "no performance observer", AT);
    capture.markBlind("frame-timing", "no performance observer", AT);
    expect(capture.blindProbes()).toHaveLength(1);
    expect(capture.blindProbes()[0]?.since).toBe(AT);
  });

  it("holds at most the blind-probe bound, and counts what it refuses past it", () => {
    const capture = new DiagnosticCapture();
    // A forwarder from the start, so the auto-flush at the batch bound does not spend a
    // slot marking the forward seam blind — that would make the arithmetic below about
    // this test's own scaffolding rather than about the refusal.
    const batches: string[] = [];
    capture.installForwarder((jsonLines) => {
      batches.push(jsonLines);
    });
    const refusedProbeCount = 5;
    for (
      let index = 0;
      index < DIAGNOSTIC_CAPTURE_BOUNDS.blindProbeCount + refusedProbeCount;
      index += 1
    ) {
      capture.markBlind(`probe-${index}`, "unsupported", AT);
    }
    capture.flush();

    expect(capture.blindProbes()).toHaveLength(DIAGNOSTIC_CAPTURE_BOUNDS.blindProbeCount);
    expect(capture.refusedBlindProbeCount).toBe(refusedProbeCount);
    // ONE record, on the first refusal. The set being full is one fact about the
    // console, and restating it per refused probe would spend the pending buffer the
    // capture keeps for the failures it can still carry.
    const refusalRecords = batches
      .join("\n")
      .split("\n")
      .map((line) => JSON.parse(line) as DiagnosticRecord)
      .filter((record) => record.kind === "probe-blind-set-full");
    expect(refusalRecords).toHaveLength(1);
    expect(refusalRecords[0]?.severity).toBe("warning");
    expect(refusalRecords[0]?.detail).toContain(
      `probe-${DIAGNOSTIC_CAPTURE_BOUNDS.blindProbeCount}`,
    );
  });

  it("a throwing forwarder loses no record and becomes a blind seam", () => {
    const capture = new DiagnosticCapture();
    capture.installForwarder(() => {
      throw new Error("band unreachable");
    });
    capture.record(recordAt(1));
    capture.flush();
    expect(capture.pendingRecordCount).toBeGreaterThan(0);
    expect(capture.forwardedRecordCount).toBe(0);
    expect(capture.blindProbes()[0]?.reason).toBe("band unreachable");
  });
});

describe("the tripwire route", () => {
  it("carries a report into the capture with the severity its kind maps to", () => {
    const registry = new TripwireRegistry();
    const capture = new DiagnosticCapture();
    const batches: string[] = [];
    capture.installForwarder((jsonLines) => batches.push(jsonLines));
    const detach = routeTripwiresToDiagnosticCapture(registry, capture, () => AT);

    registry.report({
      kind: "apply-chokepoint-bypass",
      site: "store/session-store.ts",
      detail: "items assigned outside apply",
    });
    registry.report({
      kind: "cleanup-refused",
      site: "repos/attachments",
      detail: "daemon refused the release",
    });
    capture.flush();

    const lines = batches
      .join("\n")
      .split("\n")
      .map((line) => JSON.parse(line) as DiagnosticRecord);
    expect(lines).toHaveLength(2);
    expect(lines[0]?.severity).toBe("error");
    expect(lines[0]?.kind).toBe("apply-chokepoint-bypass");
    expect(lines[0]?.detail).toBe("store/session-store.ts: items assigned outside apply");
    // The one kind that is the daemon answering honestly rather than a broken console
    // invariant reaches the band as a warning.
    expect(lines[1]?.severity).toBe("warning");

    detach();
    registry.report({ kind: "bridge-shape-drift", site: "bridge", detail: "drifted" });
    capture.flush();
    expect(capture.forwardedRecordCount).toBe(2);
  });
});
