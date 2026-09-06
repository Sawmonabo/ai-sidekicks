import { WireFigure, formatCount } from "../primitives/index.js";
import { TOOL_ALLOWLIST_NAMED_CAP } from "../core/index.js";

/**
 * The tool allowlist as applied — presence first, emptiness second.
 *
 * An ABSENT member is the daemon not reporting the axis. A PRESENT empty array is
 * the applied configuration "no tools at all", which is a restriction somebody chose
 * and the strictest posture this agent can have. Rendering them alike would be the
 * conflation the whole card exists to refuse. The empty case is a derived sentence
 * rather than a wire figure because there is no wire value to print.
 */
export function ToolAllowlist(props: {
  readonly allowlist: readonly string[] | undefined;
}): React.JSX.Element {
  const { allowlist } = props;
  if (allowlist === undefined) {
    return <span className="meridian-agent-card__axis-absent">not reported</span>;
  }
  if (allowlist.length === 0) {
    return (
      <span className="meridian-agent-card__axis-derived">
        No tools. This agent was attached with an empty allowlist.
      </span>
    );
  }
  return (
    <>
      {allowlist.slice(0, TOOL_ALLOWLIST_NAMED_CAP).map((toolName) => (
        <WireFigure key={toolName} value={toolName} />
      ))}
      {allowlist.length > TOOL_ALLOWLIST_NAMED_CAP
        ? ` and ${formatCount(allowlist.length - TOOL_ALLOWLIST_NAMED_CAP)} more`
        : null}
    </>
  );
}
