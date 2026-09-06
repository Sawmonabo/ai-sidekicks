import { Chip, Glyph } from "../../primitives/index.js";
import {
  diffAttributionSubjectId,
  type ConsoleDiffModel,
  type DiffAttributionMode,
} from "./diff-model.js";

/**
 * The attribution badge and the compared states.
 *
 * The badge is `neutral` on BOTH arms, and that is the two-hue rule rather than
 * an oversight: a workspace-fallback diff is a lower attribution quality, not a
 * failure and not something a person has to act on, so it earns neither red nor
 * amber. It is distinguished by its words and by which subject it names — and a
 * `workspace_fallback` diff renders its workspace and never a run, which the
 * union makes true by construction rather than by this component remembering to.
 */
export function DiffSubjectBar(props: { readonly diff: ConsoleDiffModel }): React.JSX.Element {
  const copy = ATTRIBUTION_COPY[props.diff.attribution.mode];
  const subjectId = diffAttributionSubjectId(props.diff.attribution);
  return (
    <div className="meridian-diff-pane__subject-bar">
      <Chip label={copy.label} glyph="agent" />
      <span className="meridian-diff-pane__attribution-subject" title={subjectId}>
        {`${copy.subject}: `}
        <Chip label={subjectId} mono />
      </span>
      <span className="meridian-diff-pane__refs">
        <Chip label={props.diff.baseRef} mono />
        <Glyph name="diff" />
        <Chip label={props.diff.headRef} mono />
      </span>
    </div>
  );
}

/** What the attribution badge says on each arm, and how the subject is labelled. */
export const ATTRIBUTION_COPY: Readonly<
  Record<DiffAttributionMode, { readonly label: string; readonly subject: string }>
> = {
  run_attributed: { label: "Run-attributed", subject: "Run" },
  workspace_fallback: { label: "Workspace fallback", subject: "Workspace" },
};
