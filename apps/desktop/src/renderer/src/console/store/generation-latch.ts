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
// WHAT THIS IS NOT. It is not a queue: a second press is REFUSED, audibly, by the
// caller that asked. A membership change held and applied later is a second act
// nobody re-confirmed, against a row whose state may have moved underneath it. It is
// not a scheduler either — a burst collapsing into one read is `store/scheduling.ts`.

import { useEffect, useState } from "react";

/**
 * One taken claim: the right to settle a key, until something supersedes it.
 *
 * Handed out rather than represented by a returned boolean, so the settlement path
 * cannot re-derive which key it holds and get it wrong. Both methods are total and
 * idempotent, which is what lets a caller put {@link release} in a `finally`-shaped
 * position and {@link settle} on every arm without asking whether it still applies.
 */
export interface GenerationClaim {
  /** Whether this claim still owns its key. False once superseded or released. */
  readonly isCurrent: boolean;
  /**
   * Run `apply` if this claim still owns its key, and answer whether it ran.
   *
   * Does not release: settling and giving the key back are two acts, and a caller
   * that shows a settlement while another act is still forbidden — a control that
   * stays disabled until its own cleanup runs — needs them apart.
   */
  settle(apply: () => void): boolean;
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
    const serials = this.#serialsFor(subject);
    if (serials.has(key)) {
      return undefined;
    }
    this.#issuedClaims += 1;
    const serial = this.#issuedClaims;
    serials.set(key, serial);
    // Read through the register on every question rather than closing over the table
    // taken above: `supersedeAll` REPLACES that table, and a claim holding the old one
    // would go on reporting itself current against a register nothing else can see.
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
      release: (): void => {
        if (!isCurrent()) {
          return;
        }
        const held = this.#serialsBySubject.get(subject);
        if (held === undefined) {
          return;
        }
        held.delete(key);
        this.#dropIfEmpty(subject, held);
      },
    };
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
