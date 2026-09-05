// Whether an act may be dispatched at all, and what its reply is allowed to do.
//
// THE MUTABLE HALF OF `subject-scoped-state.ts`'s RULE. That holder answers what a
// surface RENDERS for the subject it is bound to. This one answers a question a
// handler has to settle inside its own tick, before any render: a rendered flag read
// there is the one from the render that produced the handler, so two presses in one
// frame both find the surface idle and both dispatch — two durable records for one
// intended act, and two replies racing to decide which settlement is shown.
//
// SIX COPIES OF THIS WERE WRITTEN ACROSS FIVE FAMILIES, each with its own field
// name, its own paragraph explaining the same three-line invariant, and its own
// predicate. The place copies of a guard drift is the predicate, and a drifted
// predicate is a stale value on screen that every test still passes.
//
// A MONOTONIC SERIAL, NOT AN `AbortController`. Nothing behind the bridge is
// cancellable: a call is started and then settles or does not. So a superseded reply
// is IGNORED, and claiming its call was stopped would be a claim this console cannot
// honour. Every claim takes a serial from one counter that never reissues a number,
// and a settlement is admitted only while the key it holds still names that serial.
//
// THE KEY IS WHAT THE RULE IS ABOUT, AND IT IS NEVER THE MOUNT. "One in flight" is
// one per subject: one goal mutation per session, one send per composer address, one
// control per run, one compaction per target. A boolean per mounted component said
// otherwise — a surface re-addressed while a call was outstanding refused the NEW
// subject's first act as though it already had one settling, and a call that never
// answered refused it for as long as that surface stayed mounted. A caller whose rule
// is one act at a time across every row states that by claiming ONE key, rather than
// by asking this object for a mode it does not have.
//
// A SUBJECT IS A LIVE OBJECT AND IS HELD WEAKLY. A bridge, a growth port, a session
// store, or a holder that has no subject of its own and passes itself: each is
// something whose replacement retires the calls made through it, which is what
// identity comparison expresses, and a subject that becomes unreachable takes its keys
// with it rather than pinning them to a root. Within a live subject the register is
// bounded the other way, by RELEASE: a settled key is removed, so a long-lived bridge
// accumulates nothing across a session's worth of runs.
//
// NEVER TERMINAL. `supersedeAll` is what a teardown calls, and React invokes an
// effect's cleanup between the two invocations strict mode makes of one effect — a
// latch whose teardown killed it would be dead for the rest of the mount's life.
// Being superseded and being disposed are two different facts, and only one of them
// is reversible; a caller that has a genuinely terminal state keeps its own flag.
//
// THREE WAYS TO TAKE A KEY, BECAUSE THREE QUESTIONS ARE ASKED OF ONE REGISTER. A run
// control asks whether it may dispatch at all, and the honest answer to a second press
// is no — `claim`, which refuses. A durable write asks the opposite question: the
// newest intent is the one the person is waiting on, so whatever is in flight is
// abandoned and the new act is ALWAYS admitted — `supersedeAndClaim`. And a reader
// asks which round is running, so a settlement it did not itself start can still be
// measured against the round that did — `currentClaim`, which joins the live round and
// mints one where none is. The settlement path is written once whichever question
// admitted it, and refusing is a property of `claim` rather than of the register.
//
// GIVING THE KEY BACK IS THE TAKER'S ACT ALONE, and that is why the reader's handle is
// a NARROWER TYPE rather than the same one. Single flight is the one property this
// object exists to supply, and a handle that reports on a round it did not start could
// otherwise revoke it: `release()` in the `finally`-shaped position the interface
// invites would delete the key out from under a write still in flight, and the next
// press would dispatch a duplicate. So {@link CurrentGenerationClaim} carries the two
// questions a joiner has — is this round still live, and may this settlement install —
// and carries no third. Where `currentClaim` MINTS the round (the key was free), the
// joiner is both taker and settler, so that round ends on its own settlement rather
// than being held for the life of the subject by a reader that never gives keys back.
//
// WHAT THIS IS NOT. It is not a queue: a second press is REFUSED by `claim`, audibly,
// by the caller that asked, and SUPERSEDED by `supersedeAndClaim` — never held and
// applied later. A membership change held and applied later is a second act nobody
// re-confirmed, against a row whose state may have moved underneath it. It is not a
// scheduler either — a burst collapsing into one read is `store/scheduling.ts`.

import { useEffect, useState } from "react";

