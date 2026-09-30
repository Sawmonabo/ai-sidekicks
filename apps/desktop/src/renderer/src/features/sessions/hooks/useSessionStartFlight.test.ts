// How many sessions a burst of Start presses may create, and when the control returns. A
// second press while the first create is in flight remounts the component that puts the
// create, and its cleanup suppresses the result. Every assertion is about what `admit`
// answers: each admitted press is a `session.create` on the wire.

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { useSessionStartFlight } from "./useSessionStartFlight.js";

/** The subject the key is held on: one stable identity, as the bridge is in a window. */
const BRIDGE = {};

describe("starting a session — one create at a time", () => {
  it("admits one press of two while the first create is still running", () => {
    const { result } = renderHook(() => useSessionStartFlight(BRIDGE, true));

    const admitted: boolean[] = [];
    act(() => {
      admitted.push(result.current.admit());
    });
    act(() => {
      admitted.push(result.current.admit());
    });

    expect(admitted).toStrictEqual([true, false]);
  });

  it("admits one press of a burst inside a single frame", () => {
    // Every press happens before React re-renders, so a rendered flag would read idle each
    // time; the key taken inside the tick is what refuses the second and third.
    const { result } = renderHook(() => useSessionStartFlight(BRIDGE, true));

    const admitted: boolean[] = [];
    act(() => {
      admitted.push(result.current.admit(), result.current.admit(), result.current.admit());
    });

    expect(admitted).toStrictEqual([true, false, false]);
  });

  it("reports the create as outstanding while it runs, so the control can say why", () => {
    const { result } = renderHook(() => useSessionStartFlight(BRIDGE, true));
    expect(result.current.isOutstanding).toBe(false);

    act(() => {
      result.current.admit();
    });

    expect(result.current.isOutstanding).toBe(true);
  });

  it("gives the key back when the create settles, made a session or refused", () => {
    // A settlement reported on the created arm alone would leave Start dead after one refusal.
    const { result } = renderHook(() => useSessionStartFlight(BRIDGE, true));
    act(() => {
      result.current.admit();
    });

    act(() => {
      result.current.settle();
    });

    expect(result.current.isOutstanding).toBe(false);
    let admittedAgain = false;
    act(() => {
      admittedAgain = result.current.admit();
    });
    expect(admittedAgain).toBe(true);
  });

  it("holds nothing where the mount puts no call at all", () => {
    // No settlement would ever return a key taken for a call never made.
    const { result } = renderHook(() => useSessionStartFlight(BRIDGE, false));

    const admitted: boolean[] = [];
    act(() => {
      admitted.push(result.current.admit());
    });
    act(() => {
      admitted.push(result.current.admit());
    });

    expect(admitted).toStrictEqual([true, true]);
    expect(result.current.isOutstanding).toBe(false);
  });
});
