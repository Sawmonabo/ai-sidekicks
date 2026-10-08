// The mark on a file a workflow run's step changed: the step's name alone, drawn the same in the
// file list and on the diff's file header, and read aloud as the step that made the change.

import { HoverLabel } from "#renderer/components/HoverLabel/HoverLabel.js";

/** Props for `DiffStepMark`. */
export interface DiffStepMarkProps {
  readonly stepName: string;
}

/** The step's name on screen; a screen reader hears `Changed by the <step name> step`. */
export function DiffStepMark(props: DiffStepMarkProps): React.JSX.Element {
  return (
    <HoverLabel text={props.stepName} textRole="visible-text">
      <span className="meridian-diff__step-mark">
        <span aria-hidden="true">{props.stepName}</span>
        <span className="meridian-visually-hidden">{`Changed by the ${props.stepName} step`}</span>
      </span>
    </HoverLabel>
  );
}
