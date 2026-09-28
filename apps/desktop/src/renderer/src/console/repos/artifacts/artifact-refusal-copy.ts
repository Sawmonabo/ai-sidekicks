// The `artifact.*` refusal codes this family can receive, and the reading that finds the
// code the daemon spoke when a seam wrapped it.
//
// A call that rejected rather than answering may arrive as a seam `call-rejected` with the
// daemon's refusal on `cause`; {@link daemonSpokenRefusal} reads through that once, here,
// rather than at each surface that renders one.

import type { ExtendedConsoleRefusal } from "../../core/index.js";

/**
 * A refusal as a surface receives it: possibly a seam refusal wrapping the daemon's.
 *
 * `cause` is OPTIONAL and typed as the extended shape, so a seam refusal that wraps the
 * daemon's, and a bare `ConsoleRefusal` from anywhere else, are both one of these
 * unchanged.
 */
export type ArtifactSurfaceRefusal = ExtendedConsoleRefusal & {
  readonly cause?: ExtendedConsoleRefusal | undefined;
};

/**
 * The refusal whose code the DAEMON spoke, which is not always the one that arrived.
 *
 * One level and never a walk: a seam wraps at most once, and a loop here would be
 * chasing a nesting nothing produces. What comes back carries the registered
 * extensions too.
 */
export function daemonSpokenRefusal(refusal: ArtifactSurfaceRefusal): ExtendedConsoleRefusal {
  return refusal.cause ?? refusal;
}

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
