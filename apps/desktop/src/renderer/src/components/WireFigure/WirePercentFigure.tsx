import { useMemo } from "react";

import { formatExactPercent, formatPercent } from "#renderer/lib/wire/figures.js";
import { WireFigure } from "./WireFigure.js";

/** Props for `WirePercentFigure`. */
export interface WirePercentFigureProps {
  /** The percent as the wire sent it, `0` to `100` and past it where a reading overshoots. */
  readonly percent: number;
}

/** A percent the wire sent, rounded for reading, with every digit it sent in its hover label. */
export function WirePercentFigure(props: WirePercentFigureProps): React.JSX.Element {
  const { percent } = props;
  const rounded = useMemo(() => formatPercent(percent / 100), [percent]);
  const exact = useMemo(() => formatExactPercent(percent), [percent]);
  return <WireFigure value={rounded} hoverLabel={exact} />;
}
