import { clampProse } from "./ResolvedConfigurationEcho.js";

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
