// The daemon's outbound-credential seam for control-plane calls.
//
// This module holds an interface and a refusing stub; it mints no credentials. The daemon holds
// no PASETO signing identity, so the key that would sign a PASETO v4.public token, its custody,
// and the control plane's verification are not defined here.
//
// Calls use DPoP (RFC 9449), not Bearer. A bearer token is usable by anyone who holds it, so a
// logged header, a proxy buffer or a crash dump would hand out something replayable. DPoP binds
// the token to a key the sender proves possession of on every request. Two headers travel
// together, and both are the provider's to produce:
//
//   * `Authorization: DPoP <token>` (RFC 9449 section 7.1). `Bearer` is not an alternative
//     spelling: a server that accepts the token under `Bearer` skips the proof check.
//   * `DPoP: <proof JWT>` (RFC 9449 section 4.3), a per-request proof whose claims bind the
//     HTTP method (`htm`), the target URI (`htu`) and the hash of the token (`ath`).
//
// `mintForAttempt` takes `htm` and `htu` and returns a header map so both headers come from
// the same `(htm, htu)` pair in one call. The caller must pass the method and absolute URI of
// the request the headers will travel on, with no query and no fragment; a mismatch produces
// headers the control plane correctly refuses.
//
// The token's claim set, the proof's exact header and payload, key custody and the nonce
// ceremony (RFC 9449 section 8) belong to the implementor. What is fixed is the operation and
// the two header names, and `assertDpopCredentialMaterial` checks them.

import type { NodeId, SessionId } from "@ai-sidekicks/contracts";

/** The HTTP header carrying the DPoP-bound access token; callers and tests share this spelling. */
export const AUTHORIZATION_HEADER_NAME = "Authorization";

/**
 * The HTTP header carrying the per-request DPoP proof JWT (RFC 9449 section 4). The header name
 * and the `Authorization` scheme are both spelled `DPoP`; both are required.
 */
export const DPOP_PROOF_HEADER_NAME = "DPoP";

/**
 * The `Authorization` scheme for a DPoP-bound access token (RFC 9449 section 7.1). `Bearer` is
 * refused; see {@link assertDpopCredentialMaterial}.
 */
export const DPOP_AUTHORIZATION_SCHEME = "DPoP";

/**
 * The request a credential is minted for. `sessionId` and `nodeId` scope the authority being
 * claimed; `htm` and `htu` are the RFC 9449 section 4.3 proof claims.
 *
 * @consumedBy the daemon's control-plane callers, such as the notification publisher
 */
export interface DaemonCredentialAttempt {
  /** The session this call is about. */
  readonly sessionId: SessionId;
  /** The calling daemon's NodeId — the identity the control plane attributes the write to. */
  readonly nodeId: NodeId;
  /** The HTTP method of the request these headers will travel on, uppercase (`"POST"`). */
  readonly htm: string;
  /** The absolute URI of that same request, with no query and no fragment. */
  readonly htu: string;
}

/**
 * The complete set of headers a provider hands back to merge into the outbound request. A map,
 * not a token, so the caller does not assemble the two agreeing headers and a provider can add
 * more (such as a `DPoP-Nonce` echo) without a signature change.
 */
export interface DaemonCredentialMaterial {
  /** Headers to merge into the outbound request, header-name keyed. */
  readonly headers: Readonly<Record<string, string>>;
}

/**
 * Mints the outbound credential headers for one control-plane call.
 *
 * Call it once per attempt, inside the retry loop: a DPoP proof is bound to one request, so a
 * retry needs a new proof and a control plane rejects a reused one (RFC 9449 section 11.1).
 *
 * @consumedBy the daemon's control-plane callers, such as the notification publisher
 */
export interface DaemonCredentialProvider {
  mintForAttempt(attempt: DaemonCredentialAttempt): Promise<DaemonCredentialMaterial>;
}

/**
 * Refuses every mint with a diagnostic naming the missing signing identity. It throws rather
 * than returning empty headers so the person sees the real cause here, not a generic 401 from
 * the control plane.
 *
 * @consumedBy the daemon's startup wiring, until the daemon holds a signing identity
 */
export class DeferredDaemonCredentialProvider implements DaemonCredentialProvider {
  mintForAttempt(attempt: DaemonCredentialAttempt): Promise<DaemonCredentialMaterial> {
    return Promise.reject(
      new Error(
        `DaemonCredentialProvider.mintForAttempt is deferred (PASETO auth): ` +
          `no daemon PASETO signing identity exists yet, so no ` +
          `${DPOP_AUTHORIZATION_SCHEME}-bound token can be minted for ${attempt.htm} ${attempt.htu} ` +
          `(session ${attempt.sessionId}, node ${attempt.nodeId}).`,
      ),
    );
  }
}

