// SecureDefaultOverrideEmitter: emits each `security.default.override` event at most once per
// process, keyed by the `behavior` integer (1-10). The event goes to whatever sink the daemon
// bootstrap installs with `setSink`, so this module stays independent of the event consumer.
//
// `behavior` travels as an integer; the mapping to the banner's string token (for example
// `insecure_bind`) lives with the banner, not here. Payload shape is trusted from the
// in-process caller and is not validated at runtime.

/**
 * Payload of a `security.default.override` event. `behavior` (1-10) identifies the override
 * and is the dedupe key: emissions sharing it collapse to one sink call even when `row`,
 * `effective_value` or `banner_printed_at` differ. `row` is an optional sub-row
 * discriminator (`7a` or `7b` for behavior 7), typed as `string` so other behaviors can
 * carry one. `banner_printed_at` is an ISO-8601 timestamp stamped by the banner code; the
 * emitter never generates it, so the two modules share one clock source.
 */
export interface SecurityDefaultOverrideEvent {
  readonly behavior: number;
  readonly row?: string;
  readonly effective_value: string;
  readonly banner_printed_at: string;
}

/**
 * Receives each override event synchronously, because the emission sites are synchronous.
 * A sink may throw; the error propagates to the caller of `emit`, but the behavior is
 * already marked emitted, so a retry never produces a second event.
 */
export type SecurityDefaultOverrideSink = (event: SecurityDefaultOverrideEvent) => void;

// Module singleton: the installed sink and the behaviors already emitted in this process.
// The class is static-only, like `SecureDefaults`, so callers need no instance; the cost is
// the test-only `__resetForTest()`.
let installedSink: SecurityDefaultOverrideSink | null = null;
const emittedBehaviors: Set<number> = new Set<number>();

/** Emits each override event at most once per process, to the sink installed by `setSink`. */
export class SecureDefaultOverrideEmitter {
  // Static-only: a stray `new SecureDefaultOverrideEmitter()` must not bypass the singleton.
  private constructor() {
    throw new Error("SecureDefaultOverrideEmitter: use static methods, not `new`");
  }

  /**
   * Installs the sink; call it before any `emit`. A second call replaces the sink but keeps
   * the dedupe state, because "once" spans the whole process, not one sink.
   */
  static setSink(sink: SecurityDefaultOverrideSink): void {
    installedSink = sink;
  }

  /**
   * Passes the event to the sink the first time its `behavior` is seen; later calls with the
   * same `behavior` are no-ops whatever the other fields say. Different behaviors emit
   * independently. The behavior is marked before the sink runs, so a throwing sink cannot
   * be retried into a duplicate.
   *
   * @throws Error when no sink is installed. The check runs before the mark, so an early
   * emit does not use up the behavior's single event.
   */
  static emit(event: SecurityDefaultOverrideEvent): void {
    if (installedSink === null) {
      throw new Error(
        "SecureDefaultOverrideEmitter.emit: SecureDefaultOverrideEmitter.setSink(sink) must be called before emit() (orchestrator wiring is owed)",
      );
    }
    if (emittedBehaviors.has(event.behavior)) {
      return;
    }
    // Marked before the sink runs so a sink failure cannot cause a second emission.
    emittedBehaviors.add(event.behavior);
    installedSink(event);
  }

  /** True once `setSink` has installed a sink in this process. */
  static hasSink(): boolean {
    return installedSink !== null;
  }

  /**
   * True once `emit` has been called with this `behavior`. For tests and wiring checks;
   * production code should rely on `emit` being idempotent instead of branching on this.
   */
  static hasEmitted(behavior: number): boolean {
    return emittedBehaviors.has(behavior);
  }

  /** Test-only: clears the sink and the dedupe set, since Vitest shares one process. */
  static __resetForTest(): void {
    installedSink = null;
    emittedBehaviors.clear();
  }
}
