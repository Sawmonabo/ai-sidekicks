// A row's command output prepared as the feed prepares it, for a test that draws the output's box
// outside a feed.

import { publishedTextOf, type PublishedText } from "#renderer/lib/text/published.js";
import { PreparedBodies } from "../prepared-bodies.js";
import { AnsiOutputPreparation } from "./preparation.js";

/** One row's output being prepared: where its box reads it, and when its first parse is whole. */
export interface PreparedOutputForTest {
  /** What the box's context provides. */
  readonly outputs: PreparedBodies;
  /** Settles once the output first read is parsed whole. */
  readonly whole: Promise<void>;
  /** Stops the slices and drops the output. */
  release(): void;
}

/** Prepares `output`, a row's command output, under `rowKey`, in this window's slices. */
export function prepareOutputForTest(
  rowKey: string,
  output: string | PublishedText,
): PreparedOutputForTest {
  const outputs = new PreparedBodies();
  let landWhole: () => void = () => undefined;
  const whole = new Promise<void>((resolve) => {
    landWhole = resolve;
  });
  const preparation = new AnsiOutputPreparation(rowKey, outputs, window, () => {
    landWhole();
  });
  preparation.read(typeof output === "string" ? publishedTextOf(output) : output, "view");
  if (preparation.isReady) {
    landWhole();
  }
  return {
    outputs,
    whole,
    release: () => {
      preparation.release();
    },
  };
}
