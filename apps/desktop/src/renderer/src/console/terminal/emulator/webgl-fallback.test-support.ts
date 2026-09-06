// The one collaborator this environment cannot supply: a renderer that activates.
//
// The DOM shim has no WebGL2, so the real `WebglAddon.activate` throws before a context
// exists and no instance in this directory's other suites is ever on the renderer that
// can lose one. This module stands in that ONE library and nothing else — the emulator,
// the adapter, the pool, the loader, and the component are all the real ones, and the
// fallback under test is the adapter's own private path reached through the addon's own
// event.
//
// WHY THE THREE SUITES THAT USE IT ARE SEPARATE FILES. `vi.mock` is module-scoped:
// applied in `xterm-adapter.test.ts` it would put every one of that file's cases on a
// renderer this environment does not have, which is the opposite of what they assert.
// So each consumer declares the mock itself, resolving THIS class through the factory's
// own dynamic import so all three drive one fake rather than three.
//
// The live-emulator registry is `xterm-adapter.test-support.ts`'s. What is added here
// is the state that is only reachable when a renderer really activates: the fake's
// instance list, and the page-wide ledger a component reaches through the adapter's
// default pool.

import {
  terminalRendererPool,
  TerminalRendererPool,
  type TerminalContextLease,
} from "./renderer-pool.js";

/**
 * A renderer that activates, then loses its context on demand.
 *
 * Every instance registers itself, which is how a test reaches the one an adapter built
 * for itself — a component's adapter is not a value the test holds.
 */
export class FakeWebglRenderer {
  public static readonly live: FakeWebglRenderer[] = [];
  readonly #contextLossListeners: (() => void)[] = [];

  public constructor() {
    FakeWebglRenderer.live.push(this);
  }

  /** `ITerminalAddon`'s half. Loading it is what makes the instance `webgl`. */
  public activate(): void {
    // The real addon compiles shaders here. Nothing to do for a fake context.
  }

  public dispose(): void {
    this.#contextLossListeners.length = 0;
  }

  public onContextLoss(listener: () => void): { dispose: () => void } {
    this.#contextLossListeners.push(listener);
    return {
      dispose: (): void => {
        this.#contextLossListeners.length = 0;
      },
    };
  }

  /** What the GPU driver does, as something a test can do. */
  public loseContext(): void {
    for (const listener of [...this.#contextLossListeners]) {
      listener();
    }
  }
}

/**
 * The real ledger, refusing the first N acquisitions and accounting normally after.
 *
 * A subclass and not a stand-in, for `xterm-adapter.test-support.ts`'s reason: the
 * accounting is the real one and only the answer to the first call is staged. It exists
 * for the PREMISE case — that a second `attach()` really does re-enter the renderer
 * selection — which would be unprovable against a pool that always says yes, because an
 * instance that already holds an addon short-circuits before the ledger is asked.
 */
export class LateGrantingRendererPool extends TerminalRendererPool {
  #refusalsLeft: number;

  public constructor(refusalsLeft: number) {
    super();
    this.#refusalsLeft = refusalsLeft;
  }

  public override acquire(terminalId: string): TerminalContextLease | undefined {
    if (this.#refusalsLeft > 0) {
      this.#refusalsLeft -= 1;
      return undefined;
    }
    return super.acquire(terminalId);
  }
}

/** The renderer the newest adapter built for itself. */
export function newestRenderer(): FakeWebglRenderer {
  const renderer = FakeWebglRenderer.live.at(-1);
  if (renderer === undefined) {
    throw new Error("no renderer was built, so no context can be lost");
  }
  return renderer;
}

/**
 * The half of the teardown that only exists because a renderer really activated.
 *
 * Run AFTER `disposeLiveEmulators`, which is what disposes the adapters that hold these
 * renderers. The page ledger is module state a component reaches through the adapter's
 * default pool: a mount here really does take a slot — the fake activates where the real
 * addon throws — and no context exists behind it, so the allowance goes back rather than
 * staying spent.
 */
export function resetWebglFallback(componentTerminalIds: readonly string[] = []): void {
  FakeWebglRenderer.live.length = 0;
  for (const terminalId of componentTerminalIds) {
    terminalRendererPool.reclaimEveryContextFor(terminalId);
  }
}
