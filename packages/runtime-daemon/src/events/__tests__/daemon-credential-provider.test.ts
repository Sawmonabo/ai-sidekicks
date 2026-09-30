// Outbound-credential seam.
//
// The provider implementation is deferred (PASETO auth), so what is testable
// today is: the refusing stub refuses with a diagnostic that names the
// deferral and the attempt, and the consumer-side guard refuses a bearer or
// proofless credential (RFC 9449 section 7.1) without echoing the token.

import { describe, expect, it } from "vitest";

import type { NodeId, SessionId } from "@ai-sidekicks/contracts";

import {
  assertDpopCredentialMaterial,
  AUTHORIZATION_HEADER_NAME,
  DPOP_AUTHORIZATION_SCHEME,
  DPOP_PROOF_HEADER_NAME,
  DeferredDaemonCredentialProvider,
  type DaemonCredentialMaterial,
} from "../daemon-credential-provider.js";

// ----------------------------------------------------------------------------
// Fixtures
// ----------------------------------------------------------------------------

const SESSION_ID = "01970000-0000-7000-8000-00000000a001" as SessionId;
const NODE_ID = "node-alpha" as NodeId;
const ATTEMPT_URI = "https://control-plane.test/trpc/session.read";

function wellFormedMaterial(): DaemonCredentialMaterial {
  return {
    headers: {
      [AUTHORIZATION_HEADER_NAME]: `${DPOP_AUTHORIZATION_SCHEME} v4.public.fake-paseto-token`,
      [DPOP_PROOF_HEADER_NAME]: "fake.dpop.proof",
    },
  };
}

// ----------------------------------------------------------------------------
// The Refusing stub
// ----------------------------------------------------------------------------

describe("DeferredDaemonCredentialProvider", () => {
  it("refuses every mint rather than returning empty headers", async () => {
    // A no-op provider returning `{}` would let the caller issue an
    // unauthenticated request, and the operator would then debug a generic
    // control-plane 401 instead of the actual cause.
    const provider = new DeferredDaemonCredentialProvider();
    await expect(
      provider.mintForAttempt({
        sessionId: SESSION_ID,
        nodeId: NODE_ID,
        htm: "POST",
        htu: ATTEMPT_URI,
      }),
    ).rejects.toThrow(/deferred/);
  });

  it("names the deferral and the attempt in the diagnostic", async () => {
    const provider = new DeferredDaemonCredentialProvider();
    const rejection = await provider
      .mintForAttempt({
        sessionId: SESSION_ID,
        nodeId: NODE_ID,
        htm: "POST",
        htu: ATTEMPT_URI,
      })
      .catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(Error);
    const message = (rejection as Error).message;
    expect(message).toContain("deferred (PASETO auth)");
    expect(message).toContain(`POST ${ATTEMPT_URI}`);
    expect(message).toContain(SESSION_ID);
    expect(message).toContain(NODE_ID);
  });
});

// ----------------------------------------------------------------------------
// The consumer-side guard — RFC 9449 section 7.1
// ----------------------------------------------------------------------------

