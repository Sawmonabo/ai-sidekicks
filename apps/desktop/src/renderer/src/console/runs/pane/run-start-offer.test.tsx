// One offer reading, and the two surfaces that must agree about it.
//
// `Spec-023 §Console Design (Meridian)` requires every operator action to be
// palette-reachable, and the empty state's "Write a message" is an operator action.
// What that costs is a second surface asking the same question — so the question is
// asked once here, and the case below drives BOTH readers over one reading and
// compares what each of them offers.
//
// The comparison is the point rather than the two halves separately: a suite that
// checked the button on one reading and the palette row on another would pass over
// exactly the drift this predicate exists to prevent.

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { refuse } from "../../core/index.js";
import { consoleCommands } from "../../palette/index.js";
import { type FrameStore } from "../../store/index.js";
import { quietShell } from "../../store/shell-condition.test-support.js";
import { NoRuns } from "./NoRuns.js";
import { RUN_START_COMMAND_ID, useRunControlCommands } from "./controls/run-control-commands.js";
import { recordingRunControlSurface } from "./controls/run-control-commands.test-support.js";
import { offersRunStart, type RunStartOfferReading } from "./run-start-offer.js";

const STREAM_REFUSED = refuse("runs-state", "session.not_found", "That session is not here.");

/**
 * One surface for the whole file, because no case here dispatches through it.
 *
 * The host contributes no run rows — `runs` is empty in every case — so the surface
 * is the hook's required collaborator and nothing more. Built once rather than per
 * render, which is also what keeps the contribution's own ref from churning.
 */
const { surface: IDLE_SURFACE } = recordingRunControlSurface();

function reading(overrides: Partial<RunStartOfferReading> = {}): RunStartOfferReading {
  return { seatedRunCount: 0, hasRead: true, openRefusal: undefined, ...overrides };
}

/**
 * The pane's two readers of one reading: the empty state and the contribution.
 *
 * Composed here rather than mounted through the whole pane because the claim is about
 * the READING and not about the stream that produced it — the pane's own suite covers
 * the wiring, and driving a live subscription to reach four absence states would put
 * three unrelated failure modes between this assertion and what it asserts.
 */
function RunStartHost(props: {
  readonly reading: RunStartOfferReading;
  readonly onRequestComposerFocus: () => void;
  readonly frameStore: FrameStore;
}): React.JSX.Element {
  useRunControlCommands({
    runs: [],
    driverCapabilities: undefined,
    // Silence, which closes nothing: these cases are about the empty state's offer.
    frameStore: props.frameStore,
    surface: IDLE_SURFACE,
    onRequestSteer: () => undefined,
    onRequestRewind: () => undefined,
    startOffer: props.reading,
    onRequestComposerFocus: props.onRequestComposerFocus,
  });
  return <NoRuns reading={props.reading} onStart={props.onRequestComposerFocus} />;
}

describe("the offer reading itself", () => {
  it("offers the act on an empty, read, unrefused pane", () => {
    expect(offersRunStart(reading())).toBe(true);
  });

  it.each([
    ["a read that has not landed", reading({ hasRead: false })],
    ["a stream that never opened", reading({ openRefusal: STREAM_REFUSED })],
    ["a pane that seated a row", reading({ seatedRunCount: 1 })],
  ])("withholds it for %s", (_case, withheld) => {
    expect(offersRunStart(withheld)).toBe(false);
  });
});

describe("the button and the palette row are offered together", () => {
  it.each([
    ["an empty, read, unrefused pane", reading(), true],
    ["a read that has not landed", reading({ hasRead: false }), false],
    ["a stream that never opened", reading({ openRefusal: STREAM_REFUSED }), false],
    ["a pane that seated a row", reading({ seatedRunCount: 1 }), false],
  ])("offers both on %s", (_case, offered, isOffered) => {
    render(
      <RunStartHost frameStore={quietShell()} reading={offered} onRequestComposerFocus={vi.fn()} />,
    );

    const button = screen.queryByRole("button", { name: "Write a message" });
    expect(button === null).toBe(!isOffered);
    expect(consoleCommands.get(RUN_START_COMMAND_ID) === undefined).toBe(!isOffered);
  });

  it("carries the button's own words into the palette rather than a second name", () => {
    render(
      <RunStartHost
        frameStore={quietShell()}
        reading={reading()}
        onRequestComposerFocus={vi.fn()}
      />,
    );

    expect(consoleCommands.get(RUN_START_COMMAND_ID)?.title).toBe(
      screen.getByRole("button", { name: "Write a message" }).textContent,
    );
  });

  it("performs the same act the button performs", () => {
    const onRequestComposerFocus = vi.fn();
    render(
      <RunStartHost
        frameStore={quietShell()}
        reading={reading()}
        onRequestComposerFocus={onRequestComposerFocus}
      />,
    );

    consoleCommands.get(RUN_START_COMMAND_ID)?.run();

    expect(onRequestComposerFocus).toHaveBeenCalledTimes(1);
  });

  it("negative control: the row is gone once a run is seated, and asks for nothing", () => {
    // Without this the cases above would pass over a contribution that registered the
    // row unconditionally — and over one that registered it correctly while still
    // acting on a pane whose empty state had already gone.
    const onRequestComposerFocus = vi.fn();
    render(
      <RunStartHost
        frameStore={quietShell()}
        reading={reading({ seatedRunCount: 1 })}
        onRequestComposerFocus={onRequestComposerFocus}
      />,
    );

    expect(consoleCommands.get(RUN_START_COMMAND_ID)).toBeUndefined();
    expect(onRequestComposerFocus).not.toHaveBeenCalled();
  });
});