/**
 * A handle on the round a key is on: whether it is still live, and one settlement.
 *
 * What {@link GenerationLatch.currentClaim} answers with, and the half of a claim
 * that is safe to hand a caller that did not start the round. Handed out rather than
 * represented by a returned boolean, so the settlement path cannot re-derive which
 * key it holds and get it wrong. Both members are total, which is what lets a caller
 * ask on every arm without first asking whether it still applies.
 *
 * IT CANNOT GIVE THE KEY BACK. That is the difference from {@link GenerationClaim}
 * and it is the whole of it: the claim that took the key keeps it, so a reader
 * folding a reply into an outstanding write cannot revoke the single flight that
 * write is relying on.
 */
export interface CurrentGenerationClaim {
  /** Whether this round is still the one the key is on. False once superseded. */
  readonly isCurrent: boolean;
  /**
   * Run `apply` if this round is still live, and answer whether it ran.
   *
   * Settling does not release the key of a round somebody else took: settling and
   * giving the key back are two acts, and a caller that shows a settlement while
   * another act is still forbidden — a control that stays disabled until its own
   * cleanup runs — needs them apart. The one round a settlement DOES end is the one
   * `currentClaim` minted on a free key, where the settler is also the taker.
   */
  settle(apply: () => void): boolean;
}

/**
 * One taken claim: the right to settle a key AND to give it back.
 *
 * What the two entry points that take a key for a caller answer with. `release` is
 * total and idempotent, which is what lets a caller put it in a `finally`-shaped
 * position without asking whether this claim still owns anything.
 */
export interface GenerationClaim extends CurrentGenerationClaim {
  /** Give the key back if this claim still owns it. Every other key is untouched. */
  release(): void;
}

/**
 * The single-flight register: which keys have an act in flight, under which subject.
 *
 * ONE INSTANCE PER MOUNT OR PER HOLDER, never a module-level singleton. Its size is
 * bounded by the live subjects (weakly held) and, within a subject, by the keys not
 * yet released.
 */
export class GenerationLatch {
  /**
   * The serial every claim is stamped with. Monotonic and never reissued, which is
   * the whole generation mechanism: a key re-claimed after a supersede takes a number
   * no outstanding claim can be holding, so no epoch counter is needed beside it.
   */
  #issuedClaims = 0;
  #serialsBySubject = new WeakMap<object, Map<string, number>>();

  /**
   * Take one key's slot, or answer `undefined` because that key already holds it.
   *
   * `undefined` rather than a claim that reports itself stale, so a caller cannot
   * dispatch first and discover afterwards that it was not admitted.
   */
  public claim(subject: object, key: string): GenerationClaim | undefined {
    return this.#serialsFor(subject).has(key) ? undefined : this.#takeKey(subject, key);
  }

  /**
   * Abandon whatever holds this key and take it. Never refuses.
   *
   * For the caller whose rule is that the NEWEST intent wins: a durable write, a
   * preference the person re-typed, a view state re-derived from a later read. The
   * answer they are waiting on is the one they asked for last, so an act still in
   * flight is superseded rather than allowed to refuse them — and superseded means
   * exactly what it means everywhere else here, that its settlement installs nothing.
   *
   * One act, not a `supersede` followed by a `claim`: writing the new serial over the
   * old one IS the abandonment, so there is no instant at which the key is free and a
   * third caller could take it in between.
   */
  public supersedeAndClaim(subject: object, key: string): GenerationClaim {
    return this.#takeKey(subject, key);
  }

  /**
   * A handle on whichever round is running for this key, minting one where none is.
   *
   * For the caller that has to measure a settlement it did not itself start — a
   * reader folding a reply into whatever write is outstanding, a control asking
   * whether the round it is rendering against is still the live one. It supersedes
   * nothing: the claim that took the key keeps it, and this handle reports and settles
   * against the SAME round, so both go stale together the moment anything supersedes
   * it. And it cannot give that key back, which is a property of the TYPE it answers
   * with rather than a rule a caller has to remember.
   *
   * Minting where the key is free rather than answering `undefined`, because the
   * caller's question is "which round am I in", and a caller that had to answer
   * "none, so I will start one" would be writing `claim`'s refusal handling for a
   * question that never refuses. A minted round ends on its own settlement: nobody
   * else took that key, so nobody else can give it back, and a reader that treated
   * the handle as read-only would otherwise hold it for the life of the subject and
   * refuse every later act on it. A caller that needs one round across SEVERAL
   * settlements is asking to hold a key, which is `claim` or `supersedeAndClaim`.
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
   * For the holder whose SUBJECT moved out from under a call: the projection the
   * reply was read against has been replaced, or the session it was asked of has.
   * Nothing is cancelled — the reply simply installs nowhere — so releasing the key
   * here cannot let an older answer overwrite a newer settlement.
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
   * Abandon every claim under every subject, and free every key.
   *
   * The unmount and teardown path. Replacing the register rather than emptying it is
   * what makes the abandoned generation unreachable instead of merely cleared: a
   * settlement still travelling holds a serial, and serials are never reissued, so it
   * finds no key naming it however the caller re-claims afterwards.
   */
  public supersedeAll(): void {
    this.#serialsBySubject = new WeakMap<object, Map<string, number>>();
  }

