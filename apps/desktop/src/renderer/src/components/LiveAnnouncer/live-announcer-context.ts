import { createContext } from "react";

import type { LiveAnnouncer } from "./live-announcer.js";

/**
 * The window's one announcer, provided by `LiveAnnouncerProvider`. `undefined` outside
 * the provider, which `useAnnounce` refuses rather than announcing into nothing.
 */
export const LiveAnnouncerContext = createContext<LiveAnnouncer | undefined>(undefined);
