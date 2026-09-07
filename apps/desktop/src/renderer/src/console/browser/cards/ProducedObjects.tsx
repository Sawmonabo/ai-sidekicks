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
//     known. "Otherwise" is the shelf being TOTAL over its own props rather than a
//     state the pane reaches today — the pane's register is both the provenance and
//     the card store, so an id it names it also has a card for. A shelf that answered
//     an unbacked id with nothing would be a row silently missing from a list whose
//     density rule is one row per produced object.
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
//
// AND THEY RENDER ON BOTH ROW SHAPES, which is why the state is joined on HERE rather
// than carried in the register. A card used to win outright over the state-aware
// identity row, so an object this window captured and the log later superseded went on
// rendering as an ordinary capture: the richer row was the one that could not say the
// one thing that had changed. The card keeps its richer content and takes the state as
// a prop, so neither row shape is the degraded one.

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
        // Scoped to this window rather than to the session, because that is the whole
        // extent of what the console can know: the artifact events name no producer,
        // so an object another window's browser made is indistinguishable on the log
        // from a repository attachment, and claiming the session produced nothing
        // would be a claim about surfaces this one cannot see.
        detail="This window's browser has not produced a capture, a download, or an asset bundle."
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
          <BrowserCaptureCard key={artifact.artifactId} {...card.props} state={artifact.state} />
        ) : (
          <BrowserDownloadCard key={artifact.artifactId} {...card.props} state={artifact.state} />
        );
      })}
    </div>
  );
}
