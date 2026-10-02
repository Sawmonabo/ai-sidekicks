// What a holder does to the value a different key supersedes, and what a render-body lookup may
// not do. The keys are bare objects: the holder compares identity and reads nothing off them.

import { describe, expect, it } from "vitest";

import { KeyBoundHolder, type KeyBoundValue } from "./key-bound-holder.js";

/**
 * A value that records what the holder did to it. It counts disposals, which no real store
 * exposes; the cases that drive real behavior use the real stores.
 */
class RecordingValue implements KeyBoundValue {
  public disposeCount = 0;

  public dispose(): void {
    this.disposeCount += 1;
  }
}

describe("the holder that keys a value on an object's identity", () => {
  it("disposes the value a different key supersedes, exactly once", () => {
    const holder = new KeyBoundHolder(() => new RecordingValue());
    const first = holder.acquire({});
    const replacement = {};
    const second = holder.acquire(replacement);
    holder.acquire(replacement);

    expect(first.disposeCount).toBe(1);
    expect(second).not.toBe(first);
    expect(second.disposeCount).toBe(0);
  });

  it("negative control: a render-body lookup mints and disposes nothing", () => {
    // Without this, the disposal above could pass over a holder whose lookup also acquired,
    // letting a discarded render dispose the committed tree's value.
    const key = {};
    const holder = new KeyBoundHolder(() => new RecordingValue());
    expect(holder.valueIfCurrent(key)).toBeUndefined();
    const acquired = holder.acquire(key);
    expect(holder.valueIfCurrent({})).toBeUndefined();
    expect(acquired.disposeCount).toBe(0);
  });
});
