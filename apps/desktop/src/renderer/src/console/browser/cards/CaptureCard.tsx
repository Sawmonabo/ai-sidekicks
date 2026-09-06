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

import { ingestRemedySentence, type BrowserIngestState } from "./artifact-ingest.js";
import { BrowserIngestMeter } from "./IngestMeter.js";
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
  /** The capture's own name, composed by whoever asked for it. Not a wire figure. */
  readonly captureName: string;
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
    <article className={className} aria-label={`Capture ${props.captureName}`}>
      <div className="meridian-browser-card__head">
        <span className="meridian-browser-card__name">{props.captureName}</span>
        <div className="meridian-browser-card__meta">
          <Chip label={CAPTURE_SCOPE_LABELS[props.scope]} glyph="browser" />
          <Chip mono label={props.mediaType} />
        </div>
      </div>

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
