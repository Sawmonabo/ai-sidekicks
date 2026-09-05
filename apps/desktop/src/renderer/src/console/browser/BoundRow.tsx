// One bound's row: its name, its ceiling, what this window measures, and why the
// ceiling is where it is.
//
// A module of its own because `one-component-per-module.test.ts` holds every `.tsx`
// to one component. Not exported through the family door — it is the meter's own
// composition, and a bound row rendered outside that table would be a ceiling
// reported with no ledger around it.

import { BROWSER_BOUNDS, type BrowserBoundName } from "./browser-bounds.js";
import { BoundReading } from "./BoundReading.js";
import { describeMeasure, scalarFigureTitle } from "./bound-figures.js";

export function BoundRow(props: {
  readonly name: BrowserBoundName;
  readonly reading: number | undefined;
}): React.JSX.Element {
  const bound = BROWSER_BOUNDS[props.name];
  return (
    <tr>
      <th scope="row" className="meridian-browser-bounds__name">
        {props.name}
      </th>
      <td title={scalarFigureTitle(bound.measure)}>{describeMeasure(bound.measure)}</td>
      <td>
        <BoundReading measure={bound.measure} reading={props.reading} />
      </td>
      <td className="meridian-browser-bounds__why">{bound.derivation}</td>
    </tr>
  );
}
