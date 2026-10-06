// A renderer that activates, which this environment cannot supply: the DOM shim has no WebGL2,
// so the real `WebglAddon` throws before a context exists. Only that library is stood in.
// `vi.mock` is module-scoped, so each consumer declares it in its own file (mocking it in
// `xterm/adapter.test.ts` would move all of that file's cases onto a renderer they do not assert).

import { TerminalRendererPool, type TerminalContextLease } from "./renderer-pool.js";

/**
 * A renderer that activates, then loses its context on demand. Instances register themselves,
 * so a test can reach the one an adapter built internally.
 */
export class FakeWebglRenderer {
  public static readonly live: FakeWebglRenderer[] = [];
  readonly #contextLossListeners: (() => void)[] = [];

  public constructor() {
    FakeWebglRenderer.live.push(this);
  }

  /** `ITerminalAddon`'s half. Loading it is what makes the instance `webgl`. */
  public activate(): void {
    // Nothing to activate for a fake context.
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
 * The real pool refusing the first N acquisitions. It proves that a second `attach()`
 * re-enters the renderer selection, which an always-granting pool cannot: an instance that
 * already holds an addon returns before the pool is asked.
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

/** Forget every stand-in renderer; run after `disposeLiveEmulators`. */
export function resetWebglFallback(): void {
  FakeWebglRenderer.live.length = 0;
}
