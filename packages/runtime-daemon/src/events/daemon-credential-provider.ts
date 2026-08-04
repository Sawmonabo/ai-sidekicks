// Plan-006 T3.3 — the daemon's outbound-credential seam for control-plane calls.
//
// DECLARED HERE, IMPLEMENTED AT TIER 5. This module ships an INTERFACE and a
// refusing stub; it ships no credential minting. The reason is the same one
// `signing-key-source.ts`'s `DaemonSigningKeySealer` states for its own
// boundary, and it is a corpus fact rather than a preference: the daemon has no
// PASETO signing identity yet. `Spec-006 §Anchoring Cadence` needs anchors
// uploaded, but the key that would sign a daemon's PASETO v4.public token, the
// key's custody, and the control plane's verification of it are Plan-018's
// (PASETO auth) and land at Tier 5. Minting a token here would mean inventing a
// claim set and a signing key that Tier 5 then has to honour or break.
//
// Declaring the interface NOW is not premature either: it is what lets T3.3's
// uploader be written and reviewed against a real call shape instead of a
// TODO, and what lets the composition root wire a real provider at Tier 5
// without touching this file's consumers. Plan-006 T3.3 hoists this
// declaration from T4.10 for exactly that reason — Phase 3 precedes Phase 4,
// and Phase 3 is where the first consumer lands.
//
// ----------------------------------------------------------------------------
// Why DPoP and not Bearer — the one thing this seam DOES fix
// ----------------------------------------------------------------------------
//
// A bearer token is, by definition, usable by whoever holds it. If the anchor
// upload carried `Authorization: Bearer <token>`, a control plane that logged
// request headers, a proxy that buffered them, or an operator reading a crash
// dump would each hold something replayable against the anchor endpoint — and
// the anchor endpoint writes the integrity witness for an audit log. Anyone who
// can replay it can enqueue anchors attributed to a daemon they do not run.
//
// RFC 9449 (DPoP) closes that by binding the token to a key the sender proves
// possession of, per-request. Two headers travel together, and both are the
// provider's to produce:
//
//   * `Authorization: DPoP <token>` — RFC 9449 §7.1 fixes this scheme name for
//     a DPoP-bound access token. `Bearer` is not an alternative spelling of
//     it: a resource server that accepts the token under `Bearer` has, by
//     accepting it, skipped the proof check.
//   * `DPoP: <proof JWT>` — RFC 9449 §4.3, a per-request proof whose claims
//     bind the HTTP method (`htm`) and the target URI (`htu`), and which
//     carries `ath`, the hash of the access token it accompanies.
//
// THE BINDING IS WHY `mintForAttempt` TAKES `htm` AND `htu` AND WHY THE PROOF
// IS COMPUTED INSIDE IT. The proof is only meaningful if its `htm`/`htu` match
// the request the headers actually travel on; a proof minted for a different
// method or a different URI is a proof of nothing. Handing the caller a token
// and letting it build its own proof would put that agreement in the caller's
// hands at every call site. Minting BOTH headers from the same `(htm, htu)`
// pair, in one call, makes the agreement structural — which is the whole point
// of `mintForAttempt` returning a header MAP rather than a token string.
//
// The corollary is a caller obligation this module cannot type: pass the method
// and absolute URI of the request these headers are about to travel on — the
// `htu` with no query and no fragment, per RFC 9449 §4.3. A call whose shape
// disagrees with the request it decorates produces headers the control plane
// correctly refuses.
//
// ----------------------------------------------------------------------------
// What this module does NOT fix
// ----------------------------------------------------------------------------
//
// The token's claim set, the proof JWT's exact header/payload, the signing
// algorithm's key custody, and the nonce ceremony (RFC 9449 §8) are all the
// implementor's. Same reasoning as `DaemonSigningKeySealer`: pre-committing a
// format here would bind every later reader on a guess. What IS fixed is the
// OPERATION and the two header names, because those are what the uploader must
// agree with the control plane about, and `assertDpopCredentialMaterial` below
// is where that agreement is checked rather than assumed.
//
// Refs: Plan-006 T3.3, `Plan-006 §Cross-Plan Obligations` CP-006-13 (the
// credential seam and its callers), RFC 9449 §4.3 + §7.1, ADR-010
// (PASETO v4 + WebAuthn + DPoP).

import type { NodeId, SessionId } from "@ai-sidekicks/contracts";

/**
 * The HTTP header carrying the DPoP-bound access token.
 *
 * Canonical spelling, exported so the uploader and any test assert the same
 * string rather than two independently-typed literals.
 */
export const AUTHORIZATION_HEADER_NAME = "Authorization";

/**
 * The HTTP header carrying the per-request DPoP proof JWT (RFC 9449 §4).
 *
 * Note that the header NAME and the `Authorization` SCHEME are both spelled
 * `DPoP`; they are different things and both are required.
 */
export const DPOP_PROOF_HEADER_NAME = "DPoP";

/**
 * The `Authorization` scheme for a DPoP-bound access token, RFC 9449 §7.1.
 *
 * `Bearer` is REFUSED rather than tolerated — see
 * {@link assertDpopCredentialMaterial}.
 */
