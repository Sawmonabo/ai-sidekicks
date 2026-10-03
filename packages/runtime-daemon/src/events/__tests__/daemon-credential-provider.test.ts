// The outbound credential guard refuses a bearer or proofless credential, which anyone who reads
// it could replay, and never echoes the token into its refusal message.

import { describe, expect, it } from "vitest";

import {
  assertDpopCredentialMaterial,
  AUTHORIZATION_HEADER_NAME,
  DPOP_AUTHORIZATION_SCHEME,
  DPOP_PROOF_HEADER_NAME,
} from "../daemon-credential-provider.js";

describe("assertDpopCredentialMaterial", () => {
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
