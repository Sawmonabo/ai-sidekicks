// A read in flight shows nothing at first and its loading line only once it has run past a short
// delay, so a quick read never flashes one. The line is its words, read out once as a status. The
// delay runs on the clock the caller hands in, the window's own, so a fixture or a test moves it.

import "./LoadingNotice.css";

import { useEffect, useState } from "react";

import type { Clock } from "#renderer/lib/clock.js";
import type { NothingPlacement } from "../Nothing/Nothing.js";

/** How long a read in flight shows nothing before its loading line: a first row's launch budget. */
export const LOADING_NOTICE_DELAY_MS = 800;

/** Props for `LoadingNotice`. */
export interface LoadingNoticeProps {
  /** The loading line, such as `Loading this run…`. */
  readonly title: string;
  /** `block` stands in for a region's content as a line of its own; `inline` sits in a line. */
  readonly placement?: NothingPlacement;
  /** The window's clock, from `useClock()`. */
  readonly clock: Clock;
}

/** A read's loading line in words, drawn only once the read has taken longer than the delay. */
export function LoadingNotice(props: LoadingNoticeProps): React.JSX.Element | null {
  const { clock } = props;
  const [isPastDelay, setIsPastDelay] = useState(false);
  useEffect(() => {
    const handle = clock.scheduleTimeout(() => {
      setIsPastDelay(true);
    }, LOADING_NOTICE_DELAY_MS);
    return () => {
      clock.cancel(handle);
    };
  }, [clock]);
  if (!isPastDelay) {
    return null;
  }
  return props.placement === "inline" ? (
    <span className="meridian-loading-notice" role="status" aria-busy="true">
      {props.title}
    </span>
  ) : (
    <p className="meridian-loading-notice" role="status" aria-busy="true">
      {props.title}
    </p>
  );
}
