// One labelled execution root, verbatim, with the reason it exists beside it.
//
// A MODULE OF ITS OWN BECAUSE IT IS A SECOND COMPONENT, which `apps/desktop/AGENTS.md`
// puts one to a `.tsx` file — and the split earns its keep here rather than merely
// satisfying a rule: the disclosure above decides WHICH rows exist and this decides how
// one reads, and the two questions have different answers to give.

import { Nothing, WireFigure } from "../../primitives/index.js";
import type { ExecutionPathRow as ExecutionPathRowModel } from "./execution-context-model.js";

/**
 * One labelled root, verbatim, with the reason it exists beside it.
 *
 * THE PATH IS A `WireFigure` AND THE MEANING IS PROSE, which keeps the two readable as
 * two kinds of thing: `MountCard.tsx` states the rule the figure obeys — no
 * home-directory abbreviation, no basename shortening, middle-truncated by the
 * stylesheet with the whole string on the element's title — and prose in the same slot
 * would be truncated by the same rule for no reason.
 *
 * THE AGREEMENT MARK IS A WORD AND NOT A SHARED STYLE, because two roots that agree is
 * a claim this surface is making and a person has to be able to read it as one. It is
 * stated in the row's own text rather than by a colour, which nothing carries meaning
 * in on its own under the console's rules.
 */
export function ExecutionPathRow(props: {
  readonly row: ExecutionPathRowModel;
}): React.JSX.Element {
  const { row } = props;
  return (
    <>
      <dt className="meridian-execution-context__label">{row.label}</dt>
      <dd className="meridian-execution-context__value">
        {row.value === undefined ? (
          <Nothing kind="empty" title={row.absence ?? "This root was not reported."} />
        ) : (
          <WireFigure value={row.value} title={row.value} />
        )}
        <span className="meridian-execution-context__meaning">{row.meaning}</span>
        {row.matchesPrevious ? (
          <span className="meridian-execution-context__same">
            The daemon reported the same path as the row above.
          </span>
        ) : null}
      </dd>
    </>
  );
}
