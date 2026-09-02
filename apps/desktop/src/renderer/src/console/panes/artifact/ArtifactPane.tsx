// The artifact pane: what this session produced, whether its bytes are reachable, and
// what a participant may attempt on one.
//
// THE ARTIFACT SURFACE'S COMPOSITION IS THIS FAMILY'S, because `Spec-023 §Console
// Design (Meridian)` puts a surface's composition — what it renders, offers, refuses,
// and folds — in the console's code. The pane is the DECK's view of the artifact
// list; the sidebar panel
// beside it in `repos/ArtifactsPanel.tsx` is the same rows in a narrower column. One
// body renders both, which is what keeps the diff pane a view onto this list rather
// than a second store.
//
// THREE THINGS THIS PANE DOES NOT DO, each of them this family's own Never:
//
//   • IT NEVER RENDERS A PAYLOAD. Not as markup, not as text, not behind a toggle.
//     Payloads are explicit-fetch downloads with no in-product execution surface, and
//     `image/svg+xml` is absent from the default allow-list precisely because it is the
//     one image type that is also a scriptable document. There is no element in this
//     file that could hold one, so a preview failure has nothing to degrade FROM.
//   • IT NEVER DECIDES WHO MAY ACT. `artifact.delete_forbidden` is a 403 the daemon
//     returns against the session roles. Every control is offered and the daemon's
//     typed refusal renders beside the one that was pressed.
//   • IT OFFERS NO VISIBILITY TOGGLE. The wire carries an `artifact.visibility_updated`
//     event and `bridge/growth-port.ts`
//     registers no operation that could produce one — the port has `artifactRead`
//     and `artifactDelete`
//     and nothing that re-classifies. A control that could only fail is worse than a
//     control that is not there, and a port entry is not this family's to add, so the
//     act stays unoffered and the gap is the `artifact-ingest-and-crud` slate row.
//
// AND ONE THING IT NOW SAYS OUT LOUD. The row's read control used to be named for a
// payload fetch, and the read behind it serves a MANIFEST: `artifactRead` answers one
// `GrowthArtifactSummary`, and the port registers neither the `includePayload` request
// member nor the `payloadHandle` / `payload` / `payloadEncoding` reply members the
// wire's own read carries (`api-payload-contracts.md §Plan-014`). A control named for
// bytes it cannot obtain is a lie the participant only discovers by pressing it, so
// the control is named for what the read serves and the header says, once, what a
// payload fetch is waiting on.
//
// WHAT THE FOOT OF THE PANE IS FOR. The effective allow-list and the ingest
// bounds otherwise sit behind the attach affordance's own disclosure, and the composer
// owns that affordance. This pane is where the same facts are readable without one, because they
// are the artifact plane's rules and a participant who has just been refused for an
// unsupported type needs somewhere to read what IS supported.

import { useCallback, useId, useMemo } from "react";

import {
  ATTACHMENTS_PER_CARRIER_CAP_DEFAULT,
  ATTACHMENT_CHUNK_BYTE_CAP,
} from "../../core/index.js";
import {
  Chip,
  DerivedFigure,
  Glyph,
  WireFigure,
  formatByteQuantity,
  useAnnounce,
} from "../../primitives/index.js";
import { ArtifactsPanel } from "../../repos/ArtifactsPanel.js";
import type { ArtifactManifestRow } from "../../repos/artifact-model.js";
import { type ConsolePaneContext } from "../../seats/index.js";
import type { ArtifactAllowlistReading, ArtifactRowActOutcome } from "./artifact-pane-reading.js";
import { useArtifactPaneReading } from "./artifact-reader.js";

/** What a settled act says, once, when it settles. A refusal speaks in its own words. */
const MANIFEST_RE_READ_ANNOUNCEMENT = "Manifest re-read. The row shows what the read answered.";

/**
 * What a settled delete says.
 *
 * It names what came back and what did not. The design wants the payload disposition
 * reported after the act, and the reply this console can make carries no member for it
 * — so the sentence says the manifest is gone and says the rest is unreported, rather
 * than claiming bytes were reclaimed on no evidence at all.
 */
const ARTIFACT_DELETED_ANNOUNCEMENT =
  "Artifact deleted and the list read again. The reply carries no payload disposition, so what became of the bytes is not reported.";

/**
 * This body's own address arm, narrowed off the union the deck hands every pane.
 *
 * `ConsolePaneContext` is a discriminated union over the pane kind, so a body typed on
 * the whole union can read an entity of a kind it cannot render — a run reference, say,
 * looked up in a partition that has never held one. Narrowing here is what makes
 * `entity` required and its kind `artifact`, by the compiler rather than by this file
 * remembering.
 */
type ArtifactPaneContext = Extract<ConsolePaneContext, { readonly kind: "artifact" }>;

export interface ArtifactPaneProps {
  readonly context: ArtifactPaneContext;
}

