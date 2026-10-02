// Whether an act may be dispatched at all, and what its reply may do. A handler settles "may I
// dispatch" inside its own tick, because a rendered flag belongs to the render that produced the
// handler and two presses in one frame would both dispatch.
//
// Each claim takes a serial that is never reissued, and a settlement is admitted only while its
// key still names that serial: a mutation that reached the daemon has happened, so a superseded
// reply is ignored rather than aborted. Keys are per subject, held weakly and released on
// settlement. Nothing is queued, since a held press would be an act nobody re-confirmed.

/**
 * A handle on the round a key is on: whether it is still live, and one settlement.
 *
 * What {@link GenerationLatch.currentClaim} answers with; both members are total. It cannot give
 * the key back, so a reader folding a reply into an outstanding write cannot revoke that write's
 * single flight.
 */
export interface CurrentGenerationClaim {
  /** Whether this round is still the one the key is on. False once superseded. */
  readonly isCurrent: boolean;
  /**
   * Run `apply` if this round is still live, and answer whether it ran.
   *
   * Settling does not release the key of a round somebody else took, so a control can stay
   * disabled until its own cleanup runs. The one round a settlement ends is the one
   * `currentClaim` minted on a free key.
   */
  settle(apply: () => void): boolean;
}

/**
 * One taken claim: the right to settle a key and to give it back. `release` is total and
 * idempotent, so it can sit in a `finally`.
 */
export interface GenerationClaim extends CurrentGenerationClaim {
  /** Give the key back if this claim still owns it. Every other key is untouched. */
  release(): void;
}

/**
 * The single-flight register: which keys have an act in flight, under which subject. One instance
 * per mount or holder, never a module-level singleton.
 */
export class GenerationLatch {
  // Monotonic and never reissued, so a key re-claimed after a supersede takes a number no
  // outstanding claim holds.
  #issuedClaims = 0;
  #serialsBySubject = new WeakMap<object, Map<string, number>>();

  /** Take one key's claim, or `undefined` because that key already holds one. */
  public claim(subject: object, key: string): GenerationClaim | undefined {
    return this.#serialsFor(subject).has(key) ? undefined : this.#takeKey(subject, key);
  }

  /**
   * Abandon whatever holds this key and take it. Never refuses.
   *
   * For the caller whose newest intent wins (a durable write, a re-typed preference): an act in
   * flight is superseded, so its settlement installs nothing. It is one act, so no third caller
   * can take the key in between.
   */
  public supersedeAndClaim(subject: object, key: string): GenerationClaim {
    return this.#takeKey(subject, key);
  }

  /**
   * A handle on whichever round is running for this key, minting one where none is.
   *
   * For the caller that measures a settlement it did not start. It supersedes nothing, and the
   * handle and the taker's claim go stale together. It mints rather than answering `undefined`
   * so the caller need not handle a refusal; a minted round ends on its own settlement, since
   * nobody else could give the key back. A caller wanting one round across several settlements
   * uses `claim` or `supersedeAndClaim`.
   */
  public currentClaim(subject: object, key: string): CurrentGenerationClaim {
    const serial = this.#serialsBySubject.get(subject)?.get(key);
    return serial === undefined
      ? this.#mintedRoundFor(subject, key)
      : this.#claimOfSerial(subject, key, serial);
  }

  /**
   * Abandon whatever is in flight for one key, and free it to be claimed again.
   *
   * For a holder whose subject moved out from under a call. Nothing is canceled: the reply
   * installs nowhere, so an older answer cannot overwrite a newer settlement.
   */
  public supersede(subject: object, key: string): void {
    const serials = this.#serialsBySubject.get(subject);
    if (serials === undefined) {
      return;
    }
    serials.delete(key);
    this.#dropIfEmpty(subject, serials);
  }

  /**
   * Abandon every claim under every subject and free every key; the unmount and teardown path.
   * The register is replaced, not emptied, so a settlement still traveling finds no key naming
   * its serial however the caller re-claims.
   */
  public supersedeAll(): void {
    this.#serialsBySubject = new WeakMap<object, Map<string, number>>();
  }

  /**
   * Whether one key has an act in flight right now, without taking it.
   *
   * For a caller that must refuse because a key is held (a retry offered against a running
   * continuation). It races the next claim; a caller whose correctness needs the key free when
   * it dispatches uses `claim`, which decides and takes in one act.
   */
  public isHeld(subject: object, key: string): boolean {
    return this.#serialsBySubject.get(subject)?.has(key) ?? false;
  }

  /** How many keys this subject currently holds; read by tests, never on a render path. */
  public heldKeyCount(subject: object): number {
    return this.#serialsBySubject.get(subject)?.size ?? 0;
  }

  // The one place a key is taken. Writing over a serial retires whatever held it.
  #nextSerialFor(subject: object, key: string): number {
    this.#issuedClaims += 1;
    const serial = this.#issuedClaims;
    this.#serialsFor(subject).set(key, serial);
    return serial;
  }

  // The full claim: the round's two questions plus the release the taker performs when it chooses.
  #takeKey(subject: object, key: string): GenerationClaim {
    const serial = this.#nextSerialFor(subject, key);
    const round = this.#claimOfSerial(subject, key, serial);
    return {
      get isCurrent(): boolean {
        return round.isCurrent;
      },
      settle: (apply: () => void): boolean => round.settle(apply),
      release: (): void => {
        this.#releaseSerial(subject, key, serial);
      },
    };
  }

  // The handle for the caller that started a round and the one that joined, written once so they
  // answer alike. It carries no release, so the joiner's narrowing is structural.
  #claimOfSerial(subject: object, key: string, serial: number): CurrentGenerationClaim {
    // Read through the register each time: `supersedeAll` replaces the table, and a claim holding
    // the old one would keep reporting itself current.
    const isCurrent = (): boolean => this.#serialsBySubject.get(subject)?.get(key) === serial;
    return {
      get isCurrent(): boolean {
        return isCurrent();
      },
      settle: (apply: () => void): boolean => {
        if (!isCurrent()) {
          return false;
        }
        apply();
        return true;
      },
    };
  }

  // The guard keeps an abandoned act from freeing the key its successor holds.
  #releaseSerial(subject: object, key: string, serial: number): void {
    const held = this.#serialsBySubject.get(subject);
    if (held === undefined || held.get(key) !== serial) {
      return;
    }
    held.delete(key);
    this.#dropIfEmpty(subject, held);
  }

  // Its release goes through the same guarded path, so a minted round cannot free its successor's
  // key. `finally` so an `apply` that throws does not leave the key held; the throw still
  // reaches the caller.
  #mintedRoundFor(subject: object, key: string): CurrentGenerationClaim {
    const serial = this.#nextSerialFor(subject, key);
    const round = this.#claimOfSerial(subject, key, serial);
    return {
      get isCurrent(): boolean {
        return round.isCurrent;
      },
      settle: (apply: () => void): boolean => {
        try {
          return round.settle(apply);
        } finally {
          this.#releaseSerial(subject, key, serial);
        }
      },
    };
  }

  #serialsFor(subject: object): Map<string, number> {
    const held = this.#serialsBySubject.get(subject);
    if (held !== undefined) {
      return held;
    }
    const created = new Map<string, number>();
    this.#serialsBySubject.set(subject, created);
    return created;
  }

  // Bounds the register by the life of a key, not only of a subject.
  #dropIfEmpty(subject: object, serials: Map<string, number>): void {
    if (serials.size === 0) {
      this.#serialsBySubject.delete(subject);
    }
  }
}
