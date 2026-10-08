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
}

/**
 * An instant on the machine's own clock with its day in front unless it is `nowMs`'s day, such as
 * `Tomorrow 6:00 AM`, written in `locale`; hovering it shows the time it stands for with its zone.
 */
export function DayClockFigure(props: DayClockFigureProps): React.JSX.Element {
  return (
    <WireFigure
      value={formatDayClock(props.at, props.nowMs, props.locale)}
      title={formatZonedDateTime(props.at, props.locale)}
    />
  );
}
