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
// against and stopped being true: `bridge/growth-signatures.ts` declares
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

import { useCallback, useId, useMemo } from "react";

import {
  ARTIFACT_PAYLOAD_PREVIEW_CHARACTER_CAP,
  ATTACHMENTS_PER_CARRIER_CAP_DEFAULT,
  ATTACHMENT_CHUNK_BYTE_CAP,
} from "../../core/index.js";
import {
  Chip,
  DerivedFigure,
  Glyph,
  Nothing,
  RefusalCard,
  WireFigure,
  formatByteQuantity,
  useAnnounce,
} from "../../primitives/index.js";
import { ArtifactsPanel } from "../../repos/ArtifactsPanel.js";
import {
  artifactDeleteReceiptSentence,
  type ArtifactDeleteReceipt,
  type ArtifactManifestRow,
} from "../../repos/artifact-model.js";
import { type ConsolePaneContext } from "../../seats/index.js";
import type { ArtifactAllowlistReading, ArtifactRowActOutcome } from "./artifact-pane-reading.js";
import type { ArtifactPayloadReading } from "./artifact-payload.js";
import { useArtifactPaneReading } from "./use-artifact-reading.js";

/** What a settled act says, once, when it settles. A refusal speaks in its own words. */
const MANIFEST_RE_READ_ANNOUNCEMENT = "Manifest re-read. The row shows what the read answered.";

/**
 * What a settled delete says: the daemon's own two facts, in the daemon's own words.
 *
 * The sentence is composed by `repos/artifact-model.ts` and is the SAME one the panel
 * draws in its receipt strip, so the announcement and the screen cannot disagree about
 * what became of the bytes. Both used to say the reply reported nothing, which was
 * true of a `void` reply and is not true of a receipt.
 */
function artifactDeletedAnnouncement(receipt: ArtifactDeleteReceipt): string {
  return `Artifact deleted and the list read again. ${artifactDeleteReceiptSentence(receipt)}`;
}

/** What each settled payload fetch says. Total over the arms a served fetch can reach. */
const PAYLOAD_ANNOUNCEMENT_BY_STATUS: Readonly<
  Record<ArtifactPayloadReading["status"], string | undefined>
> = {
  // Neither is reachable from a settled fetch: `not-checked` is where the pane starts
  // and `refused` speaks in the refusal's own words through the announcer below.
  "not-checked": undefined,
  fetching: undefined,
  refused: undefined,
  deferred:
    "The read answered with a payload handle rather than the bytes. No registered operation fetches by one.",
  text: "Payload fetched. The preview shows the beginning of it.",
  opaque: "Payload fetched. Its bytes are not text, so there is nothing to preview.",
};

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
  const { reading, refresh, readManifest, fetchPayload, deleteArtifact } = useArtifactPaneReading(
    context.bridge,
    // The STORE, not its id: the reader observes this session's artifact frames and
    // its repair edge for three of its four refresh reasons, and an id carries
    // neither.
    context.sessionStore,
  );

  // The instant the rows were rendered against. It moves when the reading moves and on
  // no other occasion — an age that advanced on a timer would be the interval poll the
  // budget forbids, wearing a clock face.
  const nowMilliseconds = useMemo(() => Date.now(), [reading]);

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
          {/*
            The two controls share a row of their own. Side by side they are two
            adjacent pointer targets, so the row is what gives them the size and the
            separation the accessibility tier requires of any target that has a
            neighbour — which a single control never had.
          */}
          <div className="meridian-artifact-pane__read-actions">
            <button type="button" className="meridian-repos-pane__control" onClick={refresh}>
              Read again
            </button>
            <button
              type="button"
              className="meridian-repos-pane__control"
              onClick={fetchSubjectPayload}
            >
              Fetch payload
            </button>
          </div>
          <p className="meridian-artifact-pane__read-scope-note">
            Reading serves the manifest. Fetching asks the same read for this artifact&rsquo;s{" "}
            <WireFigure value="payload" /> as well, which a payload large enough is answered with a{" "}
            <WireFigure value="payloadHandle" /> instead.
          </p>
        </div>
      </header>
      <div className="meridian-repos-pane__body">
        {renderPayload(reading.payload)}
        <ArtifactsPanel
          state={reading.artifacts}
          nowMilliseconds={nowMilliseconds}
          rowRefusals={reading.refusalByArtifactId}
          lastDeleteReceipt={reading.lastDeleteReceipt}
          onReadManifest={readRowManifest}
          onDelete={deleteRow}
        />
        {renderIngestBounds(reading.allowlist)}
      </div>
    </section>
  );
}

/**
 * What the payload fetch established, on whichever of its six arms it is.
 *
 * A render helper on this file's own rule: it holds no state and takes no hooks.
 *
 * THE PREVIEW IS TEXT, AND ONLY TEXT. The decoded bytes go into a `<pre>` as a text
 * node React escapes, bounded before they get here, with the truncation stated beside
 * them. Nothing in this function can interpret a payload: there is no `dangerously`
 * anything, no `src`, no `href`, and no element that a media type could turn into a
 * document.
 */
function renderPayload(payload: ArtifactPayloadReading): React.JSX.Element | null {
  if (payload.status === "not-checked") {
    return null;
  }
  return (
    <section className="meridian-artifact-payload" aria-label="Fetched payload">
      {renderPayloadArm(payload)}
    </section>
  );
}

/** The one arm's own body. Total over the five arms a rendered payload can be on. */
function renderPayloadArm(payload: ArtifactPayloadReading): React.JSX.Element | null {
  switch (payload.status) {
    case "not-checked":
      return null;
    case "fetching":
      return <Nothing kind="not-loaded" placement="inline" title="Fetching this payload" />;
    case "refused":
      return <RefusalCard code={payload.refusal.code} detail={payload.refusal.detail} />;
    case "deferred":
      return (
        <>
          <p className="meridian-artifact-payload__note">
            The read answered with a handle rather than the bytes. It is the content-addressed key
            the payload is stored under, and no registered operation anywhere takes one — so the
            bytes are named here and not checked for.
          </p>
          <WireFigure value={payload.payloadHandle} />
        </>
      );
    case "opaque":
      return (
        <p className="meridian-artifact-payload__note">
          {payload.reason === "not-utf8"
            ? "These bytes are not text, so there is nothing to preview. They arrived whole and are unchanged."
            : "These bytes did not decode under the encoding the reply declared, so there is nothing to preview."}{" "}
          <WireFigure value={payload.encoding} />
        </p>
      );
    case "text":
      return (
        <>
          <p className="meridian-artifact-payload__note">
            {payload.truncated
              ? `The first ${String(ARTIFACT_PAYLOAD_PREVIEW_CHARACTER_CAP)} characters. The payload continues past them.`
              : "The whole payload."}{" "}
            <WireFigure value={payload.encoding} />
          </p>
          <pre className="meridian-artifact-payload__preview">{payload.text}</pre>
        </>
      );
  }
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
