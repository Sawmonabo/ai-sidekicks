// The ATTACHMENT-INGEST plane: the three-call ingest, and the abort that gives a spool
// back.
//
// WHY THIS PLANE IS SERVED AT ALL, WHICH IS THE WHOLE DECISION HERE. The ingest trio is
// a PROTOCOL rather than a read: Init mints a stream id, each chunk is acknowledged with
// the spooled running total the next chunk's offset is taken from, and Complete answers
// with the derived truth that replaces the caller's declaration. A scripted reply table
// cannot stand in for that — one fixed answer per call name would hand every chunk the
// same running total, so the client's offset would never advance and no upload would
// ever finish. So this plane keeps the spool the daemon would keep, and every ingest
// state a surface can render is reachable by attaching a file rather than by scripting
// one.
//
// IT IS THE DAEMON'S RULES AND NOT AN INVENTION OF ITS OWN. Every refusal below is one
// `Spec-014` names, raised at the enforcement point that spec puts it at: the declared
// total and the running spooled count both refuse `artifact.too_large`, so a chunk that
// pushes the running count past the declaration refuses far below the cap; the whole
// carrier refuses `artifact.too_many_attachments` at acceptance while the artifacts
// earlier ingests minted stay untouched; a payload this stand-in cannot place refuses
// `artifact.unsupported_media_type` at completion, where the daemon has the bytes; and a
// chunk that arrives out of sequence, or names a stream this spool has never held,
// refuses the terminal `artifact.ingest_stream_invalid`.
//
// AND THE RETRY-SAFETY IS MODELLED RATHER THAN ASSERTED. `Spec-014 §Interfaces And
// Contracts` makes every leg of the trio retry-safe, and the console's whole retry
// discipline rests on it: a replayed chunk is acknowledged WITHOUT being appended
// twice, and a replayed completion replays its original response verbatim. A fixture
// that appended a replay would make the console's own replay path look like a bug the
// day a lost response happened.
//
// THE CODES ARE SPELLED HERE RATHER THAN IMPORTED, and that is the console DAG rather
// than a preference: `bridge/` sits below every view family, so this module may not
// reach `repos/attachments/attachment-policy.ts`, which is where the surfaces that
// RENDER these codes read them from. A fixture standing in for the daemon speaks the
// daemon's vocabulary, and the direction of that edge is fixed.

import {
  ATTACHMENTS_PER_CARRIER_CAP_DEFAULT,
  ATTACHMENT_BYTE_CAP_DEFAULT,
  ATTACHMENT_CHUNK_BYTE_CAP,
  base64DecodedByteLength,
} from "../../../core/index.js";
import { refuseAs } from "../../scenarios/computed-reply.js";
import type { GrowthPort } from "../../growth-port/index.js";

/**
 * The four ingest operations the fixture answers.
 *
 * Declared here and spread into `FIXTURE_SERVED_GROWTH_OPERATION_IDS` next door, on
 * `FIXTURE_SERVED_PROVIDER_ACCOUNT_OPERATION_IDS`' rule: the ids and the handlers below
 * are one set with one home, and a second tuple in the served module would agree with
 * this one until a leg landed in only one of them.
 */
export const FIXTURE_SERVED_ATTACHMENT_INGEST_OPERATION_IDS = [
  "artifactIngestBegin",
  "artifactIngestWriteChunk",
  "artifactIngestComplete",
  "artifactIngestAbort",
] as const;

/** One ingest operation the fixture serves. Derived, so the set has one home. */
export type FixtureServedAttachmentIngestOperationId =
  (typeof FIXTURE_SERVED_ATTACHMENT_INGEST_OPERATION_IDS)[number];

/** The daemon codes this stand-in refuses under. `Spec-014`'s, spelled for the DAG's reason. */
const TOO_LARGE_CODE = "artifact.too_large";
const TOO_MANY_ATTACHMENTS_CODE = "artifact.too_many_attachments";
const UNSUPPORTED_MEDIA_TYPE_CODE = "artifact.unsupported_media_type";
const INGEST_STREAM_INVALID_CODE = "artifact.ingest_stream_invalid";

/** One open spool, and what the daemon would know about it. */
interface FixtureIngestSpool {
  readonly sessionId: string;
  readonly declaredName: string;
  readonly declaredSizeBytes: number;
  receivedBytes: number;
  /** The sequence the next fresh chunk carries. A lower one is a replay; a higher one is a gap. */
  nextSequenceNumber: number;
  /** The completion's own answer, kept so a replayed Complete replays it verbatim. */
  completion: FixtureIngestCompletion | undefined;
}

/** What `AttachmentIngestComplete` answers with, minted once per stream. */
interface FixtureIngestCompletion {
  readonly artifactId: string;
  readonly contentHash: string;
  readonly normalizedName: string;
  readonly derivedMediaType: string;
  readonly derivedSizeBytes: number;
}

