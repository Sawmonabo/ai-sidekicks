import { elideText } from "@renderer/lib/elide-text.js";
import { RESOLVED_PROSE_INLINE_CAP } from "../../agents-caps.js";

/**
 * One labeled row of an agent's resolved configuration, its prose clamped at the named
 * bound. `null` and an empty string are both prose nobody wrote, and say so.
 */
export function ProseRow(props: {
  readonly label: string;
  readonly text: string | null;
}): React.JSX.Element {
  return (
    <div className="meridian-agent-card__resolved-row">
      <dt>{props.label}</dt>
      <dd>
        {props.text === null || props.text.length === 0 ? (
          <span className="meridian-agent-card__axis-absent">none</span>
        ) : (
          // Leading prose, cut at the bound: never re-wrapped and never summarized.
          elideText(props.text, RESOLVED_PROSE_INLINE_CAP)
        )}
      </dd>
    </div>
  );
}
