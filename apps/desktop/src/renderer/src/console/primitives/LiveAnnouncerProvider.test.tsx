// What the mount has to be true of, as opposed to what the announcer computes.
//
// `live-announcer.test.ts` owns the queue, the coalescing, and the clock. These
// cases own the four things only the React mount can be wrong about: the regions
// exist before anything is announced, there are exactly two of them, a surface
// outside the provider is told rather than silently ignored, and the announcer the
// provider BUILT is the only one it disposes.

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ManualClock } from "../core/index.js";
import { LiveAnnouncer } from "./live-announcer.js";
import { LiveAnnouncerProvider, useAnnounce } from "./LiveAnnouncerProvider.js";

afterEach(() => {
  cleanup();
});

function regionsOf(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>("[data-live-region]")];
}

/** A surface that announces once on demand, so the hook is exercised for real. */
function AnnouncingSurface(props: {
  readonly onReady: (announce: ReturnType<typeof useAnnounce>) => void;
}): React.JSX.Element {
  const announce = useAnnounce();
  props.onReady(announce);
  return <p>a surface</p>;
}

function SurfaceWithoutProvider(): React.JSX.Element {
  useAnnounce();
  return <p>never rendered</p>;
}

describe("LiveAnnouncerProvider — the regions exist before anything is said", () => {
  it("renders exactly two empty regions, one per politeness, from the first paint", () => {
    const { container } = render(
      <LiveAnnouncerProvider>
        <p>a surface</p>
      </LiveAnnouncerProvider>,
    );

    const regions = regionsOf(container);
    expect(regions).toHaveLength(2);

    const [polite, assertive] = regions;
    expect(polite?.getAttribute("data-live-region")).toBe("polite");
    expect(polite?.getAttribute("role")).toBe("status");
    expect(polite?.getAttribute("aria-live")).toBe("polite");
    expect(polite?.getAttribute("aria-atomic")).toBe("true");
    expect(polite?.textContent).toBe("");

    expect(assertive?.getAttribute("data-live-region")).toBe("assertive");
    expect(assertive?.getAttribute("role")).toBe("alert");
    expect(assertive?.getAttribute("aria-live")).toBe("assertive");
    expect(assertive?.getAttribute("aria-atomic")).toBe("true");
    expect(assertive?.textContent).toBe("");
  });

  it("keeps both regions mounted while it speaks, rather than creating one to speak through", () => {
    const announcer = new LiveAnnouncer({ clock: new ManualClock() });
    const { container } = render(
      <LiveAnnouncerProvider announcer={announcer}>
        <p>a surface</p>
      </LiveAnnouncerProvider>,
    );
    const before = regionsOf(container);

    act(() => {
      announcer.announce("that node refused the attach", "assertive");
    });

    const after = regionsOf(container);
    expect(after).toHaveLength(2);
    // Identity, not just count: a region replaced between announcements is a region
    // inserted carrying its text, which most readers do not announce at all.
    expect(after[0]).toBe(before[0]);
    expect(after[1]).toBe(before[1]);
  });

  it("puts a message in the region its politeness names and leaves the other silent", () => {
    const announcer = new LiveAnnouncer({ clock: new ManualClock() });
    const { container } = render(
      <LiveAnnouncerProvider announcer={announcer}>
        <p>a surface</p>
      </LiveAnnouncerProvider>,
    );

    act(() => {
      announcer.announce("the deck was reordered");
    });

    const [polite, assertive] = regionsOf(container);
    expect(polite?.textContent).toBe("the deck was reordered");
    expect(assertive?.textContent).toBe("");
  });
});

describe("LiveAnnouncerProvider — a surface outside it is told, not ignored", () => {
  it("throws when useAnnounce is called with no provider above it", () => {
    expect(() => render(<SurfaceWithoutProvider />)).toThrow(/outside <LiveAnnouncerProvider>/u);
  });

  it("negative control: the same hook inside the provider returns a working announce", () => {
    // Without this, a hook that threw unconditionally would satisfy the case above
    // and make every surface in the console unrenderable.
    const announcer = new LiveAnnouncer({ clock: new ManualClock() });
    let announced: ReturnType<typeof useAnnounce> | undefined;
    const { container } = render(
      <LiveAnnouncerProvider announcer={announcer}>
        <AnnouncingSurface
          onReady={(announce) => {
            announced = announce;
          }}
        />
      </LiveAnnouncerProvider>,
    );

    act(() => {
      announced?.("said through the hook", "assertive");
    });

    expect(regionsOf(container)[1]?.textContent).toBe("said through the hook");
  });
});

describe("LiveAnnouncerProvider — it disposes only the announcer it built", () => {
  it("leaves a supplied announcer alive after unmount, because the caller owns it", () => {
    const announcer = new LiveAnnouncer({ clock: new ManualClock() });
    const { unmount } = render(
      <LiveAnnouncerProvider announcer={announcer}>
        <p>a surface</p>
      </LiveAnnouncerProvider>,
    );

    unmount();

    expect(announcer.isDisposed).toBe(false);
  });

  it("negative control: the announcer it built has its clear timer cancelled on unmount", () => {
    // Without this, a provider that disposed nothing at all would satisfy the case
    // above while leaking one armed `setTimeout` per window that was ever spoken
    // through. The announcer it builds runs on `RealClock`, so the platform timer
    // count IS the observation — measured against a baseline, because the renderer
    // and the DOM shim arm timers of their own.
    let built: ReturnType<typeof useAnnounce> | undefined;
    vi.useFakeTimers();
    try {
      const { unmount, container } = render(
        <LiveAnnouncerProvider>
          <AnnouncingSurface
            onReady={(announce) => {
              built = announce;
            }}
          />
        </LiveAnnouncerProvider>,
      );
      const armedBeforeAnnouncing = vi.getTimerCount();

      act(() => {
        built?.("said before the window closed");
      });
      expect(regionsOf(container)[0]?.textContent).toBe("said before the window closed");
      expect(vi.getTimerCount()).toBe(armedBeforeAnnouncing + 1);

      unmount();

      expect(vi.getTimerCount()).toBe(armedBeforeAnnouncing);
    } finally {
      vi.useRealTimers();
    }
  });
});
