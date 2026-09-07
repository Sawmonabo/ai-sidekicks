// One capture, as the object the ingest pipeline made of it.
//
// `Spec-023 §Console Design (Meridian)` 12.6: a capture "lands as an artifact row",
// collapsed to "name, kind, and size, with the preview one click away". This card is
// that row's browser-side shape — the overflow's reading of what this session's
// browser has produced, beside the timeline's own row for the same artifact.
//
// TWO RULES THIS CARD EXISTS TO KEEP.
//
//   • **A capture is never rendered inline as trusted markup.** 12.6 states it
//     directly, and `Spec-014 §Scope limits, stated rather than implied` relies on
//     artifacts being explicit fetches for the agreement-consistent polyglot case.
//     So there is no `img` element here and no data URI: the preview is a control
//     the CALLER supplies, and where no fetch route exists the control is simply
//     absent rather than drawn and inert.
//
//   • **The media type is rendered, never checked.** `image/svg+xml` is outside the
//     shipped default allow-list of
//     `Spec-014 §Bounds (normative defaults; operator-tunable)`, and a bundle carrying
//     one is refused with a refusal that says so — by the pipeline. A console-side
//     allow-list would be a second validation path for browser bytes, which is
//     precisely what that section's one-pipeline rule forbids. The type arrives as a
//     wire string and renders verbatim in mono.
//
// The reveal control takes no path. 12.6: "Reveal in file manager takes no path from
// the renderer" — the callback is nullary, the main process resolves the file, and a
// raw path crosses this boundary in neither direction.
//
// AND THE NAME SLOT HOLDS A NAME OR IT HOLDS NOTHING. `browserCapture` answers with an
// artifact id, a media type, and a byte length, and with no name at all — so the
// register that mints these cards had been assigning the id into `captureName`, which
// put an opaque locator in the human-name slot, in the plain body face, on every
// capture this window took. A person reading two of them side by side would learn to
// read ids as names, which is the one conflation the shelf's identity row exists to
// avoid. The name is therefore OPTIONAL here, and a card without one renders its
// identity through the wire-figure chokepoint and says the manifest that would carry a
// name has not been read. It stops being an identity the moment a producer supplies a
// real name.

import { ingestRemedySentence, type BrowserIngestState } from "./artifact-ingest.js";
import { BrowserIngestMeter } from "./IngestMeter.js";
import {
  PRODUCED_ARTIFACT_STATE_LABELS,
  type ProducedArtifactState,
} from "./produced-artifact-state.js";
import {
  Chip,
  InlineRefusal,
  Nothing,
  WireFigure,
  formatByteQuantity,
} from "../../primitives/index.js";

/**
 * What part of the page a capture covers. Closed at the three
 * `Spec-023 §Console Design (Meridian)` 12.7 gives `page.screenshot` — "viewport,
 * bounded clip, or height-capped full page" — with the union derived from the tuple.
 */
export const BROWSER_CAPTURE_SCOPES = ["viewport", "clip", "full-page"] as const;

export type BrowserCaptureScope = (typeof BROWSER_CAPTURE_SCOPES)[number];

/** The reader-facing name of each scope. Total over the set by construction. */
const CAPTURE_SCOPE_LABELS: Readonly<Record<BrowserCaptureScope, string>> = {
  viewport: "Viewport",
  clip: "Clipped region",
  "full-page": "Full page",
};

/**
 * Where the displaced capture is, in the tense each ingest arm can claim.
 *
 * The displacement and the ingest are two different facts about the same object —
 * the tool result could not carry the image, and the pipeline did or did not store
 * it — and the note used to state the second while reading only the first. So a card
 * showing a refusal said in one line that the bytes were kept out of the store and in
 * the next that the full capture was here, and on the `none` remedy, which says in
 * terms that they never will be, it contradicted itself twice.
 *
 * Total over the ingest states by construction — a fifth state fails to compile here
 * before it can reach a card that says the wrong thing about it. The `refused` entry
 * is the sentence a recoverable refusal takes; the terminal remedy overrides it
 * below, because "was not stored" and "will not be stored" are different facts and
 * only the producer knows which one applies.
 */
const DISPLACED_CAPTURE_NOTES: Readonly<Record<BrowserIngestState["status"], string>> = {
  stored: "The full capture is here.",
  "in-flight": "The full capture is being stored now.",
  "not-checked": "Whether the full capture was stored is a question nobody has put.",
  refused: "The full capture was not stored.",
};

