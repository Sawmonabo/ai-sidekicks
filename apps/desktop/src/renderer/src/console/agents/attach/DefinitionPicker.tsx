import { Nothing, RefusalCard } from "../../primitives/index.js";
import type { PushDrivenReadState } from "../../seats/index.js";
import { type AttachSidekickForm } from "./attach-model.js";
import type { SidekickDefinitionListReading } from "../agent-wire.js";

/** The definition arm's picker, with the whole definition folded into one line. */
export function DefinitionPicker(props: {
  readonly form: AttachSidekickForm;
  readonly definitions: PushDrivenReadState<SidekickDefinitionListReading>;
}): React.JSX.Element {
  const { definitions, form } = props;
  if (definitions.kind === "not-loaded") {
    return <Nothing kind="not-loaded" title="Reading the definitions" />;
  }
  if (definitions.kind === "failed") {
    // Not reachable through the arm button, which is disabled in this state; kept
    // because a read can fail while the arm is already selected.
    return <RefusalCard {...definitions.refusal} />;
  }
  const rows = definitions.value.definitions;
  if (rows.length === 0) {
    return (
      <Nothing
        kind="empty"
        title="No sidekick definitions exist yet."
        detail="Spelling out a driver and a model attaches an agent without one."
      />
    );
  }
  return (
    <ul className="meridian-attach__definitions">
      {rows.map((definition) => (
        <li key={definition.definitionId} className="meridian-attach__definition">
          <button
            type="button"
            className="meridian-attach__definition-button"
            aria-pressed={form.definition?.definitionId === definition.definitionId}
            onClick={() => form.selectDefinition(definition)}
          >
            <span className="meridian-attach__definition-name">
              {definition.name ?? definition.definitionId}
            </span>
            <span className="meridian-attach__definition-summary">
              {[definition.driverName, definition.modelId, definition.effort]
                .filter((axis): axis is string => axis !== undefined)
                .join(" · ")}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
