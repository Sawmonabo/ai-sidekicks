import { useContext } from "react";

import { LiveAnnouncerContext } from "#renderer/components/LiveAnnouncer/live-announcer-context.js";
import type { Announce } from "#renderer/components/LiveAnnouncer/live-announcer.js";

const OUTSIDE_PROVIDER =
  "useAnnounce was called outside <LiveAnnouncerProvider>. The app has one " +
  "announcer per window, mounted by the frame, so that a component can " +
  "never speak through a region that was created at the moment it spoke.";

/**
 * How a component says something. Throws outside the provider rather than returning a
 * no-op, because announcing into nothing is invisible to everyone who can see the screen.
 */
export function useAnnounce(): Announce {
  const announcer = useContext(LiveAnnouncerContext);
  if (announcer === undefined) {
    throw new Error(OUTSIDE_PROVIDER);
  }
  return announcer.announce;
}
