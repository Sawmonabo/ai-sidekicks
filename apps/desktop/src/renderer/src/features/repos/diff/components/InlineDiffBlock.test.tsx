// A tool call's file with no patch to draw keeps its block: it says why in one line, draws a patch
// it cannot read as sent and copies that text as sent, and a moved empty file says where it moved
// from with no count of lines under it.

import type { TranscriptPatchFile } from "@ai-sidekicks/contracts/transcript/operations";
import { act, fireEvent, render, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { createStubBridge, type TextClipboardContent } from "#shared/preload-api.js";
import { createLiveBridge } from "#renderer/services/platform/live-bridge.js";
import { FIXTURE_APP_META, FIXTURE_WINDOW_ID } from "#renderer/services/platform/bridge.fixture.js";
import { bridgeWrapper } from "#test/helpers/app/frame-fixtures.js";
import { withAlignmentWorker } from "#test/helpers/diff/alignment-worker.js";
import { diffModelFromPatchList } from "../read-model.js";
import { DiffFlowRowsByFile } from "../rows/flow.js";
import { InlineDiffBlock } from "./InlineDiffBlock.js";

/** A patch the provider sent in a form this version cannot read, with a byte no ASCII holds. */
const RAW_PATCH = "*** Begin Patch\n*** Update File: docs/café.md\r\n+naïve line\n*** End Patch\n";

/** The block of a call's one left-out file, and every text the block's copies wrote. */
function drawBlock(file: TranscriptPatchFile): {
  readonly block: HTMLElement;
  readonly copied: readonly string[];
} {
  const copied: string[] = [];
  const liveBridge = createLiveBridge(createStubBridge({ ...FIXTURE_APP_META }, FIXTURE_WINDOW_ID));
  const bridge = {
    ...liveBridge,
    native: {
      ...liveBridge.native,
      copyToClipboard: (content: TextClipboardContent) => {
        copied.push(content.text);
        return Promise.resolve();
      },
    },
  };
  const model = diffModelFromPatchList([{ files: [file], next: null }], {
    baseRef: "main",
    headRef: "feature",
  });
  const { container } = render(
    <InlineDiffBlock
      file={model.files[0] ?? expectFile()}
      rowKey="row-1"
      flowRows={new DiffFlowRowsByFile(model).rowsOf(0)}
      flowHeightPx={600}
      rowHeightPx={20}
      isOpen={false}
      onOpen={() => undefined}
    />,
    { wrapper: withAlignmentWorker(bridgeWrapper(bridge)) },
  );
  const block = container.querySelector<HTMLElement>(".meridian-diff-block");
  if (block === null) {
    throw new Error("no block was drawn");
  }
  return { block, copied };
}

function expectFile(): never {
  throw new Error("the model holds no file");
}

function noteOf(block: HTMLElement): string | null | undefined {
  return block.querySelector(".meridian-diff-block__note")?.textContent;
}

describe("InlineDiffBlock — a file whose patch cannot be drawn", () => {
  it("says no patch was sent, with nothing to copy", () => {
    const { block } = drawBlock({ path: "src/gone.ts", unavailable: "absent" });
    expect(noteOf(block)).toBe("no patch was sent for this file");
    expect(block.querySelector(".meridian-diff-block__footer")).toBeNull();
  });

  it("says its stored text is damaged, with no lines and no Copy patch", () => {
    const { block } = drawBlock({ path: "src/torn.ts", unavailable: "damaged" });
    expect(noteOf(block)).toBe("this change's stored text is damaged");
    expect(block.querySelector(".meridian-diff-block__raw")).toBeNull();
    expect(block.querySelector(".meridian-diff-block__footer")).toBeNull();
  });

  it("draws a patch it cannot read as sent and copies it byte for byte", async () => {
    const { block, copied } = drawBlock({
      path: "docs/café.md",
      oldPath: "docs/cafe.md",
      unavailable: "unreadable",
      rawPatch: RAW_PATCH,
    });
    expect(noteOf(block)).toBe(
      "renamed from docs/cafe.md, this version cannot read this change — shown as sent",
    );
    expect(block.querySelector(".meridian-diff-block__raw")?.textContent).toBe(RAW_PATCH);
    const footer = block.querySelector<HTMLElement>(".meridian-diff-block__footer");
    // No count of lines: the text was never read as lines of a diff.
    expect(footer?.textContent).toBe("Copy patch");

    await act(async () => {
      fireEvent.click(within(block).getByRole("button", { name: "Copy patch" }));
      await Promise.resolve();
    });
    expect(copied).toStrictEqual([RAW_PATCH]);
  });
});

describe("InlineDiffBlock — a moved file with no lines", () => {
  it("says where it moved from where its lines would be, with no count and no Show all", () => {
    const { block } = drawBlock({
      path: "src/next.ts",
      oldPath: "src/previous.ts",
      patch: "",
      additions: 0,
      deletions: 0,
    });
    expect(noteOf(block)).toBe("renamed from src/previous.ts");
    expect(block.querySelector(".meridian-diff-block__footer")).toBeNull();
    expect(within(block).queryByRole("button", { name: "Show all" })).toBeNull();
  });
});
