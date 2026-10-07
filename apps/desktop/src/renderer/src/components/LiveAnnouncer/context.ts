import { createContext, type Context } from "react";

import type { LiveAnnouncer } from "./announcer.js";

/**
 * The window's one announcer, provided by `LiveAnnouncerProvider`. `undefined` outside
 * the provider, which `useAnnounce` refuses rather than announcing into nothing.
 */
export const LiveAnnouncerContext: Context<LiveAnnouncer | undefined> = createContext<
  LiveAnnouncer | undefined
>(undefined);

/** Whether the content around a line is still being drawn for the first time. */
export interface StandingContentState {
  /** True while the content's first draw is under way; read from an effect, never a render. */
  readonly isOpening: () => boolean;
}

/**
 * The nearest `StandingContent` around a line. `undefined` where none is, so a line that
 * appears there is news.
 */
export const StandingContentContext: Context<StandingContentState | undefined> = createContext<
  StandingContentState | undefined
>(undefined);
