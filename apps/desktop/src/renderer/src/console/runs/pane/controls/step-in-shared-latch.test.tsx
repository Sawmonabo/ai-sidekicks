// The button and the palette row are one pause, admitted once.
//
// `Spec-023 §Console Design (Meridian)` requires every operator action to be
// palette-reachable, which gives `run.pause` two entry points on one run: the Step in
// button in the control strip, and the `runs.pause.<runId>` row the pane contributes.
// Two entry points are fine; two LATCHES are not. Each would admit while the other was
// settling, minting two idempotency keys against one run version — which the wire reads
// as two distinct mutations rather than replays of one, so they race to apply and the
// loser's stale-version refusal becomes the visible settlement.
//
// So both cases below press one entry point, dispatch the other while the first is
// parked, and count what reached the wire. The dispatcher, the surface and the latch
// are all real: a stub of any of them would be a stub of the claim.

import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { createFixtureBridge } from "../../../bridge/index.js";
import { settle } from "../../../core/settle.test-support.js";
import {
  withDaemonCall,
  type RecordedDaemonCall,
} from "../../../bridge/fixture/call-plane/bridge.test-support.js";
import { quietShell } from "../../../store/shell-condition.test-support.js";
import { capabilityReadout } from "./driver-capability-readout.test-support.js";
import { dispatchRunControlCommand } from "./run-control-commands.js";
import { runProjection } from "./run-control-commands.test-support.js";
import { type RunControlSurface } from "./run-control-surface.js";
import {
  ACKNOWLEDGED_PAUSE,
  EXPECTED_RUN_VERSION,
  StepInHost,
  TARGET_RUN_ID,
  scenarioReplying,
  stepInTrigger,
} from "./step-in.test-support.js";

/** Neither gated control is declared; pause is orchestration-layer and never gated. */
const CAPABLE = capabilityReadout([["claude", []]], [[TARGET_RUN_ID, "claude"]]);

/** The palette's own row for this run's pause, dispatched against a live surface. */
function pressThePaletteRow(surface: RunControlSurface): void {
  dispatchRunControlCommand(
    { runId: TARGET_RUN_ID, control: "pause", title: "Pause the run" },
    {
      runs: [runProjection(TARGET_RUN_ID)],
      driverCapabilities: CAPABLE,
      // Silence: this claim is about one latch over two entry points, not the shell.
      frameStore: quietShell(),
      surface,
      onRequestSteer: () => undefined,
      onRequestRewind: () => undefined,
      // A described run seats a row, so the pane's empty state — and the start act it
      // carries — is not offered here. This suite is about the pause latch alone.
      startOffer: { seatedRunCount: 1, hasRead: true, openRefusal: undefined },
      onRequestComposerFocus: () => undefined,
    },
  );
}

/**
 * The control mounted over a bridge whose `run.pause` parks until this suite answers.
 *
 * The surface is handed back as an ACCESSOR and not as a value. `useRunControlSurface`
 * memoises a fresh object each time its in-flight set or its records move, so a
 * snapshot taken at mount reports an empty in-flight set forever — which is a reading
 * of the mount rather than of the pane, and it is exactly what made the settle below
 * return before the parked call had settled at all.
 */
function mountOverParkedPause(): {
  readonly trigger: HTMLButtonElement;
  readonly liveSurface: () => RunControlSurface;
  readonly calls: readonly RecordedDaemonCall[];
  readonly answerPause: () => void;
} {
  let release: (() => void) | undefined;
  const parked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { bridge, calls } = withDaemonCall(
    createFixtureBridge({ scenario: scenarioReplying([ACKNOWLEDGED_PAUSE]) }),
    async (call, forward) => {
      if (call.method !== "run.pause") {
        return forward();
      }
      await parked;
      return forward();
    },
  );
  const surfaceSeen: { current: RunControlSurface | undefined } = { current: undefined };
  const { container } = render(
    <StepInHost bridge={bridge} onTakeTheFloor={vi.fn()} surfaceSeen={surfaceSeen} />,
  );
  return {
    trigger: stepInTrigger(container),
    liveSurface: (): RunControlSurface => {
      const surface = surfaceSeen.current;
      if (surface === undefined) {
        throw new Error("the host published no surface");
      }
      return surface;
    },
    calls,
    answerPause: (): void => {
      release?.();
    },
  };
}

function pauseCalls(calls: readonly RecordedDaemonCall[]): readonly RecordedDaemonCall[] {
  return calls.filter((call) => call.method === "run.pause");
}

describe("one pause per run, whichever entry point asked for it", () => {
  it("refuses the palette row while the Step in button's pause is in flight", () => {
    const { trigger, liveSurface, calls } = mountOverParkedPause();

    fireEvent.click(trigger);
    pressThePaletteRow(liveSurface());

    // One request on the wire, and it carries the guard the button threaded. A
    // second would have minted its own idempotency key against this same version.
    expect(pauseCalls(calls)).toHaveLength(1);
    expect(pauseCalls(calls)[0]?.params).toMatchObject({
      expectedRunVersion: EXPECTED_RUN_VERSION,
    });
  });

  it("refuses the Step in button while the palette row's pause is in flight", () => {
    // The other order, and the one a hand-rolled latch on the button could never
    // see: the button's own claim knows nothing about a dispatch the surface made,
    // so it admitted every press that arrived while the palette's request was going.
    const { trigger, liveSurface, calls } = mountOverParkedPause();

    pressThePaletteRow(liveSurface());
    fireEvent.click(trigger);

    expect(pauseCalls(calls)).toHaveLength(1);
  });

  it("negative control: the second entry point DOES dispatch once the first settles", async () => {
    // Without this both cases above would pass over a control that dispatched
    // nothing at all, or over a latch that never released — which is the failure
    // that leaves a run un-pausable for the rest of the window.
    const { trigger, liveSurface, calls, answerPause } = mountOverParkedPause();

    fireEvent.click(trigger);
    answerPause();
    await settle();
    expect(liveSurface().inFlightKeys.size).toBe(0);
    pressThePaletteRow(liveSurface());

    expect(pauseCalls(calls)).toHaveLength(2);
  });
});
