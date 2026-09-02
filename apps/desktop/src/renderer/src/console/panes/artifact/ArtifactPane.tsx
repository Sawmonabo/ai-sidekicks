// The artifact pane's chrome: the frame an artifact is read inside.
//
// `Spec-023 §Console Design (Meridian)` fixes `artifact` as one of the deck's
// eleven pane kinds. What the pane RENDERS — the manifest row, the preview, the
// explicit fetch a payload too large for inline rendering falls back to — is the
// artifact surface's own design, and it is built in this family beside this file
// once the reads it composes exist. Every one of them is on `Plan-023 §Console
// growth slate` today (`artifactList`, `artifactRead`, `artifactAllowlistRead`),
// which is why this file claims the kind and draws the frame and stops there.
//
// The claim matters on its own. `Spec-023` requires an unknown pane kind in a
// restored layout to be "dropped and reported"; a kind with no body is one the deck
// can hold and cannot fill, and the frame that says so is the difference between a
// pane a person can see is reserved and a pane that renders as a hole.
//
// The absence is `not-checked` for §10.6's reason, restated because it is the same
// mistake in a different pane: `empty` would assert that the session has no
// artifacts. Nothing has been read. Those are different facts and the console does
// not conflate them.

import { useId } from "react";

import { Glyph, Nothing } from "../../primitives/index.js";
import { type ConsolePaneContext } from "../../workspace/index.js";

export interface ArtifactPaneProps {
  readonly context: ConsolePaneContext;
}

export function ArtifactPane(props: ArtifactPaneProps): React.JSX.Element {
  const { context } = props;
  const headingId = useId();
  return (
    <section
      className="meridian-repos-pane meridian-repos-pane--artifact"
      aria-labelledby={headingId}
      data-pane-id={context.paneId}
    >
      <header className="meridian-repos-pane__header">
        <h2 className="meridian-repos-pane__heading" id={headingId}>
          <Glyph name="artifact" />
          Artifact
        </h2>
        {context.entity === undefined ? null : (
          <span
            className="meridian-repos-pane__subject"
            title={context.entity.id}
            aria-label={`Subject: ${context.entity.kind} ${context.entity.id}`}
          >
            {context.entity.id}
          </span>
        )}
      </header>
      <div className="meridian-repos-pane__body">
        <Nothing
          kind="not-checked"
          placement="surface"
          title="No artifact has been read."
          detail="The artifact reads this pane composes are not registered on the bridge yet, so nothing has been asked for and nothing is being reported as absent."
        />
      </div>
    </section>
  );
}
