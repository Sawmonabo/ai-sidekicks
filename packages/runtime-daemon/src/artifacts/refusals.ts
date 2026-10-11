// The artifact store's refusals, each projected onto the wire by its code: a stream past its end is
// begun again from its opening, a full ledger and a type check that could not run are waited out
// and sent again, and a file too large for its declaration or for the disk, a payload whose type
// the detector refused, and a file sent to the publish call are refused for good.

import type {
  ArtifactRefusalCode,
  ArtifactTooLargeReason,
  IngestStreamInvalidReason,
} from "@ai-sidekicks/contracts/artifacts/operations";
import { JsonRpcErrorCode } from "@ai-sidekicks/contracts/jsonrpc/error-code";

import { DaemonDomainError } from "../ipc/domain-error.js";

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
 * `artifact.ingest_capacity_exhausted`: no upload was admitted because the open uploads are at
 * their bound or the disk has no room for this one beside theirs. Nothing was created, so a later
 * one may admit.
 */
export class IngestCapacityExhaustedError extends DaemonDomainError {
  constructor() {
    super("The background service has no room for another upload right now", {
      code: "artifact.ingest_capacity_exhausted" satisfies ArtifactRefusalCode,
      jsonRpcCode: JsonRpcErrorCode.InvalidRequest,
    });
  }
}

/**
 * `artifact.too_large`: a payload declared larger than the disk has room for, or a stream that
 * sent more than it declared. Either names its reason, the limit it hit and the file, when it has
 * one; a publish carries no file name.
 */
export class ArtifactTooLargeError extends DaemonDomainError {
  constructor(
    fileName: string | undefined,
    limit: { readonly availableBytes: number } | { readonly declaredSizeBytes: number },
  ) {
    const payloadName = fileName ?? "The payload";
    const reason: ArtifactTooLargeReason =
      "availableBytes" in limit ? "volume_too_small" : "declared_size_exceeded";
    super(
      "availableBytes" in limit
        ? `${payloadName} is larger than the ${String(limit.availableBytes)} bytes free on the disk`
        : `${payloadName} sent more than the ${String(limit.declaredSizeBytes)} bytes it declared`,
      {
        code: "artifact.too_large" satisfies ArtifactRefusalCode,
        jsonRpcCode: JsonRpcErrorCode.InvalidRequest,
        detail: { reason, ...(fileName === undefined ? {} : { fileName }), ...limit },
      },
    );
  }
}

/**
 * `artifact.type_unreadable`: the detector ran over this payload's bytes and refused them. The same
 * bytes fail the same way, so the payload is refused for good rather than sent again. `fileName` is
 * the ingested file's; a publish carries none.
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
 * `artifact.type_check_unavailable`: the type check could not run to an answer, because it ran past
 * its time bound, its thread failed or ran out of room, or too many payloads were waiting for one.
 * Nothing about the bytes is known, so the same call is sent again: an ingest stream stays open
 * with its spool for a resent completion, and a publish keeps nothing.
 */
export class ArtifactTypeCheckUnavailableError extends DaemonDomainError {
  constructor(fileName: string | undefined, cause: unknown) {
    super(
      fileName === undefined
        ? "The type of the published payload could not be checked right now"
        : `The type of ${fileName} could not be checked right now`,
      {
        code: "artifact.type_check_unavailable" satisfies ArtifactRefusalCode,
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
