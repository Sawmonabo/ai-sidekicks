// The box the composer takes at rest, no draft and no reading, drawn from the composer's own
// classes so it is the composer's height wherever its styles put it. The session screen mounts it,
// hidden and out of reach, while the session's store opens, so the conversation above already
// stands at the height it keeps once the composer arrives. Its sheet is the composer host's,
// which the same registration loads.

import { ComposerMeterStrip } from "./ComposerMeterStrip.js";

/** The composer's resting box with nothing drawn in it, for the session screen to hold. */
export function ComposerRestingSpace(): React.JSX.Element {
  return (
    <section className="meridian-composer">
      {/* The send box with no draft: its floor is taller than one empty line. */}
      <div className="meridian-composer__send" />
      <ComposerMeterStrip contextReading={undefined} />
    </section>
  );
}
