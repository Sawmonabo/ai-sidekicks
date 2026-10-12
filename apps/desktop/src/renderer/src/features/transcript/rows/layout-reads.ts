// The layout reads rows' bodies make as a commit mounts them: an output's cut and an output
// window's lines. The conversation writes each inserted row's place as it measures it, between the
// rows' effects, so a read in each effect lays the rows out again; made together once the commit
// is done, and before the frame paints, the inserted rows are laid out once, and the answers drawn
// together in one render.

import { flushSync } from "react-dom";

/**
 * Runs `read` once the task's synchronous work is done, with every other read asked for meanwhile,
 * before the frame paints; the state each read sets draws in one render after the last. The
 * returned call drops `read` unrun.
 */
export function requestLayoutRead(read: () => void): () => void {
  return layoutReads.request(read);
}

/** The reads waiting for the task's synchronous work to end. */
class LayoutReads {
  readonly #pending = new Set<() => void>();

  public request(read: () => void): () => void {
    if (this.#pending.size === 0) {
      queueMicrotask(() => {
        this.#readPending();
      });
    }
    this.#pending.add(read);
    return () => {
      this.#pending.delete(read);
    };
  }

  #readPending(): void {
    const reads = [...this.#pending];
    this.#pending.clear();
    if (reads.length === 0) {
      return;
    }
    // Every read is made before any answer draws, so only the first lays the page out.
    flushSync(() => {
      for (const read of reads) {
        read();
      }
    });
  }
}

const layoutReads = new LayoutReads();
