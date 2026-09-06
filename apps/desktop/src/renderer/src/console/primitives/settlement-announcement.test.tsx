// Once per distinct sentence, in the polite lane, and never for a state that has not
// settled.
//
// The cases that matter are the two silences. A surface that re-announced on every
// render would fill the queue with one sentence and shed everything behind it; a
// surface that announced its `not-loaded` arm would tell a person a read had landed
// before it had. Both are inaudible on screen, so both are asserted here against the
// real announcer rather than against a spy — what a reader would hear is the region's
// text, and that is what these cases read.

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { LIVE_ANNOUNCEMENT_HOLD_MS, ManualClock } from "../core/index.js";
import { LiveAnnouncer } from "./live-announcer.js";
import { liveRegionText, politeText } from "./live-region.test-support.js";
import { LiveAnnouncerProvider } from "./LiveAnnouncerProvider.js";
import { useSettlementAnnouncement } from "./settlement-announcement.js";

afterEach(() => {
  cleanup();
});

/** A surface whose whole job is to hand one sentence to the hook. */
function SettlingSurface(props: { readonly sentence: string | undefined }): React.JSX.Element {
  useSettlementAnnouncement(props.sentence);
  return <p>a surface</p>;
}

/**
 * Mount the surface over an announcer this test drives.
 *
 * The announcer is supplied rather than built by the provider so the hold window is
 * on frozen time: a message clears on a real timer otherwise, and "was it said again"
 * becomes a question about how fast the runner happened to be.
 */
function mount(sentence: string | undefined): {
  readonly container: HTMLElement;
  readonly clock: ManualClock;
  readonly rerender: (next: string | undefined) => void;
} {
  const clock = new ManualClock();
  const announcer = new LiveAnnouncer({ clock });
  const view = render(
    <LiveAnnouncerProvider announcer={announcer}>
      <SettlingSurface sentence={sentence} />
    </LiveAnnouncerProvider>,
  );
  return {
    container: view.container,
    clock,
    rerender: (next) => {
      act(() => {
        view.rerender(
          <LiveAnnouncerProvider announcer={announcer}>
            <SettlingSurface sentence={next} />
          </LiveAnnouncerProvider>,
        );
      });
    },
  };
}

describe("settlement announcement — what is said", () => {
  it("speaks the settled sentence in the polite region", () => {
    const { container } = mount("Four mounts were read.");
    expect(politeText(container)).toBe("Four mounts were read.");
  });

  it("leaves the assertive region silent, because a settled read interrupts nobody", () => {
    const { container } = mount("Four mounts were read.");
    expect(liveRegionText(container, "assertive")).toBe("");
  });

  it("says nothing at all while the read has not settled", () => {
    const { container } = mount(undefined);
    expect(politeText(container)).toBe("");
  });

  it("speaks a genuinely different settlement when the reading changes", () => {
    const { container, clock, rerender } = mount("Four mounts were read.");
    act(() => {
      clock.advance(LIVE_ANNOUNCEMENT_HOLD_MS);
    });
    expect(politeText(container)).toBe("");

    rerender("That read was refused.");

    expect(politeText(container)).toBe("That read was refused.");
  });
});

describe("settlement announcement — what is not said twice", () => {
  it("negative control: a re-render carrying the same sentence says nothing again", () => {
    // Without this, a hook that announced on every pass would satisfy every case
    // above while filling the polite queue with one sentence — which sheds every
    // other announcement in the window behind it.
    const { container, clock, rerender } = mount("Four mounts were read.");
    act(() => {
      clock.advance(LIVE_ANNOUNCEMENT_HOLD_MS);
    });
    expect(politeText(container)).toBe("");

    rerender("Four mounts were read.");

    expect(politeText(container)).toBe("");
  });

  it("negative control: a reading that returns to not-settled does not clear or repeat", () => {
    // `undefined` means "nothing has settled", which is not the same as "say the
    // empty string" — the announcer publishes an empty string to CLEAR a region, and
    // a surface that passed one through would silence whatever was standing.
    const { container, rerender } = mount("Four mounts were read.");
    rerender(undefined);
    expect(politeText(container)).toBe("Four mounts were read.");
  });
});