/**
 * The spools one window's fixture holds, and the rules that open and close them.
 *
 * A CLASS because the plane is stateful — the whole reason it exists is that the
 * protocol's answers depend on what the previous call did — and this package's rule for
 * stateful logic is an encapsulated class rather than module-level mutable bindings.
 * One instance per bridge, so two windows over one scenario never share a spool.
 */
export class FixtureAttachmentIngest {
  readonly #spoolsByIngestId = new Map<string, FixtureIngestSpool>();
  readonly #mintedCountBySessionId = new Map<string, number>();
  #nextStreamNumber = 1;

  /** `AttachmentIngestInit`. Refuses before a spool exists where the carrier cannot hold one. */
  public begin(request: {
    readonly sessionId: string;
    readonly fileName: string;
    readonly mediaType?: string;
    readonly declaredSizeBytes: number;
  }): { readonly ingestId: string } {
    if (request.declaredSizeBytes > ATTACHMENT_BYTE_CAP_DEFAULT) {
      // The FIRST of the three enforcement points: the declared total, refused before a
      // byte is spooled rather than after the upload has run.
      refuseAs(
        TOO_LARGE_CODE,
        "The declared size is past this deployment's per-attachment bound, so no stream was opened.",
      );
    }
    if (this.#carrierCountOf(request.sessionId) >= ATTACHMENTS_PER_CARRIER_CAP_DEFAULT) {
      refuseAs(
        TOO_MANY_ATTACHMENTS_CODE,
        "This carrier is at its attachment bound. The artifacts earlier ingests minted are untouched and stay reusable.",
      );
    }
    const ingestId = `ingest-${String(this.#nextStreamNumber)}`;
    this.#nextStreamNumber += 1;
    this.#spoolsByIngestId.set(ingestId, {
      sessionId: request.sessionId,
      declaredName: request.fileName,
      declaredSizeBytes: request.declaredSizeBytes,
      receivedBytes: 0,
      nextSequenceNumber: 0,
      completion: undefined,
    });
    return { ingestId };
  }

  /** `AttachmentIngestChunk`. Answers the spooled running total of DECODED bytes. */
  public writeChunk(request: {
    readonly ingestId: string;
    readonly sequenceNumber: number;
    readonly chunk: string;
  }): { readonly ingestId: string; readonly receivedBytes: number } {
    const spool = this.#openSpool(request.ingestId);
    if (request.sequenceNumber < spool.nextSequenceNumber) {
      // A REPLAY, acknowledged without being appended twice. This is the property the
      // console's whole retry-in-place discipline rests on.
      return { ingestId: request.ingestId, receivedBytes: spool.receivedBytes };
    }
    if (request.sequenceNumber > spool.nextSequenceNumber) {
      this.#spoolsByIngestId.delete(request.ingestId);
      refuseAs(
        INGEST_STREAM_INVALID_CODE,
        "A chunk arrived out of sequence, so this stream is over and cannot be resumed.",
      );
    }
    const decodedByteLength = base64DecodedByteLength(request.chunk);
    if (decodedByteLength > ATTACHMENT_CHUNK_BYTE_CAP) {
      this.#spoolsByIngestId.delete(request.ingestId);
      refuseAs(
        INGEST_STREAM_INVALID_CODE,
        "A chunk carried more raw bytes than one chunk may, so this stream is over.",
      );
    }
    const runningTotal = spool.receivedBytes + decodedByteLength;
    if (runningTotal > spool.declaredSizeBytes) {
      // The THIRD enforcement point, and the one that fires far below the cap: a chunk
      // pushing the running count past what the caller declared is refused whatever the
      // deployment's per-attachment bound is.
      refuseAs(
        TOO_LARGE_CODE,
        "This chunk pushes the spooled total past the size the ingest declared, so it was not appended.",
      );
    }
    spool.receivedBytes = runningTotal;
    spool.nextSequenceNumber = request.sequenceNumber + 1;
    return { ingestId: request.ingestId, receivedBytes: spool.receivedBytes };
  }

  /** `AttachmentIngestComplete`. The derived truth, minted once and replayed verbatim after. */
  public complete(request: { readonly ingestId: string }): FixtureIngestCompletion {
    const spool = this.#openSpool(request.ingestId);
    if (spool.completion !== undefined) {
      return spool.completion;
    }
    const derivedMediaType = derivedMediaTypeOf(spool.declaredName);
    if (derivedMediaType === undefined) {
      refuseAs(
        UNSUPPORTED_MEDIA_TYPE_CODE,
        "The payload's type is outside this deployment's allow-list. The bytes are quarantined and were never re-typed.",
      );
    }
    const completion: FixtureIngestCompletion = {
      artifactId: `artifact-${request.ingestId}`,
      contentHash: `b3:${request.ingestId}`,
      normalizedName: normalizedNameOf(spool.declaredName),
      derivedMediaType,
      derivedSizeBytes: spool.receivedBytes,
    };
    spool.completion = completion;
    this.#mintedCountBySessionId.set(spool.sessionId, this.#carrierCountOf(spool.sessionId) + 1);
    return completion;
  }

  /**
   * Give one spool back.
   *
   * Never refuses. There is no cancel call in the trio, so the console reaches this
   * through the slate's own abort row and the act it models is the reaper's: a spool
   * that is already gone is already reclaimed, and a stand-in that refused would teach
   * the surface to render an error for the state it was asking for.
   */
  public abort(request: { readonly ingestId: string }): void {
    this.#spoolsByIngestId.delete(request.ingestId);
  }

  #openSpool(ingestId: string): FixtureIngestSpool {
    const spool = this.#spoolsByIngestId.get(ingestId);
    if (spool === undefined) {
      refuseAs(
        INGEST_STREAM_INVALID_CODE,
        "No open stream carries that id, so there is nothing to resume.",
      );
    }
    return spool;
  }

  #carrierCountOf(sessionId: string): number {
    return this.#mintedCountBySessionId.get(sessionId) ?? 0;
  }
}

