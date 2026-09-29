import { act, render } from "@testing-library/react";

import { LIVE_ANNOUNCEMENT_HOLD_MS } from "@renderer/components/LiveAnnouncer/live-announcement-caps.js";
import { LiveAnnouncer } from "@renderer/components/LiveAnnouncer/live-announcer.js";
import { LiveAnnouncerProvider } from "@renderer/components/LiveAnnouncer/LiveAnnouncerProvider.js";
import { ManualClock } from "@renderer/lib/clock.js";
import { liveRegionText, politeText } from "@test/helpers/live-region.js";

/** What one mounted surface hands back, whichever arity of the latch it drives. */
export interface AnnouncedRender<SurfaceProps> {
  readonly polite: () => string;
  readonly assertive: () => string;
  readonly rerender: (next: SurfaceProps) => void;
  readonly settle: () => void;
}

/**
 * The window's announcer, and a surface announcing through it.
 *
 * One scaffold for every arity: the announcer, the provider, the two region readings
 * and the hold are the same for each, and only the component under it differs.
 */
export function renderThroughAnnouncer<SurfaceProps extends object>(
  Surface: (props: SurfaceProps) => null,
  initialProps: SurfaceProps,
): AnnouncedRender<SurfaceProps> {
  const clock = new ManualClock(0);
  const announcer = new LiveAnnouncer({ clock });
  const mounted = (props: SurfaceProps): React.JSX.Element => (
    <LiveAnnouncerProvider announcer={announcer}>
      <Surface {...props} />
    </LiveAnnouncerProvider>
  );
  const { container, rerender } = render(mounted(initialProps));
  return {
    polite: () => politeText(container),
    assertive: () => liveRegionText(container, "assertive"),
    rerender: (next) => {
      rerender(mounted(next));
    },
    // Past the announcer's hold, so a second sentence is published rather than
    // queued behind the standing one. The hold is the announcer's own rule and this
    // drives it rather than reaching around it.
    settle: () => {
      act(() => {
        clock.advance(LIVE_ANNOUNCEMENT_HOLD_MS);
      });
    },
  };
}