describe("assertDpopCredentialMaterial", () => {
  it("accepts a DPoP-schemed token accompanied by a proof header", () => {
    expect(() => assertDpopCredentialMaterial(wellFormedMaterial())).not.toThrow();
  });

  it("REFUSES a Bearer-schemed credential", () => {
    // The load-bearing arm. A bearer credential on this path is replayable by
    // anyone who reads it from a log, a proxy buffer, or a crash dump — and this
    // endpoint writes the audit log's integrity witness. It would also SUCCEED
    // against a permissive control plane, so nothing else would catch it.
    expect(() =>
      assertDpopCredentialMaterial({
        headers: {
          [AUTHORIZATION_HEADER_NAME]: "Bearer v4.public.fake-paseto-token",
          [DPOP_PROOF_HEADER_NAME]: "fake.dpop.proof",
        },
      }),
    ).toThrow(/RFC 9449 section 7.1/);
  });

  it("accepts a case-varied scheme spelling (RFC 9110 section 11.1 makes schemes case-insensitive)", () => {
    // Refusing `dpop` would reject a CONFORMING provider. The guard exists to
    // catch `Bearer`, not to police capitalization.
    for (const scheme of ["dpop", "DPOP", "DPoP"]) {
      expect(() =>
        assertDpopCredentialMaterial({
          headers: {
            [AUTHORIZATION_HEADER_NAME]: `${scheme} v4.public.fake-paseto-token`,
            [DPOP_PROOF_HEADER_NAME]: "fake.dpop.proof",
          },
        }),
      ).not.toThrow();
    }
  });

  it("REFUSES a missing or empty Authorization header", () => {
    expect(() =>
      assertDpopCredentialMaterial({ headers: { [DPOP_PROOF_HEADER_NAME]: "fake.dpop.proof" } }),
    ).toThrow(new RegExp(`no ${AUTHORIZATION_HEADER_NAME} header`));

    expect(() =>
      assertDpopCredentialMaterial({
        headers: {
          [AUTHORIZATION_HEADER_NAME]: "",
          [DPOP_PROOF_HEADER_NAME]: "fake.dpop.proof",
        },
      }),
    ).toThrow();
  });

  it("reads the headers case-insensitively (a Headers-derived provider lowercases them)", () => {
    // RFC 9110 section 5.1: header names are case-insensitive, and `Headers` normalizes
    // every name it stores to lowercase. An exact-match read would refuse this
    // CONFORMING provider while reporting "no Authorization header" — naming the
    // wrong cause, on the one boundary whose diagnostics an operator has to
    // trust.
    expect(() =>
      assertDpopCredentialMaterial({
        headers: {
          authorization: `${DPOP_AUTHORIZATION_SCHEME} v4.public.fake-paseto-token`,
          dpop: "fake.dpop.proof",
        },
      }),
    ).not.toThrow();
  });

  it("REFUSES a separator-less value WITHOUT echoing one byte of it", () => {
    // A scheme fallback that treated a separator-less value as the scheme
    // itself would interpolate the whole token into the message, and a
    // refusal message is the kind of text that gets logged or stored.
    const bareToken = "v4.public.SUPERSECRETTOKENBYTES.deadbeef";
    let raised: unknown;
    try {
      assertDpopCredentialMaterial({
        headers: {
          [AUTHORIZATION_HEADER_NAME]: bareToken,
          [DPOP_PROOF_HEADER_NAME]: "fake.dpop.proof",
        },
      });
    } catch (error: unknown) {
      raised = error;
    }

    expect(raised).toBeInstanceOf(Error);
    const message = (raised as Error).message;
    expect(message).toContain("no scheme separator");

    // Not merely "does not contain the whole token" — NO substring of it. A
    // message quoting any run of the credential is still a credential on disk.
    for (let start = 0; start < bareToken.length; start += 1) {
      for (let end = start + 6; end <= bareToken.length; end += 1) {
        expect(message).not.toContain(bareToken.slice(start, end));
      }
    }
  });

  it("REFUSES a bare scheme with no token after it", () => {
    // This passed the old guard outright: `indexOf(" ") === -1` made the whole
    // value the scheme, `"DPoP"` compared equal, and an empty credential went to
    // the wire to come back as a generic 401.
    expect(() =>
      assertDpopCredentialMaterial({
        headers: {
          [AUTHORIZATION_HEADER_NAME]: DPOP_AUTHORIZATION_SCHEME,
          [DPOP_PROOF_HEADER_NAME]: "fake.dpop.proof",
        },
      }),
    ).toThrow(/no scheme separator/);

    expect(() =>
      assertDpopCredentialMaterial({
        headers: {
          [AUTHORIZATION_HEADER_NAME]: `${DPOP_AUTHORIZATION_SCHEME}   `,
          [DPOP_PROOF_HEADER_NAME]: "fake.dpop.proof",
        },
      }),
    ).toThrow(/no token after it/);
  });

  it("REFUSES a DPoP-schemed token with no proof header", () => {
    // Without the proof the token is bearer-equivalent in practice while
    // CLAIMING otherwise, which is worse than an honest bearer token: every
    // reviewer downstream sees `DPoP` and assumes possession was proven.
    expect(() =>
      assertDpopCredentialMaterial({
        headers: {
          [AUTHORIZATION_HEADER_NAME]: `${DPOP_AUTHORIZATION_SCHEME} v4.public.fake-paseto-token`,
        },
      }),
    ).toThrow(new RegExp(`no ${DPOP_PROOF_HEADER_NAME} proof header`));
  });
});
