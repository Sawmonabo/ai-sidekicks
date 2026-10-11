// The artifact store's refusals, each projected onto the wire by its code: a stream past its end is
// begun again from its opening, a full ledger is waited out, and a file too large for its
// declaration or for the disk, a payload whose type cannot be read, and a file sent to the publish
// call are refused for good.

import type { ArtifactRefusalCode } from "@ai-sidekicks/contracts/artifacts/operations";
import { JsonRpcErrorCode } from "@ai-sidekicks/contracts/jsonrpc/error-code";

import { DaemonDomainError } from "../ipc/domain-error.js";

/**
 * Why a stream call cannot go on: its id names no live stream, a chunk broke the sequence, the
 * stream outlived its lifetime, or a chunk came after the completion.
 */
export type IngestStreamInvalidReason =
  | "unknown_stream"
  | "sequence_broken"
  | "lifetime_expired"
  | "already_completed";

/**
 * `artifact.ingest_stream_invalid`: the call cannot proceed and cannot be retried in place, so the
 * caller begins again from a new stream.
 */
export class IngestStreamInvalidError extends DaemonDomainError {
  constructor(ingestId: string, reason: IngestStreamInvalidReason) {
    super(`The ingest stream cannot go on: ${reason}`, {
      code: "artifact.ingest_stream_invalid" satisfies ArtifactRefusalCode,
      jsonRpcCode: JsonRpcErrorCode.InvalidRequest,
      detail: { ingestId, reason },
    });
  }
}

/**
 * `artifact.ingest_capacity_exhausted`: no stream was opened because the open streams are at their
 * bound or the disk has no room for this one beside theirs. Nothing was created, so a later
 * opening may admit.
 */
export class IngestCapacityExhaustedError extends DaemonDomainError {
  constructor() {
    super("The background service has no room for another upload right now", {
      code: "artifact.ingest_capacity_exhausted" satisfies ArtifactRefusalCode,
    });
  }
}

/**
 * `artifact.too_large`: a file declared larger than the disk has room for, or a stream sent more
 * than it declared. Either names the file and the limit it hit.
 */
export class ArtifactTooLargeError extends DaemonDomainError {
  constructor(
    fileName: string,
    limit: { readonly availableBytes: number } | { readonly declaredSizeBytes: number },
  ) {
    super(
      "availableBytes" in limit
        ? `${fileName} is larger than the ${String(limit.availableBytes)} bytes free on the disk`
        : `${fileName} sent more than the ${String(limit.declaredSizeBytes)} bytes it declared`,
      {
        code: "artifact.too_large" satisfies ArtifactRefusalCode,
        jsonRpcCode: JsonRpcErrorCode.InvalidRequest,
        detail: { fileName, ...limit },
      },
    );
  }
}

/**
 * `artifact.type_unreadable`: the detector failed or ran past its bound on this payload's bytes.
 * The same bytes fail the same way, so the payload is refused for good rather than begun again.
 * `fileName` is the ingested file's; a publish carries none.
 */
export class ArtifactTypeUnreadableError extends DaemonDomainError {
  constructor(fileName: string | undefined, cause: unknown) {
    super(
      fileName === undefined
        ? "The type of the published payload could not be read from its bytes"
        : `The type of ${fileName} could not be read from its bytes`,
      {
        code: "artifact.type_unreadable" satisfies ArtifactRefusalCode,
        jsonRpcCode: JsonRpcErrorCode.InvalidRequest,
        ...(fileName === undefined ? {} : { detail: { fileName } }),
        cause,
      },
    );
  }
}

/**
 * `artifact.file_publish_refused`: a client published a file. A file reaches the store only through
 * the ingest calls, which are the one hardened way in for a file's bytes.
 */
export class FilePublishRefusedError extends DaemonDomainError {
  constructor() {
    super("A file is sent with artifact.ingestInit, not published", {
      code: "artifact.file_publish_refused" satisfies ArtifactRefusalCode,
      jsonRpcCode: JsonRpcErrorCode.InvalidRequest,
    });
  }
}
