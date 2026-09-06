import { PartialRead } from "../../primitives/index.js";
import {
  answeredReadingStates,
  ATTENTION_SUBJECT,
  type AnsweredAttentionReading,
} from "./attention-plane.js";

/**
 * What the panel says about how complete the read it is showing was.
 *
 * The sentence and the figure are `primitives/partial-read.ts`'s, not this file's:
 * the count of members the boundary could not read is the same fact the spoken
 * settlement carries, and two wordings of one number is a disagreement neither half
 * can see. Renders nothing when the read was whole, which is the only state that
 * claims the groups above are all of it.
 */
export function ReadCompleteness(props: {
  readonly reading: AnsweredAttentionReading;
}): React.JSX.Element | null {
  return <PartialRead states={answeredReadingStates(props.reading)} subject={ATTENTION_SUBJECT} />;
}
