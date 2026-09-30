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
          clampProse(props.text)
        )}
      </dd>
    </div>
  );
}

/** Leading prose, clamped at the named bound. Never re-wrapped and never summarized. */
function clampProse(text: string): string {
  return text.length <= RESOLVED_PROSE_INLINE_CAP
    ? text
    : `${text.slice(0, RESOLVED_PROSE_INLINE_CAP)}…`;
}
