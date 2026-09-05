// One quota reading, rendered as one row of the rate group.
//
// Split from `RateChips.tsx` because the group and the row answer different
// questions: the group decides WHICH readings are worth a pixel and in what order,
// and this decides what one of them looks like once that is settled.
//
// THE TONE ARRIVES AS A PROP AND IS NEVER RECOMPUTED HERE. Banding is one rule,
// declared once in `rate-chip-tone.ts` and applied by the group; a row that
// re-derived its own band would be a second answer to a question already answered,
// and the two would drift the day the thresholds move. Every figure below still
// goes through the primitives.

import {
  DerivedFigure,
  Glyph,
  WireFigure,
  formatCount,
  formatRelativeTime,
} from "../../../../console/primitives/index.js";
import { type ProviderQuotaReading } from "../../../../console/bridge/index.js";
import type { RateChipTone } from "./rate-chip-tone.js";

interface RateChipProps {
  readonly reading: ProviderQuotaReading;
  readonly tone: RateChipTone;
  readonly nowMilliseconds: number;
}

const STALE_GLYPH_SIZE = 12;

export function RateChip(props: RateChipProps): React.JSX.Element {
  const { reading } = props;
  return (
    <li className="meridian-rate-chip" data-tone={props.tone}>
      <WireFigure value={reading.accountLabel} />
      <span className="meridian-rate-chip__limit">
        <WireFigure value={reading.limitLabel} />
      </span>
      <span className="meridian-rate-chip__used">
        <WireFigure value={formatCount(reading.usedPercent)} title={String(reading.usedPercent)} />
        <span className="meridian-rate-chip__unit">% used</span>
      </span>
      {reading.resetsAt === undefined ? null : (
        <DerivedFigure
          text={`resets ${formatRelativeTime(reading.resetsAt, props.nowMilliseconds)}`}
        />
      )}
      {reading.isStale ? (
        <Glyph
          name="alert"
          size={STALE_GLYPH_SIZE}
          title="Read under an older credential generation than this account has since reported."
        />
      ) : null}
    </li>
  );
}