  /**
   * How many keys this subject currently holds.
   *
   * The register's bound, observable. Read by the endurance assertion that a
   * settled-and-released key leaves nothing behind; nothing on a render path reads it.
   */
  public heldKeyCount(subject: object): number {
    return this.#serialsBySubject.get(subject)?.size ?? 0;
  }

  /**
   * Stamp this key with the next serial, and answer which one it took.
   *
   * The one place a key is taken. Writing over an existing serial retires whatever
   * held it — the serial is the whole generation mechanism — so the difference
   * between the three public entry points is which of them is willing to reach here,
   * and never how the register is written.
   */
  #nextSerialFor(subject: object, key: string): number {
    this.#issuedClaims += 1;
    const serial = this.#issuedClaims;
    this.#serialsFor(subject).set(key, serial);
    return serial;
  }

  /**
   * Take a key for the caller that will also give it back.
   *
   * The full claim: the round's two questions plus the release that ends it, which is
   * an act the taker performs when it chooses rather than one a settlement implies.
   */
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

  /**
   * The handle on one round, for the caller that started it and the one that joined.
   *
   * Written once so a joined handle cannot answer a question differently from the
   * claim that took the key — and it carries NO release, so the narrowing the joiner
   * gets is structural rather than a type over an object that has one anyway. A
   * caller that reached past the type would find nothing there to call.
   */
  #claimOfSerial(subject: object, key: string, serial: number): CurrentGenerationClaim {
    // Read through the register on every question rather than closing over the table
    // this key was written into: `supersedeAll` REPLACES that table, and a claim
    // holding the old one would go on reporting itself current against a register
    // nothing else can see.
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

  /**
   * Give one key back, if the round asking is still the one holding it.
   *
   * The guard is what keeps an abandoned act from freeing the key its successor
   * holds, and it is written here once because two paths perform a release: the taker
   * that was handed one, and the round `currentClaim` mints on a free key, whose own
   * settlement ends it.
   */
  #releaseSerial(subject: object, key: string, serial: number): void {
    const held = this.#serialsBySubject.get(subject);
    if (held === undefined || held.get(key) !== serial) {
      return;
    }
    held.delete(key);
    this.#dropIfEmpty(subject, held);
  }

  /**
   * Take a free key for a joiner, and hand back a round its settlement ends.
   *
   * The release goes through the same guarded path every other one does — a no-op
   * once anything has superseded the round — which is what keeps a minted round from
   * freeing the key its successor holds. `finally` rather than a call after the
   * settlement, because a caller's `apply` that throws must not leave the key held
   * for the life of the subject; the throw still reaches the caller.
   */
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

  /**
   * Drop a subject's empty table.
   *
   * The weak reference already bounds the register by the LIFE of a subject; this
   * bounds it by the life of a key, so a bridge that outlives a thousand runs holds
   * one entry per run in flight rather than one per run ever dispatched.
   */
  #dropIfEmpty(subject: object, serials: Map<string, number>): void {
    if (serials.size === 0) {
      this.#serialsBySubject.delete(subject);
    }
  }
}

/**
 * One latch for the life of a mount, superseded on unmount.
 *
 * The teardown is what makes a settlement arriving after the surface is gone a no-op
 * rather than a write into a register a remount would inherit — and because
 * `supersedeAll` is not terminal, the remount strict mode performs immediately
 * afterwards starts idle rather than wedged.
 */
export function useGenerationLatch(): GenerationLatch {
  const [latch] = useState(() => new GenerationLatch());
  useEffect(() => {
    return () => {
      latch.supersedeAll();
    };
  }, [latch]);
  return latch;
}
