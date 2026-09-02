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
// WHAT THE FOOT OF THE PANE IS FOR. §10.8 puts the effective allow-list and the ingest
// bounds behind the attach affordance's own disclosure, and the composer owns that
// affordance. This pane is where the same facts are readable without one, because they
// are the artifact plane's rules and a participant who has just been refused for an
// unsupported type needs somewhere to read what IS supported.

import { useCallback, useId, useMemo, useState } from "react";

import type { ConsoleRefusal } from "../../core/index.js";
import {
  Chip,
  DerivedFigure,
  Glyph,
  WireFigure,
  formatByteQuantity,
} from "../../primitives/index.js";
import { ArtifactsPanel } from "../../repos/ArtifactsPanel.js";
import {
  ATTACHMENTS_PER_CARRIER_CAP_DEFAULT,
  ATTACHMENT_CHUNK_BYTE_CAP,
} from "../../repos/attachment-model.js";
import type { ArtifactManifestRow } from "../../repos/artifact-model.js";
import { type ConsolePaneContext } from "../../workspace/index.js";
import { useArtifactPaneReading, type ArtifactAllowlistReading } from "./artifact-reader.js";

export interface ArtifactPaneProps {
  readonly context: ConsolePaneContext;
}

export function ArtifactPane(props: ArtifactPaneProps): React.JSX.Element {
  const { context } = props;
  const headingId = useId();
  const { reading, refresh } = useArtifactPaneReading(
    context.bridge,
    context.sessionStore?.sessionId,
  );
  const [rowRefusals, setRowRefusals] = useState<ReadonlyMap<string, ConsoleRefusal>>(
    () => new Map(),
  );

  // The instant the rows were rendered against. It moves when the reading moves and on
  // no other occasion — an age that advanced on a timer would be the interval poll the
  // budget forbids, wearing a clock face.
  const nowMilliseconds = useMemo(() => Date.now(), [reading]);

  const recordRowRefusal = useCallback((artifactId: string, refusal: ConsoleRefusal) => {
    setRowRefusals((previous) => new Map(previous).set(artifactId, refusal));
  }, []);

  const fetchPayload = useCallback(
    (row: ArtifactManifestRow) => {
      void context.bridge.growth.artifactRead({ artifactId: row.id }).then((answer) => {
        if (answer.status === "unavailable") {
          recordRowRefusal(row.id, answer);
        }
      });
    },
    [context.bridge, recordRowRefusal],
  );

  const deleteArtifact = useCallback(
    (row: ArtifactManifestRow) => {
      void context.bridge.growth.artifactDelete({ artifactId: row.id }).then((answer) => {
        if (answer.status === "unavailable") {
          recordRowRefusal(row.id, answer);
        }
      });
    },
    [context.bridge, recordRowRefusal],
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
        <button type="button" className="meridian-repos-pane__control" onClick={refresh}>
          Read again
        </button>
      </header>
      <div className="meridian-repos-pane__body">
        <ArtifactsPanel
          state={reading.artifacts}
          nowMilliseconds={nowMilliseconds}
          rowRefusals={rowRefusals}
          onFetchPayload={fetchPayload}
          onDelete={deleteArtifact}
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
