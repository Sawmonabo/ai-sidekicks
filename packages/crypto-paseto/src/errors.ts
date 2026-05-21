/**
 * Error taxonomy for `@ai-sidekicks/crypto-paseto`.
 *
 * Messages are structural only — they carry no key, signature, plaintext,
 * or ciphertext bytes (invariant I4 in the design spec §5).
 */

export class InvalidTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidTokenError";
  }
}

export class InvalidKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidKeyError";
  }
}

export class MacMismatchError extends InvalidTokenError {
  constructor(message: string = "MAC mismatch") {
    super(message);
    this.name = "MacMismatchError";
  }
}
