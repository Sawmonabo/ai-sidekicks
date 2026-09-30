// The per-agent tool allowlist on the card, as one line. Neither half of the control is here: the
// per-agent list is set when an agent starts from a definition and the node-wide switch is on
// the browser settings page. It is a line, not an echo row, because it answers "what may this
// agent reach", which a reader needs without opening a disclosure. It carries a count, never the
// names, and the words come from `tool-allowlist.ts` so the echo's Tools row cannot disagree.

import { Nothing } from "@renderer/components/Nothing/Nothing.js";
import {
  NAMELESS_TOOL_ALLOWLIST_WORDING,
  namedToolAllowlistSentence,
  type AgentToolAllowlistPosition,
} from "../tool-allowlist.js";
import { ToolAllowlistReading } from "./ToolAllowlistReading.js";

/** The tool grant line: what this agent may reach, worded by the grant table. */
export function ToolAllowlistLine(props: {
  readonly position: AgentToolAllowlistPosition;
}): React.JSX.Element {
  return (
    <p className="meridian-agent-card__tool-allowlist">
      <span className="meridian-agent-card__line-label">Tool grant</span>{" "}
      {positionSentence(props.position)}
    </p>
  );
}

/**
 * What each position says, in the console's own words. `not-reported` shows a badge and its
 * sentence as visible text, since a `title` alone reaches no keyboard or screen-reader user.
 */
function positionSentence(position: AgentToolAllowlistPosition): React.JSX.Element {
  if (position.kind === "named") {
    return (
      <ToolAllowlistReading weight="derived">
        {namedToolAllowlistSentence(position.toolNames)}
      </ToolAllowlistReading>
    );
  }
  const wording = NAMELESS_TOOL_ALLOWLIST_WORDING[position.kind];
  if (position.kind === "not-reported") {
    return (
      <>
        <Nothing kind="not-checked" placement="inline" title={wording.reading} />{" "}
        <ToolAllowlistReading weight={wording.weight}>{wording.lineSentence}</ToolAllowlistReading>
      </>
    );
  }
  return (
    <ToolAllowlistReading weight={wording.weight}>{wording.lineSentence}</ToolAllowlistReading>
  );
}