/** What became of the capture the tool result could not carry. */
function displacedCaptureNote(ingest: BrowserIngestState): string {
  if (ingest.status === "refused" && ingest.remedy === "none") {
    return "The full capture will not be stored.";
  }
  return DISPLACED_CAPTURE_NOTES[ingest.status];
}

export interface BrowserCaptureCardProps {
  /**
   * Which produced object this card is about, wire-verbatim.
   *
   * The SHELF's key, and never a display value: `ProducedObjects.tsx` looks a card up
   * by the artifact id the log's own fold carries. Its own member rather than a
   * reading of `ingest`, because three of the four ingest arms carry no id and a card
   * that lost its identity the moment its bytes were refused would drop off the shelf
   * exactly when the operator was looking for it.
   */
  readonly artifactId: string;
  /**
   * The capture's own name, composed by whoever asked for it. Not a wire figure.
   *
   * Optional because no producer supplies one today: `browserCapture` answers with an
   * id, a media type, and a byte length. An absent name is rendered as an absent name
   * — never as the id wearing the name's face.
   */
  readonly captureName?: string | undefined;
  /**
   * Where this object stands in the artifact lifecycle, as the LOG says.
   *
   * Required, and joined on by the shelf rather than held in the register: a card that
   * could not state its state rendered a superseded capture as an ordinary one, with
   * every other fact on the row still true and the only changed one invisible.
   */
  readonly state: ProducedArtifactState;
  readonly scope: BrowserCaptureScope;
  /** The encoded type, as the pipeline reported it. Wire-verbatim, never checked here. */
  readonly mediaType: string;
  readonly ingest: BrowserIngestState;
  /**
   * True when the encoded capture did not fit the driver's outbound frame bound, so
   * the tool result carried the artifact id and a stated reason instead of the
   * image. 12.6 forbids a silently truncated image; the row is where the human is
   * told the full one is still here.
   */
  readonly displacedFromToolResult?: boolean | undefined;
  /** Reveal this capture's local file. Nullary on purpose — no path crosses here. */
  readonly onRevealInFileManager?: (() => void) | undefined;
  /** Open the preview as an explicit fetch. Absent where no fetch route exists. */
  readonly onOpenPreview?: (() => void) | undefined;
}

export function BrowserCaptureCard(props: BrowserCaptureCardProps): React.JSX.Element {
  const isRefused = props.ingest.status === "refused";
  const className = `meridian-browser-card${isRefused ? " meridian-browser-card--refused" : ""}`;

  return (
    <article
      className={className}
      // The id where no name exists, so the row is still addressable by assistive
      // technology — an accessible name of "Capture undefined" is worse than a locator.
      aria-label={`Capture ${props.captureName ?? props.artifactId}`}
    >
      <div className="meridian-browser-card__head">
        {props.captureName === undefined ? (
          <WireFigure value={props.artifactId} />
        ) : (
          <span className="meridian-browser-card__name">{props.captureName}</span>
        )}
        <div className="meridian-browser-card__meta">
          <Chip label={PRODUCED_ARTIFACT_STATE_LABELS[props.state]} glyph="artifact" />
          <Chip label={CAPTURE_SCOPE_LABELS[props.scope]} glyph="browser" />
          <Chip mono label={props.mediaType} />
        </div>
      </div>

      {props.captureName === undefined ? (
        <Nothing
          kind="not-checked"
          placement="inline"
          title="Manifest not read"
          // Narrower than the identity row's sentence on purpose: this card's kind and
          // size came back from the act that produced it, so only the name is unread.
          detail="This capture's name is on its manifest, and the console has not read one for it — the artifact id stands in its place."
        />
      ) : null}

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
          label="Capture ingest"
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
          {props.onOpenPreview === undefined ? null : (
            <button
              type="button"
              className="meridian-browser-action"
              // Wrapped rather than passed straight through: React hands a click
              // handler its synthetic event, and these callbacks are declared
              // nullary precisely so nothing about the DOM reaches the caller.
              onClick={() => {
                props.onOpenPreview?.();
              }}
            >
              Open preview
            </button>
          )}
          {props.onRevealInFileManager === undefined ? null : (
            <button
              type="button"
              className="meridian-browser-action"
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

      {props.displacedFromToolResult === true ? (
        <p className="meridian-browser-card__note">
          The tool result carried this capture&rsquo;s id and the reason it did not fit, rather than
          the image. {displacedCaptureNote(props.ingest)}
        </p>
      ) : null}
    </article>
  );
}
