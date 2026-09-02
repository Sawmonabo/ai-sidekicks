// Rate-limit chips: what is left of a provider account's quota, per limit window.
//
// WHY THE HEALTHY BAND IS THE HIDDEN BAND. The design gives three bands by
// remaining quota — healthy above 50%, caution from 20 to 50, urgent below 20 — and
// shows a chip only below 50. So the healthy band never renders, which is why there
// are two tones here and not three: a quota nobody needs to think about earns no
// pixel and no colour. The absence of a chip is therefore NOT a health reading, and
// nothing in this file or above it treats it as one.
//
// WHY THIS IS NOT `Chip`. `Chip` carries one fact, in one word, with at most one
// colour, and that is the right shape for the things it is used for. A rate reading
// is four facts — whose account, which window, how much is spent, and when it
// resets — and rendering it as four chips would be the wall of colour the two-hue
// rule exists to prevent. The group below is one row carrying one tone on its own
// edge, and every figure inside it still goes through the primitives.
//
// WHAT IS NEVER SYNTHESISED. A missing `resetsAt` renders no countdown rather than
// a computed one; a missing label yields no reading at all (`usage-readings.ts`
// refuses it); quotas are never summed across accounts or windows, because two
// windows of one account are two independent limits and their sum bounds nothing.

import {
  DerivedFigure,
  Glyph,
  WireFigure,
  formatCount,
  formatRelativeTime,
} from "../../../console/primitives/index.js";
import {
  RATE_CHIP_RENDER_CAP,
  RATE_CHIP_URGENT_BELOW_REMAINING_PERCENT,
  RATE_CHIP_VISIBLE_BELOW_REMAINING_PERCENT,
} from "./accessory-bounds.js";
import { remainingPercentOf, type FoldedRateLimitReading } from "./usage-readings.js";

/**
 * The two tones that render. Closed, and derived into a union below, so a third
 * cannot be introduced in one place while the band function still answers two.
 */
export const RATE_CHIP_TONES = ["caution", "urgent"] as const;

/** One rendered rate-chip tone. */
export type RateChipTone = (typeof RATE_CHIP_TONES)[number];

export interface RateChipsProps {
  readonly readings: readonly FoldedRateLimitReading[];
  /** The clock reading a countdown is measured against. Supplied, never read here. */
  readonly nowMilliseconds: number;
}

/**
 * The tone a reading earns, or `undefined` when it earns no chip at all.
 *
 * One function for the visibility rule AND the tone, because they are one rule read
 * at two thresholds: a reading that earns no tone is exactly a reading that is not
 * shown. Two functions would let the thresholds drift into a band that is visible
 * and colourless.
 */
export function rateChipToneFor(reading: FoldedRateLimitReading): RateChipTone | undefined {
  const remaining = remainingPercentOf(reading);
  if (remaining >= RATE_CHIP_VISIBLE_BELOW_REMAINING_PERCENT) {
    return undefined;
  }
  return remaining < RATE_CHIP_URGENT_BELOW_REMAINING_PERCENT ? "urgent" : "caution";
}

export function RateChips(props: RateChipsProps): React.JSX.Element | null {
  const shown = props.readings
    .map((reading) => ({ reading, tone: rateChipToneFor(reading) }))
    .filter(
      (candidate): candidate is { reading: FoldedRateLimitReading; tone: RateChipTone } =>
        candidate.tone !== undefined,
    );
  if (shown.length === 0) {
    // Nothing at all — not an empty state, not a badge. Every chip being above the
    // visibility threshold is the ordinary case, and a line saying so would be the
    // console asserting health it was never told.
    return null;
  }
  const rendered = shown.slice(0, RATE_CHIP_RENDER_CAP);
  const foldedCount = shown.length - rendered.length;
  return (
    <ul className="meridian-rate-chips" aria-label="Provider quota warnings">
      {rendered.map(({ reading, tone }) => (
        <RateChip
          key={`${reading.providerAccountId} ${reading.limitId}`}
          reading={reading}
          tone={tone}
          nowMilliseconds={props.nowMilliseconds}
        />
      ))}
      {foldedCount > 0 ? (
        <li className="meridian-rate-chips__fold">
          <DerivedFigure text={`+${formatCount(foldedCount)} more`} />
        </li>
      ) : null}
    </ul>
  );
}

interface RateChipProps {
  readonly reading: FoldedRateLimitReading;
  readonly tone: RateChipTone;
  readonly nowMilliseconds: number;
}

const STALE_GLYPH_SIZE = 12;

function RateChip(props: RateChipProps): React.JSX.Element {
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