export const DPOP_AUTHORIZATION_SCHEME = "DPoP";

/**
 * The request a credential is being minted FOR.
 *
 * Every member is part of the binding: `sessionId` and `nodeId` scope the
 * authority being claimed, and `htm`/`htu` are the RFC 9449 §4.3 proof claims.
 */
export interface DaemonCredentialAttempt {
  /** The session whose anchors this call carries. */
  readonly sessionId: SessionId;
  /** The calling daemon's NodeId — the identity the control plane attributes the write to. */
  readonly nodeId: NodeId;
  /**
   * The HTTP method of the request these headers will travel on, uppercase
   * (`"POST"`). RFC 9449 §4.3 `htm`.
   */
  readonly htm: string;
  /**
   * The absolute URI of that same request, with NO query and NO fragment.
   * RFC 9449 §4.3 `htu`.
   */
  readonly htu: string;
}

/**
 * What a provider hands back: the complete set of headers to merge into the
 * outbound request.
 *
 * A MAP, NOT A TOKEN, and that is the load-bearing choice. DPoP needs two
 * headers that agree with each other and with the request; returning a token
 * string would leave the caller to assemble them and to re-derive the scheme
 * name at every call site. Returning the finished map means a Tier-5 provider
 * can also add headers this module never anticipated (a `DPoP-Nonce` echo per
 * RFC 9449 §8, say) without a signature change.
 */
export interface DaemonCredentialMaterial {
  /** Headers to merge into the outbound request, header-name keyed. */
  readonly headers: Readonly<Record<string, string>>;
}

/**
 * Mints the outbound credential headers for one control-plane call.
 *
 * PER-ATTEMPT, NOT PER-SESSION, and the name says so deliberately. A DPoP proof
 * is bound to one request; a retry after a network failure is a NEW request and
 * needs a NEW proof (RFC 9449 §11.1 discusses proof replay). A caller that
 * mints once and reuses the headers across retries is reusing a proof, which a
 * conforming control plane will reject — correctly. Call this once per attempt,
 * inside the retry loop, not outside it.
 */
export interface DaemonCredentialProvider {
  mintForAttempt(attempt: DaemonCredentialAttempt): Promise<DaemonCredentialMaterial>;
}

/**
 * Refuses every mint with a diagnostic naming the deferral.
 *
 * This is the provider the composition root wires until Plan-018 lands, and it
 * is a REFUSAL rather than a no-op on purpose: a provider that returned empty
 * headers would let the uploader issue an unauthenticated request that the
 * control plane rejects with a generic 401, and the operator would debug the
 * control plane. Throwing here names the actual cause at the actual boundary.
 *
 * It is also why the anchor path treats an upload failure as retriable rather
 * than fatal — the anchor is already durably queued in `pending_anchor_uploads`
 * before any upload is attempted (`Spec-006 §Post-Compaction Integrity` step 3),
 * so a daemon running with this stub still anchors correctly; it simply never
 * flushes, exactly as it would during an indefinite partition.
 */
export class Tier5DeferredDaemonCredentialProvider implements DaemonCredentialProvider {
  mintForAttempt(attempt: DaemonCredentialAttempt): Promise<DaemonCredentialMaterial> {
    return Promise.reject(
      new Error(
        `DaemonCredentialProvider.mintForAttempt is deferred to Tier 5 (Plan-018 PASETO auth; ` +
          `Plan-006 CP-006-13): no daemon PASETO signing identity exists yet, so no ` +
          `${DPOP_AUTHORIZATION_SCHEME}-bound token can be minted for ${attempt.htm} ${attempt.htu} ` +
          `(session ${attempt.sessionId}, node ${attempt.nodeId}). The anchor remains durably ` +
          `queued in pending_anchor_uploads and flushes once a real provider is wired.`,
      ),
    );
  }
}

/**
 * Reads one header by name, case-insensitively per RFC 9110 §5.1.
 *
 * NOT a nicety. A provider that assembles its material from a `Headers`
 * instance hands back LOWERCASE keys, because `Headers` normalizes every name
 * it stores. An exact-match read would then report a CONFORMING provider as
 * having returned no `Authorization` header at all — refusing a correct
 * implementation while naming the wrong cause, which is the most expensive
 * shape of diagnostic to debug.
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
 * WHY A CONSUMER-SIDE CHECK EXISTS AT ALL. The scheme requirement is the one
 * clause of this seam that is a security property rather than a format detail,
 * and TypeScript cannot express it: `Readonly<Record<string, string>>` is
 * satisfied by `{ Authorization: "Bearer …" }` just as well as by the correct
 * value. An injected provider is exactly the kind of boundary where a
 * plausible-looking wrong implementation ships quietly — the request would
 * succeed against a permissive control plane, and the replayable-credential
 * exposure the header exists to prevent would be live in production with every
 * test green. Checking at the consumer is the same discipline
 * `signing-key-source.ts` applies to its injected sealer's result.
 *
 * WHAT IT CANNOT CHECK: that the token is a well-formed PASETO v4.public, that
 * the proof's `htm`/`htu` match this request, or that `ath` hashes this token.
 * All three need the token format this seam deliberately leaves to the
 * implementor. This guard catches the failure that is both catastrophic and
 * cheap to detect — a bearer credential on the wire — and says so rather than
 * implying broader coverage.
 *
 * NO THROW PATH IN THIS FUNCTION ECHOES THE HEADER VALUE, not even the scheme
 * prefix. A refusal here is persisted by the caller (see the inline comment on
 * the separator check), so a diagnostic that quoted the offending value would
 * turn a rejected credential into a durable one.
 *
 * @throws Error when either header is missing, when `Authorization` carries no
 * scheme separator, when its scheme is not `DPoP`, or when the scheme is bare.
 */
