// The sessions track opening and closing, measured in Chromium, since happy-dom runs no
// transitions. A closing track keeps its content until the grid has stopped moving, then drops
// it; under reduced motion it drops it at once. The grid moves only while the track opens or
// closes, so a text-size change resizes the tracks with no transition running. The content held
// mid-close and the transition a close starts are each the other case's negative control.

import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { applyAppearance, installMeridianTokens } from "#renderer/app/token-installation.js";
import { AppFrame } from "#renderer/layout/AppShell/AppFrame.js";
import { DEFAULT_APPEARANCE_RECORD, TEXT_SIZES } from "#shared/appearance.js";
import { SESSIONS_ROUTE, frameProps, liveBridgeWrapper } from "../helpers/app/frame-fixtures.js";
import { clearMediaEmulation, emulateReducedMotion } from "../helpers/media-emulation.js";

const LARGEST_TEXT_SIZE = TEXT_SIZES.reduce((largest, size) => (size > largest ? size : largest));

/** The frame mounted with `sessionsTrack`, and a way to hand it another. */
interface MountedFrame {
  readonly frame: HTMLElement;
  readonly setSessionsTrack: (sessionsTrack: React.ReactNode | undefined) => void;
}

/**
 * Mounts the frame and lets it paint once, as a window does before anyone opens or closes its
 * track: a box with no style yet has nothing for a transition to start from.
 */
async function mountFrame(sessionsTrack: React.ReactNode | undefined): Promise<MountedFrame> {
  installMeridianTokens(document);
  const BridgeHost = liveBridgeWrapper();
  const frameWith = (track: React.ReactNode | undefined): React.JSX.Element => (
    <BridgeHost>
      <AppFrame
        {...frameProps(SESSIONS_ROUTE)}
        {...(track === undefined ? {} : { sessionsTrack: track })}
      >
        <p>the screen</p>
      </AppFrame>
    </BridgeHost>
  );
  const { container, rerender } = render(frameWith(sessionsTrack));
  const frame = container.querySelector<HTMLElement>(".meridian-frame");
  if (frame === null) {
    throw new Error("the frame rendered no grid");
  }
  // A frame callback runs before that frame's style pass, so the second one follows a paint.
  await nextFrame();
  await nextFrame();
  return {
    frame,
    setSessionsTrack: (track) => {
      act(() => {
        rerender(frameWith(track));
      });
    },
  };
}

async function nextFrame(): Promise<void> {
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => {
      resolve();
    });
  });
}

/** The transitions the frame's own grid is running. */
function gridTransitions(frame: HTMLElement): Animation[] {
  return frame
    .getAnimations()
    .filter(
      (animation) =>
        animation instanceof CSSTransition &&
        animation.transitionProperty === "grid-template-columns",
    );
}

function sessionsTrackOf(frame: HTMLElement): HTMLElement | null {
  return frame.querySelector<HTMLElement>(".meridian-frame__sessions-track");
}

function boxOf(frame: HTMLElement, selector: string): DOMRect {
  const element = frame.querySelector(selector);
  if (element === null) {
    throw new Error(`the frame rendered no ${selector}`);
  }
  return element.getBoundingClientRect();
}

afterEach(async () => {
  cleanup();
  applyAppearance(document, DEFAULT_APPEARANCE_RECORD);
  await clearMediaEmulation();
});

describe("the sessions track", () => {
  it("keeps its content while it closes, inert, and drops it once the grid stops", async () => {
    const { frame, setSessionsTrack } = await mountFrame(<p>the sessions list</p>);

    setSessionsTrack(undefined);

    const closing = sessionsTrackOf(frame);
    expect(closing?.textContent).toBe("the sessions list");
    expect(closing?.inert).toBe(true);
    expect(gridTransitions(frame)).toHaveLength(1);

    // `waitFor` lets React flush the `transitionend` settle as it lands, inside its own act.
    await waitFor(() => {
      expect(sessionsTrackOf(frame)).toBeNull();
    });
    expect(gridTransitions(frame)).toStrictEqual([]);
    expect(boxOf(frame, ".meridian-frame__column").left).toBe(boxOf(frame, ".meridian-rail").right);
  });

  it("stays open with its new content when it reopens before it has closed", async () => {
    const { frame, setSessionsTrack } = await mountFrame(<p>the sessions list</p>);

    setSessionsTrack(undefined);
    setSessionsTrack(<p>the sessions list, again</p>);

    // Opening again at once with the new content, not closing first and opening after.
    expect(sessionsTrackOf(frame)?.inert).toBe(false);
    expect(sessionsTrackOf(frame)?.textContent).toBe("the sessions list, again");
    await waitFor(() => {
      expect(gridTransitions(frame)).toStrictEqual([]);
    });
    const track = sessionsTrackOf(frame);
    expect(track?.textContent).toBe("the sessions list, again");
    expect(track?.inert).toBe(false);
    expect(boxOf(frame, ".meridian-frame__column").left).toBeGreaterThan(
      boxOf(frame, ".meridian-rail").right,
    );
  });

  it("drops its content at once where reduced motion is asked for", async () => {
    await emulateReducedMotion();
    const { frame, setSessionsTrack } = await mountFrame(<p>the sessions list</p>);

    setSessionsTrack(undefined);

    expect(sessionsTrackOf(frame)).toBeNull();
  });

  it("resizes its tracks with no transition when the text size changes", async () => {
    const { frame, setSessionsTrack } = await mountFrame(<p>the sessions list</p>);
    const columnLeftBefore = boxOf(frame, ".meridian-frame__column").left;

    act(() => {
      applyAppearance(document, { ...DEFAULT_APPEARANCE_RECORD, textSize: LARGEST_TEXT_SIZE });
    });

    // The rail and the track are root-relative, so the column moves over by their growth.
    const growth = LARGEST_TEXT_SIZE / DEFAULT_APPEARANCE_RECORD.textSize;
    expect(boxOf(frame, ".meridian-frame__column").left).toBeCloseTo(columnLeftBefore * growth, 0);
    expect(gridTransitions(frame)).toStrictEqual([]);

    // Negative control: closing the track does run the grid's transition.
    setSessionsTrack(undefined);
    expect(gridTransitions(frame)).toHaveLength(1);
  });
});
