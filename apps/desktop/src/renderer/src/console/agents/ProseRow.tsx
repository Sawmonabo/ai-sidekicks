import { RESOLVED_PROSE_INLINE_CAP } from "../core/index.js";
export function ProseRow(props: {
  readonly label: string;
  readonly text: string | undefined;
}): React.JSX.Element {
  return (
    <div className="meridian-agent-card__resolved-row">
      <dt>{props.label}</dt>
      <dd>
        {props.text === undefined ? (
          <span className="meridian-agent-card__axis-absent">not reported</span>
        ) : (
          clampProse(props.text)
        )}
      </dd>
    </div>
  );
}

/** Leading prose, clamped at the named bound. Never re-wrapped and never summarized. */
export function clampProse(text: string): string {
  return text.length <= RESOLVED_PROSE_INLINE_CAP
    ? text
    : `${text.slice(0, RESOLVED_PROSE_INLINE_CAP)}…`;
}
