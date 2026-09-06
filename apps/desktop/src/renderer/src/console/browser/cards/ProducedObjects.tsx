// The pane's produced-object shelf: what this session's browser has left behind.
//
// `Spec-023 §Console Design (Meridian)` 12.6 Renders: "The pane's overflow control
// shows the session's recent browser-produced artifacts with a
// reveal-in-file-manager action on each local one." 12.6 Density: "One artifact row
// per produced object, collapsed to name, kind, and size, with the preview one click
// away."
//
// WHERE EACH HALF OF A ROW COMES FROM, AND WHY THAT SPLIT IS THE HONEST ONE. The log
// carries a produced object's IDENTITY, its state, and the run that made it, and it
// carries nothing else — no name, no kind, no size, because none of the three is on
// the event. They live on the artifact manifest, which the console reads through an
// operation the growth port refuses today.
//
// So a row has two possible shapes and this shelf renders whichever one it can
// justify:
//
//   • A CARD, for an object this window itself produced. A capture taken through the
//     pane's own control answers with its artifact id, its stored media type, and its
//     byte length, so every prop the card renders came back from the act that made
//     it. That is a source, not a guess.
//   • An IDENTITY ROW otherwise, carrying what the log actually said. It is not a
//     degraded card and it does not leave a name-shaped hole: it says which object,
//     what state it reached, and which run made it, which is the whole of what is
//     known.
//
// A row is never a card with invented fields. Rendering the artifact id where a name
// belongs would put a locator in a name's place on every row, and a person would
// learn to read ids as names — which is exactly the conflation the identity row
// avoids by saying plainly what it is showing.
//
// ALL THREE STATES RENDER, AND THEY RENDER DIFFERENTLY. `pending` is the design's own
// loading state — an ingest in flight — `published` is the settled row, and
// `superseded` is a retaken capture's predecessor kept as history rather than
// deleted. A shelf that collapsed any two of them would hide the retake.

import { Nothing } from "../../primitives/index.js";
import { BrowserCaptureCard } from "./CaptureCard.js";
import { BrowserDownloadCard } from "./DownloadCard.js";
import type { ProducedArtifact, ProducedObjectCard } from "./produced-objects.js";
import { ProducedObjectRow } from "./ProducedObjectRow.js";

export interface ProducedObjectsProps {
  readonly artifacts: readonly ProducedArtifact[];
  /** Cards for the objects this window itself produced, keyed by artifact id. */
  readonly cardsByArtifactId: ReadonlyMap<string, ProducedObjectCard>;
}

export function ProducedObjects(props: ProducedObjectsProps): React.JSX.Element {
  const { artifacts, cardsByArtifactId } = props;

  if (artifacts.length === 0) {
    return (
      <Nothing
        kind="empty"
        placement="inline"
        title="Nothing produced yet"
        detail="This session's browser has not produced a capture, a download, or an asset bundle."
      />
    );
  }

  return (
    <div className="meridian-browser-cards">
      {artifacts.map((artifact) => {
        const card = cardsByArtifactId.get(artifact.artifactId);
        if (card === undefined) {
          return <ProducedObjectRow key={artifact.artifactId} artifact={artifact} />;
        }
        return card.kind === "capture" ? (
          <BrowserCaptureCard key={artifact.artifactId} {...card.props} />
        ) : (
          <BrowserDownloadCard key={artifact.artifactId} {...card.props} />
        );
      })}
    </div>
  );
}
