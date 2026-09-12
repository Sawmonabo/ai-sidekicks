// The per-agent tool grant, on the card, as one line.
//
// The per-agent tool control belongs here and the node-wide one in settings. Neither
// half is a control on this card: a person changes the first by attaching with a
// different definition and the second on the browser settings page.
//
// WHY THIS IS ITS OWN LINE AND NOT A ROW IN THE ECHO. The echo answers "what did the
// attach resolve to", and every axis in it is a provider axis a switch can later
// move. This answers "what may this agent reach", which is a governance question with
// a ceiling above it, and it is the only one of the two a reader needs without
// opening a disclosure. The tool NAMES stay in the echo and are not repeated here —
// `tool-grant.ts` records why this line carries a count instead.
//
// THE CEILING IS NOT HERE, AND THAT IS THE POINT. The node-wide switch that withholds
// the browser page tool set is a fact about the NODE, true of every agent in the
// roster and of agents nobody has attached yet. Stated under each card it was three
// lines repeated per agent, and under the unanswered position it asserted that an
// allowlist had been applied to a reply that named none. `ToolGrantCeiling.tsx` states
// it once, beside the roster, with the mechanism as its subject.
//
// WHAT THIS LINE SAYS IS `tool-grant.ts`'s, not this file's. The echo's Tools row
// states the same position a few pixels below, and one wire state that reads two ways
// on one card is the defect that module's table exists to close.

import { Nothing } from "../../primitives/index.js";
import {
  NAMELESS_TOOL_GRANT_WORDING,
  namedToolGrantSentence,
  type AgentToolGrantPosition,
} from "./tool-grant.js";
import { ToolGrantReading } from "./ToolGrantReading.js";

export function ToolGrantLine(props: {
  readonly position: AgentToolGrantPosition;
}): React.JSX.Element {
  return (
    <p className="meridian-agent-card__tool-grant">
      <span className="meridian-agent-card__line-label">Tool grant</span>{" "}
      {positionSentence(props.position)}
    </p>
  );
}

/**
 * What each position says, in the console's own words.
 *
 * `not-reported` carries a badge AND its sentence as visible text. The badge alone
 * said "Not reported" and hid the explanation in a `title` attribute, which reaches
 * no keyboard and no screen-reader user — so the one position whose whole meaning is
 * "no question was put" was the one position that never explained itself.
 */
function positionSentence(position: AgentToolGrantPosition): React.JSX.Element {
  if (position.kind === "named") {
    return (
      <ToolGrantReading weight="derived">
        {namedToolGrantSentence(position.toolNames)}
      </ToolGrantReading>
    );
  }
  const wording = NAMELESS_TOOL_GRANT_WORDING[position.kind];
  if (position.kind === "not-reported") {
    return (
      <>
        <Nothing kind="not-checked" placement="inline" title={wording.reading} />{" "}
        <ToolGrantReading weight={wording.weight}>{wording.lineSentence}</ToolGrantReading>
      </>
    );
  }
  return <ToolGrantReading weight={wording.weight}>{wording.lineSentence}</ToolGrantReading>;
}
