import { act, render } from "@testing-library/react";

import { LIVE_ANNOUNCEMENT_HOLD_MS } from "@renderer/components/LiveAnnouncer/live-announcement-caps.js";
import { LiveAnnouncer } from "@renderer/components/LiveAnnouncer/live-announcer.js";
import { LiveAnnouncerProvider } from "@renderer/components/LiveAnnouncer/LiveAnnouncerProvider.js";
import { ManualClock } from "@renderer/lib/clock.js";
import { liveRegionText, politeText } from "@test/helpers/live-region.js";

/** What one mounted component hands back, whichever arity of the latch it drives. */
export interface AnnouncedRender<AnnouncingProps> {
  readonly polite: () => string;
  readonly assertive: () => string;
  readonly rerender: (next: AnnouncingProps) => void;
  readonly settle: () => void;
}

/**
 * The window's announcer, and a component announcing through it.
 *
 * One scaffold for every arity of the latch; only the component under the provider differs.
 */
export function renderThroughAnnouncer<AnnouncingProps extends object>(
  AnnouncingComponent: (props: AnnouncingProps) => null,
  initialProps: AnnouncingProps,
): AnnouncedRender<AnnouncingProps> {
  const clock = new ManualClock(0);
  const announcer = new LiveAnnouncer({ clock });
  const mounted = (props: AnnouncingProps): React.JSX.Element => (
    <LiveAnnouncerProvider announcer={announcer}>
      <AnnouncingComponent {...props} />
    </LiveAnnouncerProvider>
  );
  const { container, rerender } = render(mounted(initialProps));
  return {
    polite: () => politeText(container),
    assertive: () => liveRegionText(container, "assertive"),
    rerender: (next) => {
      rerender(mounted(next));
    },
    // Past the announcer's hold, so a second sentence is published rather than queued
    // behind the standing one.
    settle: () => {
      act(() => {
        clock.advance(LIVE_ANNOUNCEMENT_HOLD_MS);
      });
    },
  };
}
