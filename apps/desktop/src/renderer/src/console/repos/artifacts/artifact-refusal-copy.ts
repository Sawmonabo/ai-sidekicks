// The next move, per daemon refusal code, for every `artifact.*` refusal this family
// can receive.
//
// ONE TABLE FOR THE WHOLE NAMESPACE, and that is the point rather than a convenience.
// `Spec-023 §Console Design (Meridian)` rule 9 fixes what reaches the screen from the
// daemon — the code in mono, the message verbatim, never paraphrased — and leaves the
// two halves beside it to the caller: what the refusal is ABOUT where the code alone
// does not say, and what a person DOES about it. Written per call site, those halves
// are where a code's answer gets invented twice and the two copies drift; written once,
// a code has one answer wherever it surfaces. `repos/mounts/mount-refusal-copy.ts`
// states the same rule for the four `repo.*` / `workspace.*` / `worktree.*` /
// `clone.*` namespaces, and this module is that shape applied to the fifth.
//
// THE NAMESPACE IS ONE SET AND IS NOT SPLIT BY SURFACE. The thirteen codes below reach
// four surfaces — the manifest rows of `repos/artifacts/`, the payload section of
// `repos/artifact-pane/`, the ingest cards of `repos/attachments/`, and the bounds
// disclosure both the pane and the attach affordance render — and most of them reach
// more than one. This module is where the attachment family's own four-code table was
// folded in: a table per surface is three answers to one code and three places for a
// code the wire adds to go missing, which `apps/desktop/AGENTS.md` §Shared code rejects
// outright. `artifacts/` holds it because that directory owns the artifact's identity
// (`artifact-model.ts`, `artifact-copy.ts`), and a sibling directory inside `repos/`
// reaches it by its own specifier — the edge `artifact-pane/` already takes to
// `attachments/attachment-bounds.ts` in the other direction.
//
// WHAT IS DELIBERATELY NOT FOLDED IN: `attachments/attachment-policy.ts`'s
// `INGEST_DISPOSITION_COPY` is keyed on the DISPOSITION and not on a code — three
// entries, total over every code through `ingestRefusalDisposition` — and it is the
// sentence in front of the RETRY CONTROL rather than a reading of the refusal. Two
// different keys and two different claims, so it is not a second copy of this table.
// The one surface that renders both is `attachments/AttachmentCard.tsx`, and it renders
// the disposition's sentence INSTEAD OF this table's next move rather than after it, so
// a stream-invalid refusal is never told to start again twice.
//
// THE TWO HALVES ARE DIFFERENT CLAIMS. `meaning` is what the refusal is about where the
// daemon's own sentence deliberately leaves it out, and it is present only on the codes
// that need one — an absent `meaning` says the daemon's sentence is all of it, which is
// true of most of these. `nextMove` is what a PERSON does next, which is a different
// claim from what the daemon said happened, and four of them are the reason this module
// exists at all:
//
//   • `artifact.no_access_key` IS NOT AN AUTHENTICATION FAILURE and must not read as
//     one. `error-contracts.md §Artifact` states outright that the code is kept
//     distinct from `artifact.fetch_unauthorized` so a client can surface the remedy —
//     a publisher re-publish while online — instead of treating it as an auth problem.
//     Its three producers are unobservable to the refused node and share that one
//     remedy, so the entry names it and does not speculate about which of the three
//     this was.
//   • `artifact.fetch_unauthorized` is the mirror image: the caller already holds a
//     grant, so a re-publish remedies nothing and the move is elsewhere. The two codes
//     are one HTTP status apart and mean opposite things about what to do.
//   • `artifact.too_large` covers THREE enforcement points with three different moves,
//     and the daemon's own message says which. So the recovery enumerates all three
//     rather than picking one — the console cannot tell them apart from the code alone,
//     and the third is the one a person never guesses: a chunk pushing the running
//     spooled count past the stream's own Init-declared total refuses even when the
//     declaration sits far below the deployment's cap.
//   • `artifact.delete_blocked` names its own remedy in DATA rather than in prose: the
//     referencing manifests ride the refusal as a registered extension
//     (`core/refusal-extensions.ts`), so the entry says what to do with them and
//     `ArtifactRefusalRecovery.tsx` renders the list the daemon sent.
//
// WHAT IS DELIBERATELY ABSENT. There is no entry that offers to null a derivative's
// `subject`, to re-type quarantined bytes, or to retry a terminal ingest stream in
// place: the first is prohibited by the artifact spec, the second is what a quarantine
// exists to prevent, and the third is the exact distinction
// `artifact.ingest_stream_invalid` and `artifact.ingest_capacity_exhausted` are two
// codes to keep. A recovery naming any of the three would name a move nothing performs.
//
// THE LOOKUP TAKES A `string`, not the union. A refusal arrives off the wire and the
// console never asserts that a code it has not seen is one of these — an unlisted code
// answers `undefined` and renders with no next move beside it, which is the honest
// reading of a refusal this family has no move for.
//
// AND THE CODE IT IS ASKED ABOUT MAY BE ONE LAYER IN. Every call this family makes goes
// through `repos/growth-call.ts`, and a call that REJECTED rather than answering
// arrives as the port's own `call-rejected` with the daemon's refusal on `cause` —
// `bridge/growth-port/growth-outcome.ts` says so in as many words: "a consumer that must
// branch on the daemon's word branches on the second". A lookup that read only the
// outer code would therefore find nothing for every `artifact.*` refusal that reached
// this console over a real transport, which is the only way one reaches it at all
// today. {@link daemonSpokenRefusal} is that reading, written once here rather than at
// each of the three surfaces that render one.

