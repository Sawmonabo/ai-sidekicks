// Key and signature material the device and trust-statement tests share, kept as one body.

/** Base64 of `length` bytes, for a key or signature whose length is what a schema checks. */
export function base64Bytes(length: number): string {
  return Buffer.alloc(length, 7).toString("base64");
}

/** A P-256 identity public key at its 65-byte uncompressed length. */
export const P256_KEY: { readonly algorithm: "p256"; readonly publicKey: string } = {
  algorithm: "p256",
  publicKey: base64Bytes(65),
};
