import { useMemo } from "react";

import { DerivedFigure } from "#renderer/components/DerivedFigure/DerivedFigure.js";
import { WireFigure } from "#renderer/components/WireFigure/WireFigure.js";
import { formatDayClock, formatZonedDateTime } from "#renderer/lib/wire/figures.js";

/** Props for `DayClockFigure`. */
export interface DayClockFigureProps {
  /** The instant, as an ISO 8601 stamp. */
  readonly at: string;
  /** The instant whose day the figure's day is counted from. */
  readonly nowMs: number;
  /** The machine's clock locale, which the figure is written in. */
  readonly locale: string;
  /**
   * Whether the instant was read off the window's own clock, standing in for one the daemon has
   * not reported yet; it is then drawn as the app's own reading rather than a wire figure.
   */
  readonly isWindowClock?: boolean;
}

/**
 * An instant on the machine's own clock with its day in front unless it is `nowMs`'s day, such as
 * `Tomorrow 6:00 AM`, written in `locale`; hovering it shows the time it stands for with its zone.
 */
export function DayClockFigure(props: DayClockFigureProps): React.JSX.Element {
  const { at, nowMs, locale } = props;
  const reading = useMemo(() => formatDayClock(at, nowMs, locale), [at, nowMs, locale]);
  const zonedTime = useMemo(() => formatZonedDateTime(at, locale), [at, locale]);
  return props.isWindowClock === true ? (
    <DerivedFigure text={reading} hoverLabel={zonedTime} />
  ) : (
    <WireFigure value={reading} hoverLabel={zonedTime} />
  );
}
