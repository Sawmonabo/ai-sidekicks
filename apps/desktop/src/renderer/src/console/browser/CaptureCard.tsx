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

import {
  formatIngestProgress,
  ingestFillWidth,
  ingestRemedySentence,
  type BrowserIngestState,
} from "./artifact-ingest.js";
import {
  Chip,
  InlineRefusal,
  Nothing,
  WireFigure,
  formatByteQuantity,
} from "../primitives/index.js";

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
        <>
          <div
            className="meridian-browser-meter"
            role="progressbar"
            aria-label="Capture ingest"
            aria-valuenow={props.ingest.receivedByteLength}
            aria-valuemin={0}
            aria-valuemax={props.ingest.declaredByteLength}
          >
            <div
              className="meridian-browser-meter__fill"
              style={{
                inlineSize: ingestFillWidth(
                  props.ingest.receivedByteLength,
                  props.ingest.declaredByteLength,
                ),
              }}
            />
          </div>
          <p className="meridian-browser-card__note">
            <WireFigure
              value={formatIngestProgress(
                props.ingest.receivedByteLength,
                props.ingest.declaredByteLength,
              )}
              title={String(props.ingest.receivedByteLength)}
            />{" "}
            received.
          </p>
        </>
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
          the image. The full capture is here.
        </p>
      ) : null}
    </article>
  );
}
