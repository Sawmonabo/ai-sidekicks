// A read in flight shows nothing at first and its loading line only once it has run past a short
// delay, so a quick read never flashes one. The line says its words once through the app's
// announcer. It appears while a person waits, so it is news even inside content still opening for
// the first time. The delay runs on the clock the caller hands in, the window's own, so a fixture
// or a test moves it; lines that wait on one read can share one delay the caller holds instead.

import "./LoadingNotice.css";

import type { Clock } from "#renderer/lib/clock.js";
import { useIsPastDelay } from "#renderer/hooks/useIsPastDelay.js";
import { AnnouncedLine } from "../AnnouncedLine/AnnouncedLine.js";
import { StandingContentContext } from "../LiveAnnouncer/context.js";
import type { NothingPlacement } from "../Nothing/Nothing.js";

/** How long a read in flight shows nothing before its loading line: a first row's launch budget. */
export const LOADING_NOTICE_DELAY_MS = 800;

/**
 * Props for `LoadingNotice`: the window's clock its own delay runs on, or, where several lines wait
 * on one read, whether the one delay their caller holds has run out.
 */
export type LoadingNoticeProps = {
  /**
   * The loading line: `Loading…`, or `Loading pending runs…` where nothing on screen names it.
   */
  readonly title: string;
  /** `block` stands in for a region's content as a line of its own; `inline` sits in a line. */
  readonly placement?: NothingPlacement;
} & (
  | {
      /** The window's clock, from `useClock()`. */
      readonly clock: Clock;
    }
  | {
      /** Whether the caller's delay, of `LOADING_NOTICE_DELAY_MS`, has run out. */
      readonly isPastDelay: boolean;
    }
);

/** A read's loading line in words, drawn only once the read has taken longer than the delay. */
export function LoadingNotice(props: LoadingNoticeProps): React.JSX.Element | null {
  const isPastOwnDelay = useIsPastDelay(
    "clock" in props ? props.clock : undefined,
    LOADING_NOTICE_DELAY_MS,
  );
  const isPastDelay = "isPastDelay" in props ? props.isPastDelay : isPastOwnDelay;
  if (!isPastDelay) {
    return null;
  }
  return (
    <StandingContentContext.Provider value={undefined}>
      <AnnouncedLine
        element={props.placement === "inline" ? "span" : "p"}
        className="meridian-loading-notice"
        words={props.title}
        politeness="polite"
        isBusy
      />
    </StandingContentContext.Provider>
  );
}
