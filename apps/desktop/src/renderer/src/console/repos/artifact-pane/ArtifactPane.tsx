// The artifact pane: what this session produced, whether its bytes are reachable, and
// what a participant may attempt on one.
//
// THE PANE'S FRAME IS NOT THIS MODULE'S. `seats/ConsolePaneChrome` draws the section,
// the kind glyph, the breadcrumb, the control strip, and the body box for every pane
// kind in the console; what this file returns is the BODY that goes inside it, plus the
// two acts it hands the chrome's `actions` slot. The section, its tab stop, its
// accessible name, and the actor's hue all arrive from there.
//
// THE ARTIFACT SURFACE'S COMPOSITION IS THIS FAMILY'S, because `Spec-023 §Console
// Design (Meridian)` puts a surface's composition — what it renders, offers, refuses,
// and folds — in the console's code. The pane is the DECK's view of the artifact
// list; the sidebar panel
// beside it in `repos/artifacts/ArtifactsPanel.tsx` is the same rows in a narrower column. One
// body renders both, which is what keeps the diff pane a view onto this list rather
// than a second store.
//
// THREE THINGS THIS PANE DOES NOT DO, each of them this family's own Never:
//
//   • IT NEVER INTERPRETS A PAYLOAD. Not as markup, not as a document, not as
//     anything a browser executes. Payloads are explicit-fetch downloads with no
//     in-product execution surface, and `image/svg+xml` is absent from the default
//     allow-list precisely because it is the one image type that is also a scriptable
//     document. What the pane draws is a BOUNDED TEXT preview and nothing else — the
//     decoded bytes inside a text node React escapes, capped at
//     `ARTIFACT_PAYLOAD_PREVIEW_CHARACTER_CAP` characters, with the truncation stated
//     — and bytes that are not UTF-8 are reported as what they are rather than drawn
//     as replacement characters. There is no element in this file that can hold a
//     payload as anything but text.
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
// AND ONE ACT THE SHAPE NOW ADMITS. The pane used to offer a manifest re-read and say
// that payload members were unavailable, which was true of the port it was written
// against and stopped being true: `bridge/growth-signatures/artifacts.ts` declares
// `includePayload` on the request, and `GrowthArtifactRead` carries either inline
// `payload` beside its `payloadEncoding` or a required deferred `payloadHandle`. So a
// served read could never reach the explicit fetch the registered shape supports, and
// the control that would have reached it did not exist. It does now — one control,
// pressed on purpose, never on mount — and BOTH served arms are drawn: inline bytes
// become the bounded text preview above, and a deferred handle is drawn as what it is,
// with the fetch that would redeem it refusing as not checked, because no verb
// anywhere in the corpus takes a payload handle. Naming the handle and stopping there
// is the honest end of the act; inventing a fetch verb for it would not be.
//
// WHAT THE FOOT OF THE PANE IS FOR. The effective allow-list and the ingest
// bounds otherwise sit behind the attach affordance's own disclosure, and the composer
// owns that affordance. This pane is where the same facts are readable without one, because they
// are the artifact plane's rules and a participant who has just been refused for an
// unsupported type needs somewhere to read what IS supported.

import { useCallback } from "react";

import {
  ATTACHMENTS_PER_CARRIER_CAP_DEFAULT,
  ATTACHMENT_CHUNK_BYTE_CAP,
} from "../../core/index.js";
import {
  Chip,
  DerivedFigure,
  WireFigure,
  formatByteQuantity,
  useAnnounce,
} from "../../primitives/index.js";
import type { ArtifactManifestRow } from "../artifacts/artifact-model.js";
import { ArtifactsPanel } from "../artifacts/ArtifactsPanel.js";
import { ConsolePaneChrome, type PaneContextOf } from "../../seats/index.js";
import {
  MANIFEST_RE_READ_ANNOUNCEMENT,
  PAYLOAD_ANNOUNCEMENT_BY_STATUS,
  artifactDeletedAnnouncement,
} from "./artifact-announcements.js";
import { ArtifactPayloadSection } from "./ArtifactPayloadSection.js";
import type { ArtifactAllowlistReading, ArtifactRowActOutcome } from "./artifact-pane-reading.js";
import { useArtifactPaneReading } from "./use-artifact-reading.js";

/**
 * This body's own address arm, narrowed off the union the deck hands every pane.
 *
 * `PaneContextOf` is the seat's own narrowing rather than a second `Extract` written
 * here: one registry holds every kind and a body does not, so the narrowing is stated
 * once where the chrome states it. It is what makes `entity` required and its kind
 * `artifact`, by the compiler rather than by this file remembering — a body typed on
 * the whole union could read a run reference looked up in a partition that has never
 * held one.
 */
type ArtifactPaneContext = PaneContextOf<"artifact">;

export interface ArtifactPaneProps {
  readonly context: ArtifactPaneContext;
}

