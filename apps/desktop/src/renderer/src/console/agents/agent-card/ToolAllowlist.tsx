import { WireFigure, formatCount } from "../../primitives/index.js";
import { TOOL_ALLOWLIST_NAMED_CAP } from "../../core/index.js";
import { NAMELESS_TOOL_GRANT_WORDING, type AgentToolGrantPosition } from "./tool-grant.js";
import { ToolGrantReading } from "./ToolGrantReading.js";

/**
 * The tool allowlist as applied: the names, or the reading its position carries.
 *
 * IT READS THE POSITION AND NEVER THE MEMBER. This row used to take
 * `toolAllowlist` alone, which cannot tell a configuration that carried no allowlist
 * from a reply that carried no configuration — so it answered "not reported" for a
 * state the governance line three lines above called the driver's default set. One
 * wire value now has one reading on this card, and `tool-grant.ts` holds it.
 *
 * IT SAYS NOTHING THE LINE ALREADY SAID. The position's sentence belongs to the line;
 * what the disclosure adds is the NAMES, and where a position has none it states that
 * position in the fewest words that are true.
 */
export function ToolAllowlist(props: {
  readonly position: AgentToolGrantPosition;
}): React.JSX.Element {
  const { position } = props;
  if (position.kind !== "named") {
    const wording = NAMELESS_TOOL_GRANT_WORDING[position.kind];
    return <ToolGrantReading weight={wording.weight}>{wording.reading}</ToolGrantReading>;
  }
  const unnamedCount = position.toolNames.length - TOOL_ALLOWLIST_NAMED_CAP;
  return (
    <>
      {position.toolNames.slice(0, TOOL_ALLOWLIST_NAMED_CAP).map((toolName) => (
        <WireFigure key={toolName} value={toolName} />
      ))}
      {unnamedCount > 0 ? ` and ${formatCount(unnamedCount)} more` : null}
    </>
  );
}
