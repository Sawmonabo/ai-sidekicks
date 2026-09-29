import { useContext } from "react";

import { LiveAnnouncerContext } from "@renderer/components/LiveAnnouncer/live-announcer-context.js";
import type { Announce } from "@renderer/components/LiveAnnouncer/live-announcer.js";

const OUTSIDE_PROVIDER =
  "useAnnounce was called outside <LiveAnnouncerProvider>. The console has one announcer per window, mounted by the frame, so that a component can never speak through a region that was created at the moment it spoke.";

/**
 * How a component says something. Throws outside the provider rather than returning a
 * no-op: a component announcing into nothing is a wiring bug that is invisible to
 * everyone who can see the screen, which is the one class of defect this primitive
 * exists to prevent.
 */
export function useAnnounce(): Announce {
  const announcer = useContext(LiveAnnouncerContext);
  if (announcer === undefined) {
    throw new Error(OUTSIDE_PROVIDER);
  }
  return announcer.announce;
}
