import { WireFigure } from "#renderer/components/WireFigure/WireFigure.js";
import { DerivedFigure } from "#renderer/components/DerivedFigure/DerivedFigure.js";
import { formatCount } from "#renderer/lib/wire/figures.js";
import { TOOL_ALLOWLIST_NAMED_CAP } from "#renderer/features/agents/caps.js";
import { NAMELESS_TOOL_ALLOWLIST_WORDING, type AgentToolAllowlistPosition } from "../position.js";
import { ToolAllowlistReading } from "./ToolAllowlistReading.js";

/**
 * The tool allowlist as applied: the names, or the reading its position carries. It reads the
 * position, not the raw member, which cannot tell "no allowlist" from "no configuration". It adds
 * only the names; the position's sentence belongs to the line.
 */
export function ToolAllowlist(props: {
  readonly position: AgentToolAllowlistPosition;
}): React.JSX.Element {
  const { position } = props;
  if (position.kind !== "named") {
    const wording = NAMELESS_TOOL_ALLOWLIST_WORDING[position.kind];
    return <ToolAllowlistReading weight={wording.weight}>{wording.reading}</ToolAllowlistReading>;
  }
  const unnamedCount = position.toolNames.length - TOOL_ALLOWLIST_NAMED_CAP;
  return (
    <>
      {position.toolNames.slice(0, TOOL_ALLOWLIST_NAMED_CAP).map((toolName) => (
        <WireFigure key={toolName} value={toolName} />
      ))}
      {unnamedCount > 0 ? (
        <>
          {" and "}
          <DerivedFigure text={formatCount(unnamedCount)} />
          {" more"}
        </>
      ) : null}
    </>
  );
}
