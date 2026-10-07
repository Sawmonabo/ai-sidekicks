// The first line of a refusal card or banner: a registered code and its reason as words, never
// their wire spelling. Plain text in the failure color, not mono, which marks only what a person
// wrote. A refusal the app wrote draws no line, so its sentence stands alone.

import "./RefusalWords.css";

import { refusalWords } from "#renderer/lib/code-words.js";
import { type RefusalProps } from "./props.js";

/** A refusal's code and reason as one line of words, or nothing for a refusal the app wrote. */
export function RefusalWords(
  props: Pick<RefusalProps, "code" | "reason">,
): React.JSX.Element | null {
  const words = refusalWords(props.code, props.reason);
  return words === undefined ? null : <span className="meridian-refusal-words">{words}</span>;
}
