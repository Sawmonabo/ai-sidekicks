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
// a computed one; a reading whose account the registry does not carry is dropped
// rather than labelled with an opaque id (`provider-account-quota.ts` refuses it);
// quotas are never summed across accounts or windows, because two windows of one
// account are two independent limits and their sum bounds nothing.
//
// AND THE READINGS COME OFF THE ACCOUNT PLANE. They used to be folded out of the
// session timeline, which could never have carried them — `usage.rate_limit_update`
// is bound to the node-scope sentinel session. The shape this file renders is now
// `ProviderQuotaReading`, read from `providerAccount.list` and kept current by
// `providerAccount.subscribe`; every figure below is the same figure, off a wire that
// sends it.
//
// A FIXTURE SHELL, AND THE SEAT BESIDE IT SAYS SO. The indicator the usage plan
// owns mounts into `RateLimitSlot`; this body is what that seat renders until it
// does, and it is DELETED by the PR that mounts the owning body rather than being
// left behind as a second answer to the same question.

import { DerivedFigure, formatCount } from "../../../console/primitives/index.js";
import { type ProviderQuotaReading } from "../../../console/bridge/index.js";
import { RATE_CHIP_RENDER_CAP } from "./accessory-bounds.js";
import { rateChipToneFor, type RateChipTone } from "./rate-chip-tone.js";
import { RateChip } from "./RateChip.js";

export interface RateChipsProps {
  readonly readings: readonly ProviderQuotaReading[];
  /** The clock reading a countdown is measured against. Supplied, never read here. */
  readonly nowMilliseconds: number;
}

export function RateChips(props: RateChipsProps): React.JSX.Element | null {
  const shown = props.readings
    .map((reading) => ({ reading, tone: rateChipToneFor(reading) }))
    .filter(
      (candidate): candidate is { reading: ProviderQuotaReading; tone: RateChipTone } =>
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
          key={`${reading.accountId} ${reading.limitId}`}
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
