// Tests for the outbound-credential seam. No real provider exists yet, so these cover the
// refusing stub, which names the attempt in its diagnostic, and the consumer-side guard, which
// refuses a bearer or proofless credential (RFC 9449 section 7.1) without echoing the token.

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

describe("DeferredDaemonCredentialProvider", () => {
  it("refuses every mint rather than returning empty headers", async () => {
    // Empty headers would let the caller send an unauthenticated request, and the operator
    // would then chase a generic control-plane 401 instead of the real cause.
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

describe("assertDpopCredentialMaterial", () => {
  it("accepts a DPoP-schemed token accompanied by a proof header", () => {
    expect(() => assertDpopCredentialMaterial(wellFormedMaterial())).not.toThrow();
  });

  it("REFUSES a Bearer-schemed credential", () => {
    // A bearer credential is replayable by anyone who reads it from a log, a proxy buffer or a
    // crash dump, and a permissive control plane would accept it, so nothing else catches it.
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
    // Refusing `dpop` would reject a conforming provider; the guard targets `Bearer`, not
    // capitalization.
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
    // Header names are case-insensitive (RFC 9110 section 5.1) and `Headers` lowercases every
    // name it stores. An exact-match read would refuse this conforming provider and report "no
    // Authorization header", naming the wrong cause.
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
    // Treating a separator-less value as the scheme would put the whole token in the message,
    // and a refusal message gets logged or stored.
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

    // No substring of the token may appear, not just the whole token: any run of the credential
    // in a stored message is still a leak.
    for (let start = 0; start < bareToken.length; start += 1) {
      for (let end = start + 6; end <= bareToken.length; end += 1) {
        expect(message).not.toContain(bareToken.slice(start, end));
      }
    }
  });

  it("REFUSES a bare scheme with no token after it", () => {
    // Without this check, a value with no space would be read as the scheme alone, `"DPoP"`
    // would compare equal, and an empty credential would reach the wire.
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
    // Without the proof the token is bearer-equivalent while claiming otherwise, which is worse
    // than an honest bearer token: a reader who sees `DPoP` assumes possession was proven.
    expect(() =>
      assertDpopCredentialMaterial({
        headers: {
          [AUTHORIZATION_HEADER_NAME]: `${DPOP_AUTHORIZATION_SCHEME} v4.public.fake-paseto-token`,
        },
      }),
    ).toThrow(new RegExp(`no ${DPOP_PROOF_HEADER_NAME} proof header`));
  });
});
