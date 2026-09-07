import { DerivedFigure, formatDateTime } from "../../../../primitives/index.js";

/**
 * When the last update check finished, or the sentence for a build that never checked.
 *
 * `idle` is the one arm of `UpdateState` that says nothing about itself: `checking`,
 * `downloading`, `ready`, and `error` each report an act, and "no update is waiting"
 * reports the absence of one — which is a completely different fact depending on
 * whether a check finished a minute ago or has never finished at all. The contract's
 * member is optional for exactly that reason, so its absence renders as the honest
 * sentence rather than as a blank, an em dash, or an invented instant.
 *
 * ABSOLUTE AND NOT RELATIVE. A relative reading ("4 minutes ago") is true at the
 * instant it renders and quietly wrong afterwards, and this line has no reason to
 * re-render: nothing about `idle` moves until the updater pushes a different arm, and
 * a line that had to be re-rendered to stay true would need a clock read this block
 * has no other use for. So the figure is the instant itself, through the console's one
 * date formatter — which answers an em dash for a value it cannot parse rather than
 * rendering whatever `Date` makes of it.
 *
 * A DERIVED FIGURE AND NOT A WIRE ONE. The ISO string is the updater's, and what
 * renders is this console's rendering of it in the viewer's locale — which is the
 * distinction `primitives/wire-figures.ts` draws between the two figure kinds.
 */
export function LastCheckedLine(props: {
  readonly lastCheckedAt: string | undefined;
}): React.JSX.Element {
  if (props.lastCheckedAt === undefined) {
    return (
      <span className="meridian-settings-page__aside">
        No check has finished in this installation.
      </span>
    );
  }
  return (
    <span className="meridian-settings-page__aside">
      Last checked <DerivedFigure text={formatDateTime(props.lastCheckedAt)} />.
    </span>
  );
}
