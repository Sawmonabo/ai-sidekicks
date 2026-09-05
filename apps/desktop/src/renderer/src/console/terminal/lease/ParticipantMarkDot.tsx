// The holder's identity as a MARK rather than an edge — this is not a row.
//
// Split from `LeaseLine.tsx` so that module declares one component. Decorative to
// assistive technology on purpose: the holder is named in words beside it by
// `HolderName.tsx`, so announcing the dot would read the same participant twice.

import { participantHueTokenName, tokenReference } from "../../tokens/index.js";
import type { TerminalParticipantMark } from "./participant-mark.js";

/** Carries the holder's participant hue into the mark's fill. */
interface LeaseMarkStyle extends React.CSSProperties {
  readonly "--meridian-lease-hue": string;
}

export interface ParticipantMarkDotProps {
  readonly mark: TerminalParticipantMark | undefined;
}

export function ParticipantMarkDot(props: ParticipantMarkDotProps): React.JSX.Element {
  const className =
    props.mark === undefined
      ? "meridian-lease-line__mark meridian-lease-line__mark--unattributed"
      : `meridian-lease-line__mark meridian-lease-line__mark--${props.mark.ringTreatment}`;
  const style: LeaseMarkStyle | undefined =
    props.mark === undefined
      ? undefined
      : { "--meridian-lease-hue": tokenReference(participantHueTokenName(props.mark.hueStep)) };
  return <span className={className} style={style} aria-hidden="true" />;
}
