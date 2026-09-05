// The notes a message defined and never referred to.
//
// Its own module for the one-component rule. Stripping an uncited definition from the
// body and saying nothing would delete an author's words with no record, so this is
// the line that keeps them on screen.

import { Nothing } from "../../../primitives/index.js";

export interface UncitedDefinitionsProps {
  readonly identifiers: readonly string[];
}

/**
 * The definitions this body declared and never referred to.
 *
 * `not-checked` would be wrong and `error` would be an accusation: the message defined a
 * note, the console read it, and nothing in the message points at it. That is an EMPTY
 * result for a question that was asked — rule 8's `empty` — and the identifiers are the
 * author's own strings, so they are listed rather than counted.
 */
export function UncitedDefinitions(props: UncitedDefinitionsProps): React.JSX.Element | null {
  if (props.identifiers.length === 0) {
    return null;
  }
  return (
    <Nothing
      kind="empty"
      placement="inline"
      title={`Defined and never referred to: ${props.identifiers.join(", ")}.`}
      detail="The note is in the message; nothing in it points here."
    />
  );
}
