// The artifact pane: what this session produced, whether its bytes are reachable, and
// what a participant may attempt on one.
//
// `Spec-023 §Console Design (Meridian)` §10.4 and, for the bounds disclosure at the
// foot, §10.8. The pane is the DECK's view of the artifact list; the sidebar panel
// beside it in `repos/ArtifactsPanel.tsx` is the same rows in a narrower column. One
// body renders both, which is what keeps the diff pane a view onto this list rather
// than a second store.
//
// THREE THINGS THIS PANE DOES NOT DO, each because §10.4 says so:
//
//   • IT NEVER RENDERS A PAYLOAD. Not as markup, not as text, not behind a toggle.
//     Payloads are explicit-fetch downloads with no in-product execution surface, and
//     `image/svg+xml` is absent from the default allow-list precisely because it is the
//     one image type that is also a scriptable document. There is no element in this
//     file that could hold one, so a preview failure has nothing to degrade FROM.
//   • IT NEVER DECIDES WHO MAY ACT. `artifact.delete_forbidden` is a 403 the daemon
//     returns against the session roles. Every control is offered and the daemon's
//     typed refusal renders beside the one that was pressed.
//   • IT OFFERS NO VISIBILITY TOGGLE. §10.4 names one, and `bridge/growth-port.ts`
//     registers no operation for it — the port has `artifactRead` and `artifactDelete`
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
// WHAT THE FOOT OF THE PANE IS FOR. §10.8 puts the effective allow-list and the ingest
// bounds behind the attach affordance's own disclosure, and the composer owns that
// affordance. This pane is where the same facts are readable without one, because they
// are the artifact plane's rules and a participant who has just been refused for an
// unsupported type needs somewhere to read what IS supported.

import { useCallback, useId, useMemo } from "react";

import {
  Chip,
  DerivedFigure,
  Glyph,
  WireFigure,
  formatByteQuantity,
  useAnnounce,
} from "../../primitives/index.js";
import { ArtifactsPanel } from "../../repos/ArtifactsPanel.js";
import {
  ATTACHMENTS_PER_CARRIER_CAP_DEFAULT,
  ATTACHMENT_CHUNK_BYTE_CAP,
} from "../../repos/attachment-model.js";
import type { ArtifactManifestRow } from "../../repos/artifact-model.js";
import { type ConsolePaneContext } from "../../workspace/index.js";
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

export interface ArtifactPaneProps {
  readonly context: ConsolePaneContext;
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
      if (outcome.status === "settled") {
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
        {context.entity === undefined ? null : (
          <span
            className="meridian-repos-pane__subject"
            title={context.entity.id}
            aria-label={`Subject: ${context.entity.kind} ${context.entity.id}`}
          >
            {context.entity.id}
          </span>
        )}
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