/**
 * The type the daemon would derive, or `undefined` where nothing places the payload.
 *
 * THE DECLARATION IS NOT CONSULTED, which is the contract's own posture rather than a
 * shortcut: `Spec-014 §Required Behavior` makes a caller's `mediaType` advisory input
 * that narrows an expected signature and never a trusted fact, and the daemon derives
 * its own answer from the bytes. This stand-in holds no bytes, so it places the payload
 * by extension — which keeps the two readings genuinely independent, so a declaration
 * that disagrees with the finding renders as the disagreement it is, and a payload the
 * table does not place is refused rather than re-typed as whatever the caller claimed.
 */
function derivedMediaTypeOf(declaredName: string): string | undefined {
  const separatorIndex = declaredName.lastIndexOf(".");
  if (separatorIndex < 0) {
    return undefined;
  }
  return FIXTURE_MEDIA_TYPE_BY_EXTENSION[declaredName.slice(separatorIndex).toLowerCase()];
}

/**
 * What this stand-in places a payload by, in place of the signature read it cannot do.
 *
 * Deliberately NOT the effective allow-list, which is a normative wire fact with its own
 * home in the surfaces that render it: a copy here would be a second statement of that
 * list one directory below the family that owns it, and the console DAG forbids the
 * import that would have kept the two in step.
 */
const FIXTURE_MEDIA_TYPE_BY_EXTENSION: Readonly<Record<string, string | undefined>> = {
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".json": "application/json",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".xml": "text/xml",
  ".diff": "text/x-diff",
  ".patch": "text/x-diff",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".gz": "application/gzip",
};

/**
 * The name the manifest would record.
 *
 * `Spec-014 §Ingest Validation And Payload Bounds (V1)` keeps every caller-supplied
 * string out of every path component, so the stand-in normalizes exactly as the daemon
 * would: no separator survives, and what is left is lower-cased. It is deliberately
 * VISIBLE work — a fixture whose normalized name always equalled the declaration would
 * leave the console's "derived truth replaces the declaration" arm untested by eye.
 */
function normalizedNameOf(declaredName: string): string {
  const withoutDirectories = declaredName.slice(
    Math.max(declaredName.lastIndexOf("/"), declaredName.lastIndexOf("\\")) + 1,
  );
  return withoutDirectories.toLowerCase().replaceAll(/[^a-z0-9._-]/gu, "-");
}

/**
 * The fixture's four ingest answers for one running scenario.
 *
 * `Pick` over the port rather than a shape of its own, on `fixtureProviderAccountWrites`'
 * reason: a handler whose signature drifts from the operation it serves is a compile
 * error here rather than a surface rendering a value no daemon sends.
 *
 * THE SPOOLS ARE PASSED IN AND THE SCENARIO ENGINE IS NOT, which is where this plane
 * differs from every other. The others answer from the scenario in play, so they take
 * the engine; this one answers from a PROTOCOL, so what it needs is the state that
 * protocol has accumulated — and the bridge owns that state's lifetime, because a spool
 * belongs to the window rather than to the call that opened it.
 */
export function fixtureAttachmentIngest(
  spools: FixtureAttachmentIngest,
): Pick<GrowthPort, FixtureServedAttachmentIngestOperationId> {
  return {
    artifactIngestBegin: async (request) => ({ status: "served", value: spools.begin(request) }),
    artifactIngestWriteChunk: async (request) => ({
      status: "served",
      value: spools.writeChunk(request),
    }),
    artifactIngestComplete: async (request) => ({
      status: "served",
      value: spools.complete(request),
    }),
    artifactIngestAbort: async (request) => {
      spools.abort(request);
      return { status: "served", value: undefined };
    },
  };
}