import type { ExtendedConsoleRefusal } from "../../core/index.js";
import type { RefusalRecoveryCopy } from "../../primitives/index.js";

/**
 * A refusal as a surface receives it: possibly a seam refusal wrapping the daemon's.
 *
 * `cause` is OPTIONAL and typed as the extended shape because both producers satisfy
 * it — the port's `GrowthWireRefused` declares `cause?: undefined` and its
 * `GrowthCallRejected` declares the normalized daemon refusal — so a value from either
 * arm, and a bare `ConsoleRefusal` from anywhere else, is one of these unchanged.
 *
 * Declared here rather than imported from the bridge: what this family needs is the
 * one member it reads, and naming `GrowthUnavailable` would make every surface that
 * renders a refusal depend on the port's whole two-arm union to ask one question.
 */
export type ArtifactSurfaceRefusal = ExtendedConsoleRefusal & {
  readonly cause?: ExtendedConsoleRefusal | undefined;
};

/**
 * The refusal whose code the DAEMON spoke, which is not always the one that arrived.
 *
 * One level and never a walk: the port wraps at most once, and a loop here would be
 * chasing a nesting nothing produces. What comes back carries the registered
 * extensions too, which is what puts a blocked delete's referencing manifests within
 * reach of the surface that renders them.
 */
export function daemonSpokenRefusal(refusal: ArtifactSurfaceRefusal): ExtendedConsoleRefusal {
  return refusal.cause ?? refusal;
}

/**
 * Every `artifact.*` refusal code the console can receive.
 *
 * Transcribed from `docs/architecture/contracts/error-contracts.md` §Artifact, in that
 * table's own row order so a reader comparing the two reads them top to bottom. A tuple
 * rather than a count in prose, on the mounts table's rule: a number in a sentence is
 * not something a missing code can fail against.
 */
export const ARTIFACT_REFUSAL_CODES = [
  "artifact.not_found",
  "artifact.too_large",
  "artifact.too_many_attachments",
  "artifact.unsupported_media_type",
  "artifact.scanner_rejected",
  "artifact.ingest_capacity_exhausted",
  "artifact.ingest_stream_invalid",
  "artifact.hash_mismatch",
  "artifact.delete_blocked",
  "artifact.delete_forbidden",
  "artifact.relay_expired",
  "artifact.fetch_unauthorized",
  "artifact.no_access_key",
] as const;

/** One code this family has a next move for. Derived, so the vocabulary has one home. */
export type ArtifactRefusalCode = (typeof ARTIFACT_REFUSAL_CODES)[number];

/**
 * What a refusal is about, what a person does next, and the alternatives where there is
 * more than one.
 *
 * `meaning` is OPTIONAL and absent on most codes, which is the honest shape rather than
 * a gap: it exists for the codes whose daemon sentence deliberately leaves out which of
 * several enforcement points answered, what survived, or where the bytes went, and a
 * code whose sentence carries all of that needs no second one written for it.
 *
 * `distinctions` is a LIST rather than a second sentence because the cases it holds are
 * exclusive: the reader is choosing between them, and prose that ran them together
 * would read as a sequence of steps. An empty list is the ordinary shape — most codes
 * have exactly one move — and it is a real empty rather than an absent member, so a
 * renderer maps it without asking whether it is there.
 *
 * IT EXTENDS THE SHAPE THE SHELL RENDERS rather than restating its two members:
 * `primitives/RefusalRecovery.tsx` is what puts the move and the cases on screen, and a
 * table whose entry type merely happened to be assignable would stay assignable right
 * up to the rename that made it stop.
 */
