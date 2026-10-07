// An import progress stream a case drives by hand, shared by the hook's and the panel's suites.

import type { ProviderImportProgress } from "@ai-sidekicks/contracts/provider/import";

import type { ImportProgressStream } from "./progress.js";

/**
 * A progress stream a case drives message by message, fails, and whose closes it counts.
 *
 * The close is counted, not flagged, so a drain that closed twice (a double release on the live
 * wire) is caught.
 */
export class DrivenProgressStream implements ImportProgressStream {
  readonly #pending: ProviderImportProgress[] = [];
  #wake: (() => void) | undefined;
  #isClosed = false;
  #closeCount = 0;
  #failure: Error | undefined;

  public get events(): AsyncIterable<ProviderImportProgress> {
    return this.#iterate();
  }

  /** How many times the drain closed this stream. */
  public get closeCount(): number {
    return this.#closeCount;
  }

  public close(): void {
    this.#closeCount += 1;
    this.#isClosed = true;
    this.#wakeDrain();
  }

  /** Deliver one message to whatever is draining. */
  public emit(message: ProviderImportProgress): void {
    this.#pending.push(message);
    this.#wakeDrain();
  }

  /** Reject the drain part-way, the way a stream the service dropped does. */
  public fail(failure: Error): void {
    this.#failure = failure;
    this.#wakeDrain();
  }

  #wakeDrain(): void {
    this.#wake?.();
    this.#wake = undefined;
  }

  async *#iterate(): AsyncGenerator<ProviderImportProgress> {
    while (!this.#isClosed) {
      if (this.#failure !== undefined) {
        throw this.#failure;
      }
      const pending = this.#pending.shift();
      if (pending !== undefined) {
        yield pending;
        continue;
      }
      await new Promise<void>((resolve) => {
        this.#wake = resolve;
      });
    }
  }
}
