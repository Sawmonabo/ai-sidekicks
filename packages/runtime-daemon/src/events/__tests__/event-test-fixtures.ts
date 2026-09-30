// Test doubles and helpers shared by the event tests.

import { blake3 } from "@noble/hashes/blake3.js";

import type { PiiEncryptionRequest, PiiEncryptor } from "../pii-indirection.js";
import type { DaemonMasterKeySource } from "../session-content-key-store.js";

/** Renders bytes as continuous lowercase hex, so a failure diffs as text. */
export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

let eventCounter = 0;

/** A fresh event id, unique within one test file. */
export function nextEventId(): string {
  eventCounter += 1;
  return `evt-${String(eventCounter).padStart(4, "0")}`;
}

/**
 * A 12-byte pseudo-nonce prefix, so the stub's output has the `iv || ciphertext || tag` shape of
 * the real codec without its properties.
 */
const TEST_NONCE_PREFIX: Uint8Array = new TextEncoder().encode("test-nonce--");

/**
 * The PII encryptor stub: an XOR over a BLAKE3 keystream seeded by the user id and event id. Not an
 * AEAD; deterministic, so the ciphertext differs for every (user, event) pair and a test can name
 * it. The call count shows whether a refusal fired before the encrypt step.
 */
export class DeterministicPiiEncryptor implements PiiEncryptor {
  #encryptCallCount = 0;
  #lastRequest: PiiEncryptionRequest | null = null;

  get encryptCallCount(): number {
    return this.#encryptCallCount;
  }

  get lastRequest(): PiiEncryptionRequest | null {
    return this.#lastRequest;
  }

  encrypt(request: PiiEncryptionRequest): Promise<Uint8Array> {
    this.#encryptCallCount += 1;
    this.#lastRequest = request;
    const keystream = blake3(new TextEncoder().encode(`${request.userId} ${request.eventId}`), {
      dkLen: Math.max(1, request.plaintext.length),
    });
    const sealed = new Uint8Array(TEST_NONCE_PREFIX.length + request.plaintext.length);
    sealed.set(TEST_NONCE_PREFIX, 0);
    for (let index = 0; index < request.plaintext.length; index++) {
      sealed[TEST_NONCE_PREFIX.length + index] =
        (request.plaintext[index] ?? 0) ^ (keystream[index] ?? 0);
    }
    return Promise.resolve(sealed);
  }
}

/** The injected master-key seam; a test swaps the key, fails the read, or runs code mid-read. */
export class ScriptedMasterKeySource implements DaemonMasterKeySource {
  key: Uint8Array;
  failure: Error | undefined;
  readCallCount = 0;
  /**
   * Runs inside one read, after the key is captured and before the promise resolves. It models a
   * source that obtained the master key before a rotation and resolves with it after, which lets a
   * first mint wrap under a destroyed master.
   */
  beforeRead: (() => void) | undefined;

  constructor(key: Uint8Array) {
    this.key = key;
  }

  read(): Promise<Uint8Array> {
    this.readCallCount += 1;
    if (this.failure !== undefined) return Promise.reject(this.failure);
    const capturedKey = this.key;
    this.beforeRead?.();
    return Promise.resolve(capturedKey);
  }
}
