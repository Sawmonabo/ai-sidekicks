import { DerivedFigure } from "#renderer/components/DerivedFigure/DerivedFigure.js";
import { formatDateTime } from "#renderer/lib/wire/figures.js";
import { useClockLocale } from "#renderer/services/platform/hooks/useClockLocale.js";

/**
 * When the last update check finished, or the sentence for a build that never checked.
 *
 * `idle` reports the absence of an act, which means different things after a check a minute
 * ago and before any check, so the optional timestamp's absence renders as a sentence and not
 * a blank or an invented instant. The figure is absolute: a relative reading would go stale
 * because nothing re-renders an idle block. It is a derived figure, the console's rendering
 * of the updater's ISO string through its one date formatter, which answers an em dash for a
 * value it cannot parse.
 */
export function LastCheckedLine(props: {
  readonly lastCheckedAt: string | undefined;
}): React.JSX.Element {
  const clockLocale = useClockLocale();
  if (props.lastCheckedAt === undefined) {
    return (
      <span className="meridian-settings-page__aside">
        No check has finished in this installation.
      </span>
    );
  }
  return (
    <span className="meridian-settings-page__aside">
      Last checked <DerivedFigure text={formatDateTime(props.lastCheckedAt, clockLocale)} />.
    </span>
  );
}
