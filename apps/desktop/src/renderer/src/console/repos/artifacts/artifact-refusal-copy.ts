// The next move, per daemon refusal code, for every `artifact.*` refusal this family
// can receive.
//
// ONE TABLE FOR THE WHOLE NAMESPACE, and that is the point rather than a convenience.
// `Spec-023 §Console Design (Meridian)` rule 9 fixes what reaches the screen from the
// daemon — the code in mono, the message verbatim, never paraphrased — and leaves the
// NEXT MOVE to the caller as a slot. Written per call site, that slot is where a code's
// recovery gets invented twice and the two copies drift; written once, a code has one
// answer wherever it surfaces. `repos/mounts/mount-refusal-copy.ts` states the same
// rule for the four `repo.*` / `workspace.*` / `worktree.*` / `clone.*` namespaces, and
// this module is that shape applied to the fifth.
//
// THE NAMESPACE IS ONE SET AND IS NOT SPLIT BY SURFACE. The thirteen codes below reach
// three surfaces — the manifest rows of `repos/artifacts/`, the payload section of
// `repos/artifact-pane/`, and the ingest chips of `repos/attachments/` — and six of
// them reach more than one. A table per surface would be three answers to one code and
// three places for a code the wire adds to go missing, which `apps/desktop/AGENTS.md`
// §Shared code rejects outright. The lookup is the family's; each surface renders it
// into the `action` slot its own refusal shape reserves.
//
// THE RECOVERY IS NEVER THE DAEMON'S SENTENCE RESTATED. Each entry says what a PERSON
// does next, which is a different claim from what the daemon said happened, and four of
// them are the reason this module exists at all:
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
 * What a person does next, and the alternatives where there is more than one.
 *
 * `distinctions` is a LIST rather than a second sentence because the cases it holds are
 * exclusive: the reader is choosing between them, and prose that ran them together
 * would read as a sequence of steps. An empty list is the ordinary shape — most codes
 * have exactly one move — and it is a real empty rather than an absent member, so a
 * renderer maps it without asking whether it is there.
 */
export interface ArtifactRefusalRecovery {
  readonly nextMove: string;
  readonly distinctions: readonly string[];
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
      // on a file well under the deployment's cap.
      nextMove:
        "The payload was refused for its size, and nothing was stored. The daemon's message says which of three bounds it crossed:",
      distinctions: [
        "The ingest cap for this deployment — what a single attachment may weigh. The attach affordance's own disclosure carries the effective figure.",
        "The relay publish cap — the artifact exists locally and its bytes were too large to share, so it stays local-only until a smaller derivative is published in its place.",
        "This upload's own declared total — a chunk pushed the running count past what the upload said it would send, so the spool was deleted. Start the upload again; the file is unchanged.",
      ],
    },
    "artifact.too_many_attachments": {
      // THE EARLIER ARTIFACTS SURVIVE, and saying so is the whole recovery: the carrier
      // is refused before any element is bound, and the artifacts earlier ingests minted
      // are untouched session artifacts. A recovery that read as "start over" would send
      // a person to re-upload files that are already here.
      nextMove:
        "The whole carrier was refused before anything was delivered, so nothing partially attached. The files already ingested are ordinary session artifacts and are still here — take some off this turn and send the rest on another.",
      distinctions: NO_DISTINCTIONS,
    },
    "artifact.unsupported_media_type": {
      // NEVER "rename it". The verdict is on the payload's DERIVED type, so the
      // extension is not what was judged and changing it changes nothing.
      nextMove:
        "The type derived from the bytes themselves is not on this deployment's allow-list, and those bytes are quarantined rather than stored. Renaming the file changes nothing — the signature is what was read. The attach affordance's disclosure lists what is admitted here.",
      distinctions: NO_DISTINCTIONS,
    },
    "artifact.scanner_rejected": {
      // Distinct from the media-type code on purpose: the type was allow-listed and
      // reconciled before the scanner ran, so a type-shaped remedy would misdirect.
      nextMove:
        "An operator-configured content scanner rejected these bytes, and they are quarantined. The type was fine — this is a verdict on the content, so a different file rather than a different name or format is the move.",
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
