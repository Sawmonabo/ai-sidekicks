// One download, as the object the ingest pipeline made of it.
//
// `Spec-023 §Console Design (Meridian)` 12.6 gives downloads two rules a card can
// actually hold to, and this one holds to both.
//
//   • **They never land where the page asks.** "Downloads never land where the page
//     asks. They land in the session's artifact store through the ingest pipeline",
//     and "The browser never writes a file to a path a page chose." So the row shows
//     the name the page proposed as TEXT and says where the bytes actually went. The
//     proposed name is not a locator here and is never used as one: the reveal
//     control is nullary and the main process resolves the file.
//
//     THE DESTINATION IS TRUE OF EVERY DOWNLOAD; THE PAST TENSE IS NOT. One
//     already-stored sentence rendered on every arm told an operator their bytes were
//     in the artifact store while the card beside it rendered the refusal that kept
//     them out of it — and on the `none` remedy, which says in terms that they will
//     not be stored, the card contradicted itself in two adjacent lines. So the arm
//     picks the tense, in the table below.
//
//   • **The ceiling is the pipeline's, quoted rather than minted.** "A download's
//     byte ceiling is `max_attachment_ingest_bytes` from that same section. The
//     browser mints no second size cap for downloads, because a second cap would
//     drift from the one the pipeline enforces." So the ceiling arrives as a prop,
//     rendered as a wire figure beside the declared total, and this component
//     compares nothing against it — an over-ceiling download is refused by the
//     pipeline with `Spec-014`'s own code, and that refusal is what renders.
//
//     QUOTING IT MEANS KEEPING THE NUMBER. Rendered only as its rounded reading, a
//     ceiling of 8,388,609 bytes and one of 8,388,608 are the same figure on screen,
//     and an operator comparing two nodes' enforced limits cannot tell them apart.
//     So the ceiling goes through the same exact-value path as this card's other
//     byte figures — `WireFigure`, with the pipeline's own count in its `title` —
//     which is the rule that component exists to keep.
//
// The state vocabulary is `artifact-ingest.ts`'s, shared with the capture card,
// because one pipeline produced both.

import { ingestRemedySentence, type BrowserIngestState } from "./artifact-ingest.js";
import { BrowserIngestMeter } from "./IngestMeter.js";
import {
  Chip,
  InlineRefusal,
  Nothing,
  WireFigure,
  formatByteQuantity,
} from "../../primitives/index.js";

/** The sentence an arm that has not stored anything yet can honestly use. */
const INTENDED_DESTINATION_NOTE =
  "Destined for this session’s artifact store, never for the destination the page asked for.";

/**
 * Where the bytes are, in the tense each arm can claim.
 *
 * The refused arm takes none: its refusal already carries the pipeline's own code, and
 * `ingestRemedySentence` already says what became of these bytes. A destination line
 * beside them would be the card claiming a store the pipeline had just refused.
 *
 * Total over the ingest states by construction — a fifth state fails to compile here
 * before it can reach a card that says the wrong thing about it.
 */
const DESTINATION_NOTES: Readonly<Record<BrowserIngestState["status"], string | undefined>> = {
  stored: "Stored in this session’s artifact store, never at the destination the page asked for.",
  "in-flight": INTENDED_DESTINATION_NOTE,
  "not-checked": INTENDED_DESTINATION_NOTE,
  refused: undefined,
};

export interface BrowserDownloadCardProps {
  /**
   * The name the page proposed. Rendered as text and used as a locator by nothing —
   * the browser writes no file to a path a page chose.
   */
  readonly proposedFileName: string;
  /** Which of this run's pages produced it, by the label the pane shows. */
  readonly sourcePageLabel: string;
  readonly ingest: BrowserIngestState;
  /**
   * `max_attachment_ingest_bytes`, as the pipeline reports it. Absent where the
   * effective bound has not been read; the row then states the ceiling is the
   * pipeline's rather than naming a number nobody supplied.
   */
  readonly ingestCeilingByteLength?: number | undefined;
  /** Reveal the stored artifact's local file. Nullary — no path crosses here. */
  readonly onRevealInFileManager?: (() => void) | undefined;
}

export function BrowserDownloadCard(props: BrowserDownloadCardProps): React.JSX.Element {
  const destinationNote = DESTINATION_NOTES[props.ingest.status];
  const isRefused = props.ingest.status === "refused";
  const isWaiting = props.ingest.status === "in-flight";
  const className = [
    "meridian-browser-card",
    isRefused ? "meridian-browser-card--refused" : "",
    isWaiting ? "meridian-browser-card--waiting" : "",
  ]
    .filter((part) => part !== "")
    .join(" ");

  return (
    <article className={className} aria-label={`Download ${props.proposedFileName}`}>
      <div className="meridian-browser-card__head">
        <span className="meridian-browser-card__name">{props.proposedFileName}</span>
        <div className="meridian-browser-card__meta">
          <Chip label={props.sourcePageLabel} glyph="browser" />
          {props.ingestCeilingByteLength === undefined ? null : (
            <span className="meridian-browser-card__ceiling">
              Ceiling{" "}
              <WireFigure
                value={formatByteQuantity(props.ingestCeilingByteLength).text}
                title={String(props.ingestCeilingByteLength)}
              />
            </span>
          )}
        </div>
      </div>

      {destinationNote === undefined ? null : (
        <p className="meridian-browser-card__note">{destinationNote}</p>
      )}

      {props.ingest.status === "not-checked" ? (
        <Nothing
          kind="not-checked"
          placement="inline"
          title="Not ingested"
          detail="The console has not asked what the ingest pipeline did with these bytes."
        />
      ) : null}

      {props.ingest.status === "in-flight" ? (
        <BrowserIngestMeter
          label="Download ingest"
          receivedByteLength={props.ingest.receivedByteLength}
          declaredByteLength={props.ingest.declaredByteLength}
        />
      ) : null}

      {props.ingest.status === "stored" ? (
        <div className="meridian-browser-card__footer">
          <WireFigure
            value={formatByteQuantity(props.ingest.byteLength).text}
            title={String(props.ingest.byteLength)}
          />
          <WireFigure value={props.ingest.artifactId} />
          {props.onRevealInFileManager === undefined ? null : (
            <button
              type="button"
              className="meridian-browser-action"
              // Wrapped rather than passed straight through: React hands a click
              // handler its synthetic event, and this callback is declared nullary
              // precisely so nothing about the DOM reaches the caller.
              onClick={() => {
                props.onRevealInFileManager?.();
              }}
            >
              Reveal in file manager
            </button>
          )}
        </div>
      ) : null}

      {props.ingest.status === "refused" ? (
        <InlineRefusal
          code={props.ingest.refusal.code}
          detail={props.ingest.refusal.detail}
          action={
            <span className="meridian-browser-card__note">
              {ingestRemedySentence(props.ingest.remedy)}
            </span>
          }
        />
      ) : null}
    </article>
  );
}
