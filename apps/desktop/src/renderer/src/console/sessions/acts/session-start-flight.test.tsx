// How many sessions a burst of Start presses may create, and when the control returns.
//
// THE DEFECT, AND WHY IT COST TWO SESSIONS AND GAVE ONE. A second press while the
// first create was still in flight remounted the surface that puts the create, its
// cleanup suppressed the result, and the session that create went on to produce was
// named to nobody while a SECOND durable session was created beside it.
//
// DRIVEN THROUGH THE HOOK a start control calls, and every assertion is about what
// `admit` answers: a press the hook admits is a `session.create` on the wire, so the
// count of admitted presses is the count of sessions a burst can create.

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { useSessionStartFlight } from "./session-start-flight.js";

/** The subject the slot is keyed on: one stable identity, as the bridge is in a window. */
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
    // Every press here happens before React re-renders, so each handler would read
    // the rendered flag from the render that produced it and find the control idle;
    // the key taken inside the tick is what refuses the second and third.
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

  it("gives the slot back when the create settles, made a session or refused", () => {
    // A settlement reported on the created arm alone would leave Start dead for the
    // life of the mount after a single refusal, so the hook has one release for both.
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
    // No settlement will ever arrive to give a slot back, so a slot taken anyway
    // would kill the control on its first press for a call never made.
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
