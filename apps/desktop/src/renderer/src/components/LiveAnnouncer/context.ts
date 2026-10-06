import { createContext, type Context } from "react";

import type { LiveAnnouncer } from "./announcer.js";

/**
 * The window's one announcer, provided by `LiveAnnouncerProvider`. `undefined` outside
 * the provider, which `useAnnounce` refuses rather than announcing into nothing.
 */
export const LiveAnnouncerContext: Context<LiveAnnouncer | undefined> = createContext<
  LiveAnnouncer | undefined
>(undefined);
