// A mermaid diagram in a reply, drawn as a picture in the screen's own palette. Its source shows in
// the picture's place while the picture is made, and under one line saying why when it cannot be
// drawn. `Copy as picture` and `Copy source` are the block's own hover actions, where the body
// offers copies.

import "./DiagramBlock.css";

import { useRef } from "react";

import { useOwnerWindow } from "#renderer/hooks/useOwnerWindow.js";
import type { BlockCopyOffer } from "../block-copy-offer.js";
import { encodeDiagramPng } from "./png.js";
import { useDrawnDiagram, type DrawnDiagramView } from "./useDrawnDiagram.js";

/** What one diagram block is drawn from. */
export interface DiagramBlockProps {
  /** The fence's source, wire-verbatim. */
  readonly source: string;
  /** Whether the block has settled; a fence still streaming shows its source and is never drawn. */
  readonly isSettled: boolean;
  /** Draws one of the block's copy controls, or `undefined` where the body offers none. */
  readonly renderCopy: ((offer: BlockCopyOffer) => React.ReactNode) | undefined;
}

/** A diagram fence: its picture, its source while the picture is made, or why it has none. */
export function DiagramBlock(props: DiagramBlockProps): React.JSX.Element {
  const frame = useRef<HTMLElement>(null);
  const { drawing, pictureRef, drawCopyPicture } = useDrawnDiagram(
    props.source,
    props.isSettled,
    frame,
  );
  const ownerWindow = useOwnerWindow();
  const source = (
    <pre className="meridian-diagram__source">
      <code>{props.source}</code>
    </pre>
  );
  return (
    <figure ref={frame} className="meridian-diagram" data-state={drawing.status}>
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
              ref={pictureRef}
              className="meridian-diagram__picture"
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
            ? props.renderCopy(pictureCopy(drawCopyPicture, ownerWindow))
            : null}
          {props.source === ""
            ? null
            : props.renderCopy({ label: "Copy source", content: () => ({ text: props.source }) })}
        </div>
      )}
    </figure>
  );
}

/** `Copy as picture`: the copy's own picture, drawn when pressed and painted as a PNG. */
function pictureCopy(
  drawCopyPicture: DrawnDiagramView["drawCopyPicture"],
  ownerWindow: Window,
): BlockCopyOffer {
  return {
    label: "Copy as picture",
    content: async () => ({ png: await encodeDiagramPng(await drawCopyPicture(), ownerWindow) }),
  };
}
