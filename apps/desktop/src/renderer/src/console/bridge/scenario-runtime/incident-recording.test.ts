// The recorder, driven on the four ways a frame does not reach a recording.
//
// Each arm is a real gap a replay would otherwise inherit silently — which is why the
// recorder answers with an outcome instead of throwing, and why every one of them is
// asserted here rather than trusted to a comment.

import { describe, expect, it } from "vitest";

import { IncidentRecorder } from "./incident-recording.js";

/** A declaration with a bound big enough that only the arm under test refuses. */
function recorderHolding(frameBound: number): IncidentRecorder {
  return new IncidentRecorder({
    incidentId: "recorder-under-test",
    summary: "A recorder standing in for one on a delivery path.",
    recordedAtIso: "2026-01-14T11:20:00.000Z",
    frameBound,
  });
}

describe("the incident recorder writes down what it is handed", () => {
  it("holds the delivered frame's text and the tick it arrived at", () => {
    const recorder = recorderHolding(8);

    expect(recorder.record(0, { type: "session.created", sequence: 1 })).toBe("recorded");
    expect(recorder.record(400, { type: "assistant.message", sequence: 2 })).toBe("recorded");

    expect(recorder.recording().deltas).toStrictEqual([
      { atMs: 0, frameJson: '{"type":"session.created","sequence":1}' },
      { atMs: 400, frameJson: '{"type":"assistant.message","sequence":2}' },
    ]);
    expect(recorder.recordedFrameCount).toBe(2);
    expect(recorder.refusedFrameCount).toBe(0);
  });

  it("carries the declaration onto the recording it writes", () => {
    const recorder = recorderHolding(1);

    const recording = recorder.recording();

    expect(recording.incidentId).toBe("recorder-under-test");
    expect(recording.recordedAtIso).toBe("2026-01-14T11:20:00.000Z");
    expect(recording.summary).toContain("delivery path");
  });

  it("answers with a snapshot a later frame cannot reach", () => {
    const recorder = recorderHolding(4);
    recorder.record(0, { sequence: 1 });

    const takenEarly = recorder.recording();
    recorder.record(400, { sequence: 2 });

    expect(takenEarly.deltas).toHaveLength(1);
    expect(recorder.recording().deltas).toHaveLength(2);
  });
});

describe("the four ways a frame does not reach a recording", () => {
  it("refuses a value with no JSON text, and counts it", () => {
    const recorder = recorderHolding(4);
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;

    expect(recorder.record(0, cyclic)).toBe("unserializable");
    expect(recorder.record(0, undefined)).toBe("unserializable");

    expect(recorder.recordedFrameCount).toBe(0);
    expect(recorder.refusedFrameCount).toBe(2);
  });

  it("refuses a tick earlier than the frame in front of it", () => {
    const recorder = recorderHolding(4);
    recorder.record(400, { sequence: 1 });

    expect(recorder.record(200, { sequence: 2 })).toBe("out-of-order");
    expect(recorder.recording().deltas).toHaveLength(1);
  });

  it("admits two frames at one tick, which is an ordinary burst", () => {
    const recorder = recorderHolding(4);

    expect(recorder.record(400, { sequence: 1 })).toBe("recorded");
    expect(recorder.record(400, { sequence: 2 })).toBe("recorded");
  });

  it("refuses past the bound its caller declared", () => {
    const recorder = recorderHolding(2);
    recorder.record(0, { sequence: 1 });
    recorder.record(400, { sequence: 2 });

    expect(recorder.record(800, { sequence: 3 })).toBe("over-bound");
    expect(recorder.recordedFrameCount).toBe(2);
    expect(recorder.refusedFrameCount).toBe(1);
  });

  it("refuses to exist at all with a bound that names no number of frames", () => {
    expect(() => recorderHolding(0)).toThrow(RangeError);
    expect(() => recorderHolding(2.5)).toThrow(RangeError);
    expect(() => recorderHolding(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });

  it("negative control: a bound of one admits exactly one frame", () => {
    const recorder = recorderHolding(1);

    expect(recorder.record(0, { sequence: 1 })).toBe("recorded");
    expect(recorder.record(400, { sequence: 2 })).toBe("over-bound");
  });
});
