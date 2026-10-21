// The WebAuthn checks of the Worker's passkey verify legs, run by @simplewebauthn/server. Each
// function takes the library's options as a JSON string and answers its verdict as a JSON string,
// so only plain strings cross wasm-bindgen. Every throw, which is how the library refuses all but
// a bad signature, answers `{"verified": false}`, and a refused verdict carries nothing else; the
// thrown message is logged first, so a fault on the Worker's side shows in its logs.
import { ed25519 } from "@noble/curves/ed25519.js";
import { verifyAuthenticationResponse, verifyRegistrationResponse } from "@simplewebauthn/server";
import { cose, decodeCredentialPublicKey, isoBase64URL } from "@simplewebauthn/server/helpers";

// The machines' verifier imports RSA keys of at most this many modulus bits.
const RSA_MODULUS_BITS_MAX = 8192;

const REFUSED = JSON.stringify({ verified: false });

// Logs what `leg` threw and answers the refusal.
function refuseThrown(leg, error) {
  console.error(`passkey ${leg} check threw: ${error instanceof Error ? error.message : error}`);
  return REFUSED;
}

function countBits(bytes) {
  const first = bytes.findIndex((byte) => byte !== 0);
  return first < 0 ? 0 : (bytes.length - first) * 8 - (Math.clz32(bytes[first]) - 24);
}

// Whether a verified passkey's key is one the machines' verifier refuses: an RSA modulus over
// 8,192 bits, or an Ed25519 point that is small-order; a point that is not canonical throws in
// `fromBytes`, which refuses it too.
function isRefusedKey(coseKey) {
  const algorithm = coseKey.get(cose.COSEKEYS.alg);
  if (algorithm === cose.COSEALG.RS256) {
    return countBits(coseKey.get(cose.COSEKEYS.n)) > RSA_MODULUS_BITS_MAX;
  }
  if (algorithm === cose.COSEALG.EdDSA) {
    return ed25519.Point.fromBytes(coseKey.get(cose.COSEKEYS.x)).isSmallOrder();
  }
  return false;
}

export async function verifyRegistration(checkJson) {
  try {
    const result = await verifyRegistrationResponse(JSON.parse(checkJson));
    if (!result.verified) return REFUSED;
    const info = result.registrationInfo;
    const coseKey = decodeCredentialPublicKey(info.credential.publicKey);
    if (isRefusedKey(coseKey)) return REFUSED;
    return JSON.stringify({
      verified: true,
      credentialId: info.credential.id,
      publicKey: {
        coseAlgorithm: coseKey.get(cose.COSEKEYS.alg),
        coseKey: isoBase64URL.fromBuffer(info.credential.publicKey),
      },
      aaguid: info.aaguid,
      counter: info.credential.counter,
    });
  } catch (error) {
    return refuseThrown("registration", error);
  }
}

export async function verifyAuthentication(checkJson) {
  try {
    const check = JSON.parse(checkJson);
    check.credential.publicKey = isoBase64URL.toBuffer(check.credential.publicKey);
    const result = await verifyAuthenticationResponse(check);
    if (!result.verified) return REFUSED;
    return JSON.stringify({ verified: true, newCounter: result.authenticationInfo.newCounter });
  } catch (error) {
    return refuseThrown("authentication", error);
  }
}
