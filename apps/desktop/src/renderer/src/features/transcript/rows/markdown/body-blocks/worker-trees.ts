// The trees the worker parses for one body's blocks: each block too long for the page, and every
// block while the page's parser could not start. Each is asked for against its preamble once, from
// where the last ask stopped, held in the shared trees while the body holds it, and read from the
// body's own text when it is drawn, so the shared trees keep no copy of that text.

import type {
  MarkdownParseOutcome,
  MarkdownTrees,
} from "#renderer/components/Markdown/parse/trees.js";
import { startSlice } from "#renderer/lib/work-slices.js";
import type { Unsubscribe } from "#shared/preload-api.js";
import { type DefinitionsView } from "./definitions.js";
import { NO_STOP, type BlockGeneration, type HeldBlockTree } from "./generation.js";

/**
 * How a body's blocks are parsed: on the page; by the worker, every one, while the page's parser
 * could not start; or not yet, while the page's parser loads.
 */
export type ParseMode = "page" | "worker" | "waiting";

/**
 * Asks for, lands and holds the worker's trees of one body's blocks. `onLanded` hears each landed
 * tree that changes what the body draws, and `onFailed` each tree that could not be parsed.
 */
export class BlockWorkerTrees {
  readonly #trees: MarkdownTrees;
  readonly #onLanded: () => void;
  readonly #onFailed: (reason: string) => void;
  /** How far the trees were asked for, and against which definitions and mode. */
  #asked: TreesAsked | undefined;

  public constructor(
    trees: MarkdownTrees,
    onLanded: () => void,
    onFailed: (reason: string) => void,
  ) {
    this.#trees = trees;
    this.#onLanded = onLanded;
    this.#onFailed = onFailed;
  }

  /** Forgets how far the trees were asked for, so the next ask walks the blocks from the first. */
  public forgetAsks(): void {
    this.#asked = undefined;
  }

  /** Lets go of the trees the worker parsed for the blocks the page parses, once it can. */
  public dropPageParsed(generation: BlockGeneration): void {
    for (const [index, held] of generation.workerTrees) {
      if (!generation.isOverPageCap(index)) {
        held.stop();
        held.letLandedGo();
        generation.workerTrees.delete(index);
      }
    }
  }

  /**
   * Whether every block from `from` on that the worker parses has its tree against its preamble.
   */
  public haveLanded(
    generation: BlockGeneration,
    mode: ParseMode,
    definitions: DefinitionsView,
    from: number,
  ): boolean {
    for (let index = from; index < generation.records.count; index += 1) {
      if (
        isParsedByWorker(generation, index, mode) &&
        generation.workerTrees.get(index)?.landedPreamble !== definitions.preambleOf(index)
      ) {
        return false;
      }
    }
    return true;
  }

  /**
   * Takes the tree the shared trees keep of each block from `from` on that the worker parses and
   * that is not yet asked for against its preamble; `request` asks for it, and holds it, as for any
   * other.
   */
  public readKept(
    generation: BlockGeneration,
    mode: ParseMode,
    definitions: DefinitionsView,
    from: number,
  ): void {
    for (let index = from; index < generation.records.count; index += 1) {
      if (!isParsedByWorker(generation, index, mode)) {
        continue;
      }
      const preamble = definitions.preambleOf(index);
      const held = generation.workerTrees.get(index);
      if (held?.askedPreamble === preamble || held?.landedPreamble === preamble) {
        continue;
      }
      const kept = this.#trees.readSettledBlock(generation.readBlockSource(index), preamble, () =>
        generation.readBlockSource(index),
      );
      if (kept === undefined) {
        continue;
      }
      if (held === undefined) {
        generation.workerTrees.set(index, {
          askedPreamble: undefined,
          landedPreamble: preamble,
          tree: kept,
          stop: NO_STOP,
          letLandedGo: NO_STOP,
        });
      } else {
        held.tree = kept;
        held.landedPreamble = preamble;
      }
    }
  }

  /**
   * Asks for each tree the worker parses not yet asked for against its preamble, from where the
   * last ask stopped, so a frame costs the blocks settled since; and for a slice at most once one
   * is waiting: the tree that lands asks for the next slice, so a long reply read back asks for its
   * trees across tasks.
   */
  public request(generation: BlockGeneration, mode: ParseMode, definitions: DefinitionsView): void {
    const asked = this.#asked;
    let askedCount =
      asked?.generation === generation && asked.view === definitions && asked.mode === mode
        ? asked.count
        : 0;
    const hasTime = startSlice();
    let isWaiting = false;
    for (; askedCount < generation.records.count; askedCount += 1) {
      if (isWaiting && !hasTime()) {
        break;
      }
      if (!isParsedByWorker(generation, askedCount, mode)) {
        continue;
      }
      const preamble = definitions.preambleOf(askedCount);
      if (generation.workerTrees.get(askedCount)?.askedPreamble !== preamble) {
        isWaiting = this.#requestBlockTree(generation, askedCount, preamble) || isWaiting;
      }
    }
    this.#asked = { generation, view: definitions, mode, count: askedCount };
  }

  /** Asks for block `index`'s tree against `preamble`; answers whether the ask is waiting. */
  #requestBlockTree(generation: BlockGeneration, index: number, preamble: string): boolean {
    const held: HeldBlockTree = generation.workerTrees.get(index) ?? {
      askedPreamble: preamble,
      landedPreamble: undefined,
      tree: undefined,
      stop: NO_STOP,
      letLandedGo: NO_STOP,
    };
    held.stop();
    held.stop = NO_STOP;
    held.askedPreamble = preamble;
    generation.workerTrees.set(index, held);
    let answeredAtOnce: MarkdownParseOutcome | undefined;
    let isAsking = true;
    const letGo = this.#trees.holdSettledBlock(
      generation.readBlockSource(index),
      preamble,
      (outcome) => {
        if (isAsking) {
          answeredAtOnce = outcome;
          return;
        }
        this.#land(held, preamble, outcome, letGo);
      },
      () => generation.readBlockSource(index),
    );
    isAsking = false;
    // A kept tree, or a stand-in parser's, is answered before the ask returns.
    if (answeredAtOnce === undefined) {
      held.stop = letGo;
      return true;
    }
    this.#land(held, preamble, answeredAtOnce, letGo);
    return false;
  }

  /** Takes a block's landed tree, held in the shared trees in place of its last one. */
  #land(
    held: HeldBlockTree,
    preamble: string,
    outcome: MarkdownParseOutcome,
    letGo: Unsubscribe,
  ): void {
    held.stop = NO_STOP;
    if (outcome.status === "failed") {
      // Asked again once the body reads past the failure.
      held.askedPreamble = held.landedPreamble;
      this.#onFailed(outcome.reason);
      return;
    }
    held.letLandedGo();
    held.letLandedGo = letGo;
    // The tree a read drew from the shared trees, now held, changes nothing drawn.
    if (
      held.landedPreamble === preamble &&
      held.tree !== undefined &&
      this.#trees.isSameTree(held.tree, outcome)
    ) {
      return;
    }
    held.tree = outcome;
    held.landedPreamble = preamble;
    this.#onLanded();
  }
}

/** Whether the worker parses block `index`: one too long for the page, or every one in `worker`. */
export function isParsedByWorker(
  generation: BlockGeneration,
  index: number,
  mode: ParseMode,
): boolean {
  return mode === "worker" || generation.isOverPageCap(index);
}

/** How far the worker's trees were asked for, and against what. */
interface TreesAsked {
  readonly generation: BlockGeneration;
  readonly view: DefinitionsView;
  readonly mode: ParseMode;
  readonly count: number;
}
