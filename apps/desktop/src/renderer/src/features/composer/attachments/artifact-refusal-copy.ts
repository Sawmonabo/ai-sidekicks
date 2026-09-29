// The `artifact.*` refusal codes the composer's attachments can receive.

/**
 * Every `artifact.*` refusal code the console can receive.
 *
 * Transcribed from the registered artifact error codes, in that table's own row order.
 * A tuple rather than a count in prose, so the vocabulary has one home.
 *
 * @consumedBy the composer's attachment refusal copy
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
  "artifact.relay_expired",
  "artifact.fetch_unauthorized",
  "artifact.no_access_key",
] as const;