export function assertDpopCredentialMaterial(material: DaemonCredentialMaterial): void {
  const authorization = readHeader(material.headers, AUTHORIZATION_HEADER_NAME);
  if (authorization === undefined || authorization.length === 0) {
    throw new Error(
      `DaemonCredentialProvider.mintForAttempt returned no ${AUTHORIZATION_HEADER_NAME} header. ` +
        `The anchor upload is an authenticated write; an unauthenticated attempt would surface as ` +
        `a generic control-plane 401 that names the wrong cause. That is an injection bug at the ` +
        `CP-006-13 boundary.`,
    );
  }

  // NOTHING BELOW INTERPOLATES `authorization` OR ANY SLICE OF IT, AND THAT IS A
  // SECURITY PROPERTY OF THIS FILE RATHER THAN A STYLE CHOICE.
  // `MerkleAnchorService.uploadPendingAnchors` persists a failed attempt's
  // `Error.message` into `pending_anchor_uploads.last_error`, so an echo here
  // writes a cleartext credential to disk, where it outlives the request, the
  // process, and the token's own validity window. The diagnostics below name
  // the header, the RFC clause, and the boundary — everything except the one
  // thing that must not be durable. The operator has the provider.
  const schemeSeparatorIndex = authorization.indexOf(" ");
  if (schemeSeparatorIndex === -1) {
    throw new Error(
      `DaemonCredentialProvider.mintForAttempt returned an ${AUTHORIZATION_HEADER_NAME} header ` +
        `with no scheme separator, so it names no scheme and carries no token (RFC 9449 §7.1 ` +
        `requires \`${DPOP_AUTHORIZATION_SCHEME} <token>\`). The value is WITHHELD from this ` +
        `message on purpose: a separator-less header is most often the bare token itself, and ` +
        `this message is persisted to pending_anchor_uploads.last_error. That is an injection ` +
        `bug at the CP-006-13 boundary.`,
    );
  }

  // Scheme names are case-insensitive per RFC 9110 §11.1, so a conforming
  // control plane accepts `dpop`/`DPOP` — refusing them here would reject a
  // correct provider. The comparison is therefore case-insensitive, and the
  // token itself is left untouched (it is case-SENSITIVE).
  const scheme = authorization.slice(0, schemeSeparatorIndex);
  if (scheme.toLowerCase() !== DPOP_AUTHORIZATION_SCHEME.toLowerCase()) {
    throw new Error(
      `DaemonCredentialProvider.mintForAttempt returned an ${AUTHORIZATION_HEADER_NAME} header ` +
        `that is not \`${DPOP_AUTHORIZATION_SCHEME}\`-schemed (RFC 9449 §7.1). A bearer ` +
        `credential on this path is replayable by anyone who reads it from a log, a proxy buffer, ` +
        `or a crash dump — and this endpoint writes the audit log's integrity witness. The ` +
        `offending scheme is not quoted back: it is a prefix of a credential, and this message is ` +
        `persisted. That is an injection bug at the CP-006-13 boundary, not a control-plane ` +
        `compatibility question.`,
    );
  }

  // A scheme with nothing after it passes every check above while carrying no
  // credential at all — the control plane would answer a generic 401 and the
  // operator would debug the wrong side.
  if (authorization.slice(schemeSeparatorIndex + 1).trim().length === 0) {
    throw new Error(
      `DaemonCredentialProvider.mintForAttempt returned a bare \`${DPOP_AUTHORIZATION_SCHEME}\` ` +
        `${AUTHORIZATION_HEADER_NAME} scheme with no token after it (RFC 9449 §7.1). An empty ` +
        `credential is not a credential; it would surface as a generic control-plane 401 naming ` +
        `the wrong cause. That is an injection bug at the CP-006-13 boundary.`,
    );
  }

  const proof = readHeader(material.headers, DPOP_PROOF_HEADER_NAME);
  if (proof === undefined || proof.length === 0) {
    throw new Error(
      `DaemonCredentialProvider.mintForAttempt returned a ${DPOP_AUTHORIZATION_SCHEME}-schemed ` +
        `token with no ${DPOP_PROOF_HEADER_NAME} proof header (RFC 9449 §4.3). Without the proof ` +
        `the token is bearer-equivalent in practice while claiming otherwise, which is worse than ` +
        `an honest bearer token. That is an injection bug at the CP-006-13 boundary.`,
    );
  }
}
