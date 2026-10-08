/**
 * Turns a failure into the bounded, credential-free `lastError` string stored on a stale
 * workspace.
 */

import { WORKSPACE_LAST_ERROR_MAX_LEN } from "@ai-sidekicks/contracts/repo/workspace";

import { cutToCodeUnits } from "../text-cut.js";

/** Marker appended to a truncated detail; counted inside the cap, which is also the wire cap. */
export const WORKSPACE_LAST_ERROR_TRUNCATION_MARKER = "...[truncated]";

// URL userinfo (`scheme://user:password@host`): the one credential shape with no recognizable
// token prefix, so no other pattern catches it.
const URL_USERINFO_PATTERN = /\b([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^\s/@]+@/g;

// Header-style credentials, including git's `x-access-token` form for GitHub App tokens.
const HEADER_CREDENTIAL_PATTERN = new RegExp(
  String.raw`((?:authorization|proxy-authorization|private-token|x-auth-token|x-access-token)` +
    String.raw`\s*[:=]\s*)(?:bearer\s+|basic\s+|token\s+)?[^\s,;]+`,
  "gi",
);

const KEY_VALUE_CREDENTIAL_PATTERN = new RegExp(
  String.raw`((?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|token)` +
    String.raw`\s*[:=]\s*)(["']?)[^\s"'&,;]+`,
  "gi",
);

const KNOWN_TOKEN_PREFIX_PATTERN =
  /\b(?:gh[pousr]_|github_pat_|glpat-|xox[abprs]-|sk-|AKIA)[A-Za-z0-9_-]{8,}/g;

const CREDENTIAL_REDACTION = "***";

/**
 * Remove credential material from a captured failure detail. Over-redaction is the accepted
 * direction (`token: not found` becomes `token: ***`); under-redaction would put a live credential
 * on the wire.
 */
export function scrubCredentials(rawDetail: string): string {
  return rawDetail
    .replace(URL_USERINFO_PATTERN, `$1${CREDENTIAL_REDACTION}@`)
    .replace(HEADER_CREDENTIAL_PATTERN, `$1${CREDENTIAL_REDACTION}`)
    .replace(KEY_VALUE_CREDENTIAL_PATTERN, `$1$2${CREDENTIAL_REDACTION}`)
    .replace(KNOWN_TOKEN_PREFIX_PATTERN, CREDENTIAL_REDACTION);
}

/**
 * Cut a detail to `WORKSPACE_LAST_ERROR_MAX_LEN` with a marker, the marker counted inside the cap.
 */
function truncateWorkspaceLastError(detail: string): string {
  if (detail.length <= WORKSPACE_LAST_ERROR_MAX_LEN) {
    return detail;
  }
  const kept = WORKSPACE_LAST_ERROR_MAX_LEN - WORKSPACE_LAST_ERROR_TRUNCATION_MARKER.length;
  return `${cutToCodeUnits(detail, kept)}${WORKSPACE_LAST_ERROR_TRUNCATION_MARKER}`;
}

/**
 * Make a raw failure detail safe to persist and legal on the wire, or `null` when nothing
 * publishable survives. Truncating before scrubbing could cut a credential mid-pattern and leave a
 * live secret.
 */
export function normalizeWorkspaceLastError(rawDetail: string): string | null {
  // NULs first: one could split a token past its pattern, and the wire schema forbids them.
  const nulFree = rawDetail.replace(/\0/g, "");
  const scrubbed = scrubCredentials(nulFree);
  // Tested before truncation: the marker's characters would let an over-cap blank detail pass.
  if (!/\S/.test(scrubbed)) {
    return null;
  }
  return truncateWorkspaceLastError(scrubbed);
}
