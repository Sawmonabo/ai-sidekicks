import { PartialRead } from "@renderer/components/PartialRead/PartialRead.js";
import {
  answeredReadingStates,
  ATTENTION_SUBJECT,
  type AnsweredAttentionReading,
} from "@renderer/store/attention/attention-summary.js";

/**
 * What the panel says about how complete the read was. The sentence and figure come from
 * `lib/partial-read.ts`, the same fact the spoken settlement carries. Renders nothing when the
 * read was whole.
 */
export function ReadCompleteness(props: {
  readonly reading: AnsweredAttentionReading;
}): React.JSX.Element | null {
  return <PartialRead states={answeredReadingStates(props.reading)} subject={ATTENTION_SUBJECT} />;
}
