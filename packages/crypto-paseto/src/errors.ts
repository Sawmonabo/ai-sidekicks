// Messages are structural only: they never carry key, signature, plaintext or ciphertext bytes.

/** Thrown when a token is malformed or fails verification; its message names the failed check. */
export class InvalidTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidTokenError";
  }
}

/** Thrown when a key or nonce has the wrong length, or a key ring breaks its invariants. */
export class InvalidKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidKeyError";
  }
}

/** An {@link InvalidTokenError} for a v4.local token whose authentication tag does not match. */
export class MacMismatchError extends InvalidTokenError {
  constructor(message: string = "MAC mismatch") {
    super(message);
    this.name = "MacMismatchError";
  }
}