export function ArtifactPane(props: ArtifactPaneProps): React.JSX.Element {
  const { context } = props;
  const announce = useAnnounce();
  const { reading, refresh, readManifest, fetchPayload, deleteArtifact } = useArtifactPaneReading(
    context.bridge,
    // The STORE, not its id: the reader observes this session's artifact frames and
    // its repair edge for three of its four refresh reasons, and an id carries
    // neither.
    context.sessionStore,
    // The subject, because the reader's payload arm and fetch register are about this
    // artifact and nothing else. A deck that reuses this pane for another one gets a
    // reader of its own rather than the previous subject's bytes under this header.
    context.entity.id,
  );

  // Announced from the act's own settlement and from nowhere else. A re-render
  // announces nothing, because nothing settled.
  const announceOutcome = useCallback(
    (outcome: ArtifactRowActOutcome, settledSentence: string | undefined) => {
      // `reconciling` speaks in the settled sentence because that sentence is true of
      // it: the act was served, the reader applied it, and the list is being read
      // again. What the two arms disagree about is whether a refresh was already in
      // flight underneath — which is the reader's business and not the participant's.
      // Only `superseded` stays silent, because on that arm nothing happened at all.
      if (outcome.status === "settled" || outcome.status === "reconciling") {
        // ABSENT means the arm has nothing to say, which is not the same as saying
        // nothing happened — a served fetch that came back on an arm no announcement
        // covers is silent rather than announced as an empty sentence.
        if (settledSentence !== undefined) {
          announce(settledSentence);
        }
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
        // The sentence is built from THIS delete's receipt, so the arm that carries
        // one is the arm that supplies it and the silent arms need none.
        announceOutcome(
          outcome,
          outcome.status === "settled" || outcome.status === "reconciling"
            ? artifactDeletedAnnouncement(outcome.receipt)
            : undefined,
        );
      });
    },
    [announceOutcome, deleteArtifact],
  );

  // The pane's subject is one artifact, so the fetch is for that one. A control per
  // row would offer a hundred-megabyte download beside every manifest in the list.
  const fetchSubjectPayload = useCallback(() => {
    void fetchPayload(context.entity.id).then((outcome) => {
      announceOutcome(
        outcome,
        outcome.status === "settled"
          ? PAYLOAD_ANNOUNCEMENT_BY_STATUS[outcome.payload.status]
          : undefined,
      );
    });
  }, [announceOutcome, context.entity.id, fetchPayload]);

  return (
    // THE FRAME IS THE CHROME'S AND THE BODY IS THIS FILE'S. `seats/ConsolePaneChrome`
    // draws the section, its tab stop, the kind glyph, the breadcrumb that names the
    // pane, the control strip, and the body box — so none of them is written here and
    // the pane is named by its whole address trail rather than by the word "Artifact".
    // The two acts ride the chrome's `actions` slot, which is where a kind's own
    // controls sit; the host's close and detach arrive after them, from the deck's
    // context, and neither renders where no deck provides one.
    <ConsolePaneChrome
      kind="artifact"
      sessionId={context.sessionStore?.sessionId}
      // Unconditional: an artifact address carries its artifact, so the arm this body
      // is narrowed to has no shape in which the subject is absent. The trail renders
      // the id, which is what the pane's own subject line used to say.
      entity={context.entity}
      // Straight through, including the absent arm: an unattributed pane sets no hue
      // and the chrome's neutral fallback applies.
      focusHue={context.focusHue}
      actions={
        // Their own group inside the strip, because a control with a neighbour has to
        // be at least a 24 px target and separated from it — the sizing the family's
        // own sheet gives them, since every other pane draws icon controls at the
        // chrome's size and would gain the padding for nothing.
        <span className="meridian-artifact-pane__acts">
          <button type="button" className="meridian-artifact-pane__act" onClick={refresh}>
            Read again
          </button>
          <button
            type="button"
            className="meridian-artifact-pane__act"
            onClick={fetchSubjectPayload}
            // HELD WHILE A FETCH IS OUTSTANDING, and the arm the reading is on is
            // what holds it — there is no second flag to keep in step. A payload is
            // bounded only by the ingest cap, so a second press before the first
            // settles is a second download of the same bytes; the reader refuses it
            // in words, and this is what keeps a participant from meeting that
            // refusal by pressing a control the pane was offering.
            disabled={reading.payload.status === "fetching"}
          >
            Fetch payload
          </button>
        </span>
      }
    >
      <div className="meridian-artifact-pane">
        {/*
          What the two acts ask for, said at the top of the body rather than under
          them. The chrome's control strip is one line of controls and takes no prose,
          so the sentence sits where the reply it describes will land.
        */}
        <p className="meridian-artifact-pane__read-scope-note">
          Reading serves the manifest. Fetching asks the same read for this artifact&rsquo;s{" "}
          <WireFigure value="payload" /> as well, which a payload large enough is answered with a{" "}
          <WireFigure value="payloadHandle" /> instead.
        </p>
        <ArtifactPayloadSection payload={reading.payload} />
        <ArtifactsPanel
          state={reading.artifacts}
          // The instant the READER took, off the window's own clock — never one this
          // body reads. A render body reaching `Date.now()` moves an age on any
          // unrelated re-render, and under the fixture it moves against wall time
          // while the scenario advances on frozen time.
          nowMilliseconds={reading.readAtMilliseconds}
          rowRefusals={reading.refusalByArtifactId}
          manifestReadInFlightArtifactIds={reading.manifestReadInFlightArtifactIds}
          lastDeleteReceipt={reading.lastDeleteReceipt}
          onReadManifest={readRowManifest}
          onDelete={deleteRow}
        />
        {renderIngestBounds(reading.allowlist)}
      </div>
    </ConsolePaneChrome>
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