export interface ArtifactRefusalRecovery extends RefusalRecoveryCopy {
  readonly meaning?: string | undefined;
}

const NO_DISTINCTIONS: readonly string[] = [];

/**
 * The table. Total over the codes above, so a code added to the tuple and not here
 * fails to compile rather than surfacing with no move.
 */
const ARTIFACT_REFUSAL_RECOVERIES: Readonly<Record<ArtifactRefusalCode, ArtifactRefusalRecovery>> =
  {
    "artifact.not_found": {
      nextMove:
        "This artifact is gone from the session. The list re-reads itself; a row still here after that is a disagreement between the list and the daemon.",
      distinctions: NO_DISTINCTIONS,
    },
    "artifact.too_large": {
      // THREE ENFORCEMENT POINTS, THREE MOVES, and the console cannot tell them apart
      // from the code: `error-contracts.md §Artifact` puts all three behind this one code
      // and the daemon's message says which. Enumerated rather than collapsed, because a
      // single "use a smaller file" sentence is wrong in two cases out of three — the
      // relay point is about a payload already ingested, and the reservation point fires
      // on a file well under the deployment's cap, which is the one a person never
      // guesses and the reason the third distinction states it in the copy itself.
      meaning:
        "Three different bounds answer with this one code — this deployment's ingest cap, the relay publish cap, and the total this upload declared when it opened, which the daemon holds as its spool reservation. The code alone does not say which; the daemon's own sentence above does.",
      nextMove: "Nothing was stored. Which of the three bounds it crossed decides the move:",
      distinctions: [
        "This deployment's ingest cap — what a single attachment may weigh. The attach affordance's own disclosure carries the effective figure, and where the console is showing its shipped default instead, an operator override replaces that figure wholesale: ask the operator what this deployment admits.",
        "The relay publish cap — the artifact exists locally and its bytes were too large to share, so it stays local-only until a smaller derivative is published in its place.",
        "This upload's own declared total — a chunk pushed the running count of spooled bytes past what the upload said it would send, which refuses even far below the deployment's cap, because the declaration is what reserved the spool. That spool is gone; start the upload again, the file itself is unchanged.",
      ],
    },
    "artifact.too_many_attachments": {
      // THE EARLIER ARTIFACTS SURVIVE, and saying so is the whole meaning: the carrier
      // is refused before any element is bound, and the artifacts earlier ingests minted
      // are untouched session artifacts. A recovery that read as "start over" would send
      // a person to re-upload files that are already here — which is why the next move
      // ends by saying that nothing has to be sent twice.
      meaning:
        "The whole carrier was refused at acceptance, before any attachment was bound or delivered, so nothing partial was left behind. Every artifact an earlier upload already minted is untouched and stays a session artifact you can reference again.",
      nextMove:
        "Take attachments off this turn until the carrier is inside the count, then send it, and send the rest on another turn. Nothing has to be uploaded a second time.",
      distinctions: NO_DISTINCTIONS,
    },
    "artifact.unsupported_media_type": {
      // NEVER "rename it". The verdict is on the payload's DERIVED type, so the
      // extension is not what was judged and changing it changes nothing.
      meaning:
        "The daemon read the bytes and the type it derived is not on this deployment's allow-list — or it contradicts the type the upload declared. The payload is quarantined rather than stored, and it is never silently re-typed to something that would have been admitted.",
      nextMove:
        "Renaming the file changes nothing, because the signature is what was read, so nothing about this file will make it through as it stands. Convert it to an admitted type and attach that, or ask the operator to widen the list; the attach affordance's own disclosure lists what is admitted here.",
      distinctions: NO_DISTINCTIONS,
    },
    "artifact.scanner_rejected": {
      // Distinct from the media-type code on purpose: the type was allow-listed and
      // reconciled before the scanner ran, so a type-shaped remedy would misdirect.
      meaning:
        "This is a content verdict from a scanner the operator configured, not a problem with the file's type: the type was allow-listed and reconciled before the scan ran. The bytes are quarantined. The shipped default configuration runs no scanner and never produces this.",
      nextMove:
        "A different file rather than a different name or format is the move, since the verdict is on the content. Where this file has to go through as it stands, take it up with whoever configured the scan — the console has nothing to add to the scanner's own verdict.",
      distinctions: NO_DISTINCTIONS,
    },
    "artifact.ingest_capacity_exhausted": {
      // TRANSIENT, and no stream state was created: no id was minted and no slot was
      // consumed, so the same upload is startable again with nothing to clean up.
      nextMove:
        "The daemon has too many uploads open right now. Nothing was created — no upload was opened and no space reserved — so this same file can be sent again once one of the others finishes.",
      distinctions: NO_DISTINCTIONS,
    },
    "artifact.ingest_stream_invalid": {
      // TERMINAL, and deliberately distinct from the code above: one asks the caller to
      // wait and this one asks them to restart. A recovery offering a retry in place
      // would collapse the two.
      nextMove:
        "This upload cannot continue and cannot be resumed where it stopped. Start it again from the beginning; the file itself is untouched.",
      distinctions: NO_DISTINCTIONS,
    },
    "artifact.hash_mismatch": {
      nextMove:
        "The bytes that arrived do not hash to what the manifest names, so nothing was stored or shown. Fetching again is what retries — a mismatch that repeats is the stored copy rather than the transfer.",
      distinctions: NO_DISTINCTIONS,
    },
    "artifact.delete_blocked": {
      // THE REMEDY IS THE DAEMON'S OWN, AND ITS DATA RIDES THE REFUSAL. The referencing
      // manifests arrive as a registered refusal extension, so this sentence names what
      // to do with a list the renderer already has rather than telling a person to go
      // looking for one. Nulling the derivative's `subject` is prohibited and is
      // therefore not offered here — it would turn a derivative into an apparent
      // original and destroy the provenance chain.
      nextMove:
        "Another manifest names this artifact as the source it was derived from, and that link is never severed to make a delete succeed. Delete the derivatives named below first, or keep the source. Nothing about this artifact changed.",
      distinctions: NO_DISTINCTIONS,
    },
    "artifact.delete_forbidden": {
      // Deliberately distinct from the code above: that one is referential integrity a
      // differently-ordered delete sequence remedies, and this one no delete order does.
      // The roles are stated because the permission matrix is public surface.
      nextMove:
        "This is a permission answer rather than an ordering one, so deleting something else first does not help. An owner may delete any artifact in the session and a collaborator only the ones they produced; the artifact, its payload references, and its bytes are all unchanged.",
      distinctions: NO_DISTINCTIONS,
    },
    "artifact.relay_expired": {
      // The manifest's own `replicationStatus` reads `expired` after this, which is where
      // the row's copy says the same thing; this is what a person DOES about it.
      nextMove:
        "The relay no longer holds these bytes, and this node's row now says so. The publisher re-publishing while online is what puts them back — nothing this node does reaches them in the meantime.",
      distinctions: NO_DISTINCTIONS,
    },
    "artifact.fetch_unauthorized": {
      // THE MIRROR IMAGE OF `no_access_key`, and the distinction is the whole entry: a
      // re-publish remedies nothing here, because the caller already holds a grant.
      nextMove:
        "The fetch itself was refused rather than the key being missing, so a re-publish would not help. Re-attaching this node to the session is the move the daemon's own message points at where it names an attachment.",
      distinctions: NO_DISTINCTIONS,
    },
    "artifact.no_access_key": {
      // NOT AN AUTHENTICATION FAILURE, and the copy must not read as one. The three
      // producers — joining after the publish, the blob having gone, a thumbprint
      // collision dropped fail-closed — are unobservable from here and share one remedy,
      // so the entry names the remedy and does not guess which case this is.
      nextMove:
        "You are a member of this session and nothing is wrong with your sign-in — this node simply holds no key for these bytes, which is what a late join looks like. The publisher re-publishing while online is what shares them with this node.",
      distinctions: NO_DISTINCTIONS,
    },
  };

/**
 * The next move for one refusal code, or `undefined` where this family has none.
 *
 * `Object.hasOwn` rather than a bare index, on the mounts table's rule: a code off the
 * wire spelling `toString` would otherwise answer with a function this console would
 * then try to render.
 */
export function artifactRefusalRecovery(code: string): ArtifactRefusalRecovery | undefined {
  return Object.hasOwn(ARTIFACT_REFUSAL_RECOVERIES, code)
    ? ARTIFACT_REFUSAL_RECOVERIES[code as ArtifactRefusalCode]
    : undefined;
}

/** The code a carrier past the count bound is refused with, named once. */
export const TOO_MANY_ATTACHMENTS_CODE = "artifact.too_many_attachments";

/** The code an over-sized payload is refused with, named once. */
export const TOO_LARGE_CODE = "artifact.too_large";
