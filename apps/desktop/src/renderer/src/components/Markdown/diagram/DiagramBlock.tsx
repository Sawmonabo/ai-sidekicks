// A mermaid diagram in a reply, drawn as a picture in the screen's own palette. Its source shows in
// the picture's place while the picture is made, and under one line saying why when it cannot be
// drawn. `Copy as picture` and `Copy source` are the block's own hover actions, where the body
// offers copies.

import "./DiagramBlock.css";

import type { ClipboardContent } from "#shared/preload-api.js";
import { useOwnerWindow } from "#renderer/hooks/useOwnerWindow.js";
import type { DrawnDiagram } from "./drawing.js";
import { encodeDiagramPng } from "./png.js";
import { useDrawnDiagram } from "./useDrawnDiagram.js";

/** One copy a diagram block offers: what its control reads and what it puts on the clipboard. */
export interface DiagramCopy {
  readonly label: string;
  /** Built when the copy is pressed, so a picture is encoded only for a copy someone asked for. */
  readonly content: () => ClipboardContent | Promise<ClipboardContent>;
}

/** What one diagram block is drawn from. */
export interface DiagramBlockProps {
  /** The fence's source, wire-verbatim. */
  readonly source: string;
  /** Whether the block has settled; a fence still streaming shows its source and is never drawn. */
  readonly isSettled: boolean;
  /** Draws one of the block's copy controls, or `undefined` where the body offers none. */
  readonly renderCopy: ((copy: DiagramCopy) => React.ReactNode) | undefined;
}

/** A diagram fence: its picture, its source while the picture is made, or why it has none. */
export function DiagramBlock(props: DiagramBlockProps): React.JSX.Element {
  const drawing = useDrawnDiagram(props.source, props.isSettled);
  const ownerWindow = useOwnerWindow();
  const source = (
    <pre className="meridian-diagram__source">
      <code>{props.source}</code>
    </pre>
  );
  return (
    <figure className="meridian-diagram" data-state={drawing.status}>
      {drawing.status === "failed" ? (
        <>
          <p className="meridian-diagram__failure">
            Could not draw this diagram · {drawing.reason}
          </p>
          {source}
        </>
      ) : (
        <div className="meridian-diagram__frame">
          {drawing.status === "drawn" ? (
            <img
              className="meridian-diagram__picture"
              src={drawing.picture.pictureUrl}
              width={drawing.picture.width}
              height={drawing.picture.height}
              alt="Diagram"
            />
          ) : (
            source
          )}
        </div>
      )}
      {props.renderCopy === undefined ? null : (
        <div className="meridian-diagram__actions">
          {drawing.status === "drawn"
            ? props.renderCopy(pictureCopy(drawing.picture, ownerWindow))
            : null}
          {props.source === ""
            ? null
            : props.renderCopy({ label: "Copy source", content: () => ({ text: props.source }) })}
        </div>
      )}
    </figure>
  );
}

function pictureCopy(picture: DrawnDiagram, ownerWindow: Window): DiagramCopy {
  return {
    label: "Copy as picture",
    content: async () => ({ png: await encodeDiagramPng(picture, ownerWindow) }),
  };
}