/**
 * Reads one header by name, case-insensitively (RFC 9110 section 5.1). A provider that builds
 * its material from a Headers instance returns lowercase keys, and an exact-match read would
 * wrongly report its Authorization header as missing.
 */
function readHeader(headers: Readonly<Record<string, string>>, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}

/**
 * Refuses credential material that would not carry a DPoP-bound token.
 *
 * The scheme requirement is a security property the type `Readonly<Record<string, string>>`
 * cannot express: `{ Authorization: "Bearer …" }` satisfies it, and a plausible wrong provider
 * would then ship a replayable credential with every test green. This check catches a missing
 * or bare `Authorization` header, a non-`DPoP` scheme and a missing proof header. It cannot
 * check that the token is a well-formed PASETO, that the proof's `htm`/`htu` match the request,
 * or that `ath` hashes the token.
 *
 * No thrown message echoes any part of the header value, not even the scheme, because a caller
 * may log or persist the error and that would make a rejected credential durable.
 *
 * @throws Error when either header is missing, when `Authorization` carries no scheme
 * separator, when its scheme is not `DPoP`, or when the scheme is bare.
 */
export function assertDpopCredentialMaterial(material: DaemonCredentialMaterial): void {
  const authorization = readHeader(material.headers, AUTHORIZATION_HEADER_NAME);
  if (authorization === undefined || authorization.length === 0) {
    throw new Error(
      `DaemonCredentialProvider.mintForAttempt returned no ${AUTHORIZATION_HEADER_NAME} header. ` +
        `The control-plane call is an authenticated write; an unauthenticated attempt would surface as ` +
        `a generic control-plane 401 that names the wrong cause. That is an injection bug at the ` +
        `boundary.`,
    );
  }

  // Nothing below interpolates `authorization` or a slice of it: a caller may log or persist
  // `Error.message`, and an echo would write a cleartext credential to disk.
  const schemeSeparatorIndex = authorization.indexOf(" ");
  if (schemeSeparatorIndex === -1) {
    throw new Error(
      `DaemonCredentialProvider.mintForAttempt returned an ${AUTHORIZATION_HEADER_NAME} header ` +
        `with no scheme separator, so it names no scheme and carries no token (RFC 9449 section 7.1 ` +
        `requires \`${DPOP_AUTHORIZATION_SCHEME} <token>\`). The value is WITHHELD from this ` +
        `message on purpose: a separator-less header is most often the bare token itself, and ` +
        `this message may be logged or persisted. That is an injection bug at the boundary.`,
    );
  }

  // Scheme names are case-insensitive (RFC 9110 section 11.1), so `dpop` is accepted; the token
  // itself is case-sensitive and left untouched.
  const scheme = authorization.slice(0, schemeSeparatorIndex);
  if (scheme.toLowerCase() !== DPOP_AUTHORIZATION_SCHEME.toLowerCase()) {
    throw new Error(
      `DaemonCredentialProvider.mintForAttempt returned an ${AUTHORIZATION_HEADER_NAME} header ` +
        `that is not \`${DPOP_AUTHORIZATION_SCHEME}\`-schemed (RFC 9449 section 7.1). A bearer ` +
        `credential on this path is replayable by anyone who reads it from a log, a proxy buffer, ` +
        `or a crash dump. The offending scheme is not quoted back: it is a prefix of a credential, ` +
        `and this message may be persisted. That is an injection bug at the boundary, not a ` +
        `control-plane compatibility question.`,
    );
  }

  // A scheme with nothing after it passes the checks above while carrying no credential.
  if (authorization.slice(schemeSeparatorIndex + 1).trim().length === 0) {
    throw new Error(
      `DaemonCredentialProvider.mintForAttempt returned a bare \`${DPOP_AUTHORIZATION_SCHEME}\` ` +
        `${AUTHORIZATION_HEADER_NAME} scheme with no token after it (RFC 9449 section 7.1). An empty ` +
        `credential is not a credential; it would surface as a generic control-plane 401 naming ` +
        `the wrong cause. That is an injection bug boundary.`,
    );
  }

  const proof = readHeader(material.headers, DPOP_PROOF_HEADER_NAME);
  if (proof === undefined || proof.length === 0) {
    throw new Error(
      `DaemonCredentialProvider.mintForAttempt returned a ${DPOP_AUTHORIZATION_SCHEME}-schemed ` +
        `token with no ${DPOP_PROOF_HEADER_NAME} proof header (RFC 9449 section 4.3). Without the proof ` +
        `the token is bearer-equivalent in practice while claiming otherwise, which is worse than ` +
        `an honest bearer token. That is an injection bug boundary.`,
    );
  }
}