export function ArtifactPane(props: ArtifactPaneProps): React.JSX.Element {
  const { context } = props;
  const headingId = useId();
  const announce = useAnnounce();
  const { reading, refresh, readManifest, deleteArtifact } = useArtifactPaneReading(
    context.bridge,
    context.sessionStore?.sessionId,
  );

  // The instant the rows were rendered against. It moves when the reading moves and on
  // no other occasion — an age that advanced on a timer would be the interval poll the
  // budget forbids, wearing a clock face.
  const nowMilliseconds = useMemo(() => Date.now(), [reading]);

  // Announced from the act's own settlement and from nowhere else. A re-render
  // announces nothing, because nothing settled.
  const announceOutcome = useCallback(
    (outcome: ArtifactRowActOutcome, settledSentence: string) => {
      // `reconciling` speaks in the settled sentence because that sentence is true of
      // it: the act was served, the reader applied it, and the list is being read
      // again. What the two arms disagree about is whether a refresh was already in
      // flight underneath — which is the reader's business and not the participant's.
      // Only `superseded` stays silent, because on that arm nothing happened at all.
      if (outcome.status === "settled" || outcome.status === "reconciling") {
        announce(settledSentence);
        return;
      }
      if (outcome.status === "refused") {
        announce(outcome.refusal.detail);
      }
    },
    [announce],
  );

  const readRowManifest = useCallback(
    (row: ArtifactManifestRow) => {
      void readManifest(row.id).then((outcome) => {
        announceOutcome(outcome, MANIFEST_RE_READ_ANNOUNCEMENT);
      });
    },
    [announceOutcome, readManifest],
  );

  const deleteRow = useCallback(
    (row: ArtifactManifestRow) => {
      void deleteArtifact(row.id).then((outcome) => {
        announceOutcome(outcome, ARTIFACT_DELETED_ANNOUNCEMENT);
      });
    },
    [announceOutcome, deleteArtifact],
  );

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
        {/*
          Unconditional: an artifact address carries its artifact, so the arm this body
          is narrowed to has no shape in which the subject is absent.
        */}
        <span
          className="meridian-repos-pane__subject"
          title={context.entity.id}
          aria-label={`Subject: ${context.entity.kind} ${context.entity.id}`}
        >
          {context.entity.id}
        </span>
        <div className="meridian-artifact-pane__read-scope">
          <button type="button" className="meridian-repos-pane__control" onClick={refresh}>
            Read again
          </button>
          <p className="meridian-artifact-pane__read-scope-note">
            Reads serve the manifest. Fetching an artifact&rsquo;s bytes waits on the read
            reply&rsquo;s <WireFigure value="payloadHandle" /> and <WireFigure value="payload" />{" "}
            members, which this console&rsquo;s read does not carry.
          </p>
        </div>
      </header>
      <div className="meridian-repos-pane__body">
        <ArtifactsPanel
          state={reading.artifacts}
          nowMilliseconds={nowMilliseconds}
          rowRefusals={reading.refusalByArtifactId}
          onReadManifest={readRowManifest}
          onDelete={deleteRow}
        />
        {renderIngestBounds(reading.allowlist)}
      </div>
    </section>
  );
}

/**
 * The ingest rules, one disclosure away.
 *
 * A render helper rather than a component, on `ArtifactsPanel.tsx`'s rule: it holds no
 * state and takes no hooks, so mounting it as an element type would buy a
 * reconciliation boundary nothing needs.
 *
 * THE SOURCE IS NAMED, ALWAYS. `Spec-014 §Bounds (normative defaults; operator-tunable)`
 * makes an operator override replace the list WHOLESALE with no merge semantics, so a
 * hint that showed a list without saying whether it is the deployment's or the shipped
 * default would be a hint about a deployment the console cannot see. The
 * `shipped-default` arm additionally carries the refusal that kept the effective read
 * from answering.
 */
function renderIngestBounds(allowlist: ArtifactAllowlistReading): React.JSX.Element {
  const maximumFigure = formatByteQuantity(allowlist.maximumByteLength);
  const chunkFigure = formatByteQuantity(ATTACHMENT_CHUNK_BYTE_CAP);
  return (
    <details className="meridian-ingest-bounds">
      <summary className="meridian-ingest-bounds__summary">
        What can be attached, and how much
      </summary>
      <p className="meridian-ingest-bounds__source">
        {allowlist.source === "effective"
          ? "This deployment's effective allow-list, as the daemon reports it."
          : "The shipped default. This deployment's effective list could not be read, and an operator override replaces the default wholesale rather than adding to it — so what is admitted here may differ."}
      </p>
      {allowlist.refusal === undefined ? null : (
        <p className="meridian-ingest-bounds__refusal">
          <WireFigure value={allowlist.refusal.code} /> {allowlist.refusal.detail}
        </p>
      )}
      <ul className="meridian-ingest-bounds__types">
        {allowlist.mediaTypes.map((mediaType) => (
          <li key={mediaType}>
            <Chip label={mediaType} mono />
          </li>
        ))}
      </ul>
      <dl className="meridian-ingest-bounds__caps">
        <div className="meridian-ingest-bounds__cap">
          <dt>Per attachment</dt>
          <dd>
            <WireFigure value={maximumFigure.text} title={String(allowlist.maximumByteLength)} />
          </dd>
        </div>
        <div className="meridian-ingest-bounds__cap">
          <dt>Per carrier</dt>
          <dd>
            <DerivedFigure text={`${String(ATTACHMENTS_PER_CARRIER_CAP_DEFAULT)} attachments`} />
          </dd>
        </div>
        <div className="meridian-ingest-bounds__cap">
          <dt>Per chunk</dt>
          <dd>
            <WireFigure value={chunkFigure.text} title={String(ATTACHMENT_CHUNK_BYTE_CAP)} />
          </dd>
        </div>
        <div className="meridian-ingest-bounds__cap">
          <dt>Per upload</dt>
          <dd>
            <DerivedFigure text="six hours from the moment the stream opens" />
          </dd>
        </div>
      </dl>
    </details>
  );
}
