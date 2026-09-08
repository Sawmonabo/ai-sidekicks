// The definition arm's picker, and the way from here to where definitions are kept.
//
// FOUR ANSWERS AND ONE LINK. The read has four arms and every one of them is a moment
// where a person might want the registry itself — an empty registry most of all, since
// the way out of it is to author one. So the arm is composed into a body and the link
// is drawn under whichever body that is, rather than being hung on the one arm that
// happened to be written last.
//
// THE LINK IS ABSENT WHERE THERE IS NOWHERE TO GO. The settings rail belongs to the
// main window; the agent console's auxiliary window has its own frame, no rail, and no
// settings route, so its mount hands no navigation and this draws no control. Absent
// rather than disabled: a disabled link would assert a destination that exists and is
// momentarily unavailable, and in that window it does not exist at all.

import { Nothing, RefusalCard } from "../../primitives/index.js";
import type { PushDrivenReadState } from "../../seats/index.js";
import { type AttachSidekickForm } from "./attach-model.js";
import type { SidekickDefinitionListReading } from "../agent-wire.js";

/** The definition arm's picker, with the whole definition folded into one line. */
export function DefinitionPicker(props: {
  readonly form: AttachSidekickForm;
  readonly definitions: PushDrivenReadState<SidekickDefinitionListReading>;
  /** Re-open the definition read, from the surface that owns it. */
  readonly onReopen?: (() => void) | undefined;
  /**
   * Open the page where definitions are kept, from the mount that can navigate.
   *
   * `undefined` in a window with no settings rail, which draws no control at all.
   * Handed in rather than composed here, because which route this console's frame
   * takes is the mount's to decide and a view family may name no frame of its own.
   */
  readonly onOpenDefinitions?: (() => void) | undefined;
}): React.JSX.Element {
  const { definitions, form, onReopen, onOpenDefinitions } = props;
  return (
    <>
      {pickerBody(definitions, form, onReopen)}
      {onOpenDefinitions === undefined ? null : (
        <button
          type="button"
          className="meridian-attach__definitions-link"
          onClick={onOpenDefinitions}
        >
          Manage saved sidekicks
        </button>
      )}
    </>
  );
}

/**
 * Which of the read's four answers this picker is showing.
 *
 * A function returning the body rather than a second component, because this module
 * declares exactly one — and because the arms are a projection of one reading rather
 * than four things with lives of their own.
 */
function pickerBody(
  definitions: PushDrivenReadState<SidekickDefinitionListReading>,
  form: AttachSidekickForm,
  onReopen: (() => void) | undefined,
): React.JSX.Element {
  if (definitions.kind === "not-loaded") {
    return <Nothing kind="not-loaded" title="Reading the definitions" />;
  }
  if (definitions.kind === "failed") {
    // Not reachable through the arm button, which is disabled in this state; kept
    // because a read can fail while the arm is already selected. The way out is
    // handed in, because this picker renders a stream the column beside it owns.
    return (
      <RefusalCard
        {...definitions.refusal}
        action={
          onReopen === undefined ? undefined : (
            <button type="button" onClick={onReopen}>
              Try again
            </button>
          )
        }
      />
    );
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
