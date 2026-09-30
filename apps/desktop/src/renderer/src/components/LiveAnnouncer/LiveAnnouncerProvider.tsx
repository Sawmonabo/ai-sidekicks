// The announcer's mount: two regions that exist for the life of the window, and the context every
// component reaches them through. The regions render here, empty and above the frame's `inert`
// wrapper, so they stay in the accessibility tree while a modal overlay is open.

import { useEffect, useState, type ReactNode } from "react";

import { type Clock } from "@renderer/lib/clock.js";
import { LiveAnnouncer } from "./live-announcer.js";
import { LiveAnnouncerContext } from "./live-announcer-context.js";
import { LiveRegion } from "./LiveRegion.js";

/** Props for `LiveAnnouncerProvider`. */
export interface LiveAnnouncerProviderProps {
  readonly children: ReactNode;
  /**
   * Overrides the announcer (tests). A supplied announcer outlives the provider and is never
   * disposed here.
   */
  readonly announcer?: LiveAnnouncer;
  /**
   * The clock the hold deadline runs on. The frame passes `useClock()` so fixture mode stays on
   * the frozen clock; this component sits below `services/` and cannot read it. Ignored when
   * `announcer` is supplied.
   */
  readonly clock?: Clock;
}

/**
 * One announcer per window, and the two regions it speaks through. The announcer is state, not a
 * memo, since a discarded memo would leave the regions subscribed to a dead object; the re-mint
 * arm covers StrictMode's second effect pass finding its own announcer already disposed.
 */
export function LiveAnnouncerProvider(props: LiveAnnouncerProviderProps): React.JSX.Element {
  // Pinned at mount: the re-mint arm must build the second announcer on the first one's clock.
  const [clock] = useState<Clock | undefined>(() => props.clock);
  const [ownedAnnouncer, setOwnedAnnouncer] = useState<LiveAnnouncer>(() => mintAnnouncer(clock));
  const suppliedAnnouncer = props.announcer;
  const announcer = suppliedAnnouncer ?? ownedAnnouncer;

  useEffect(() => {
    if (suppliedAnnouncer !== undefined) {
      return undefined;
    }
    if (ownedAnnouncer.isDisposed) {
      setOwnedAnnouncer(mintAnnouncer(clock));
      return undefined;
    }
    return () => {
      ownedAnnouncer.dispose();
    };
  }, [suppliedAnnouncer, ownedAnnouncer, clock]);

  return (
    <LiveAnnouncerContext.Provider value={announcer}>
      <LiveRegion announcer={announcer} />
      {props.children}
    </LiveAnnouncerContext.Provider>
  );
}

/**
 * Builds the announcer; omits `clock` rather than passing `undefined`
 * (`exactOptionalPropertyTypes`).
 */
function mintAnnouncer(clock: Clock | undefined): LiveAnnouncer {
  return new LiveAnnouncer(clock === undefined ? {} : { clock });
}
