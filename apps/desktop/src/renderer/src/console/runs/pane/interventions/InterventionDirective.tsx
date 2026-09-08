// What a participant directed, where the console may still read it.
//
// Its own module because a `.tsx` declares one component, and a sibling of
// `DurableInterventionRow.tsx` on `InterventionBody.tsx`'s rule: the body travels with
// the row because it is read nowhere else, and a directive rendered apart from the
// record it belongs to is two halves of one row a reader has to reassemble.

import type { GrowthInterventionRecord } from "../../../bridge/index.js";

/**
 * What the participant directed, where the console may still read it.
 *
 * The body-unavailable arm is a SENTENCE and not an empty line: a steer directive and
 * a replacement-send body rest encrypted under the authoring participant's key, so a
 * row whose key has been shredded is a complete audit record with an unreadable
 * directive — which is a different fact from an intervention that carried no text.
 */
export function InterventionDirective(props: {
  readonly record: GrowthInterventionRecord;
}): React.JSX.Element {
  const { directive } = props.record;
  return directive.availability === "available" ? (
    <p className="meridian-interventions__directive">{directive.text}</p>
  ) : (
    <p className="meridian-interventions__detail">
      The directive rests encrypted under the authoring participant&apos;s key, which this node no
      longer holds. The audit record stands; its text cannot be read.
    </p>
  );
}
