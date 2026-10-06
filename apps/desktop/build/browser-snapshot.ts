// The main process's own V8 snapshot. The packaged app's `LoadBrowserProcessSpecificV8Snapshot`
// fuse makes the main process read `browser_v8_context_snapshot.bin` and every other process its
// usual `v8_context_snapshot*.bin`; Electron ships only the second, and a main process that finds
// no file of its own stops at start. This copies Electron's own snapshot under the main process's
// name, so the two processes read separate files and a renderer snapshot never reaches main.
// electron-builder runs it after packing, before it flips the fuses and signs, so the signature
// covers the copy.

import { copyFile, readdir } from "node:fs/promises";
import path from "node:path";

import type { AfterPackContext } from "electron-builder";

/** The file the fuse makes the main process load its V8 snapshot from. */
const BROWSER_SNAPSHOT_FILE = "browser_v8_context_snapshot.bin";

/** Electron's own snapshot: `v8_context_snapshot.bin`, or with the processor on macOS. */
const STOCK_SNAPSHOT_PATTERN = /^v8_context_snapshot(\.[a-z0-9_]+)?\.bin$/u;

/**
 * electron-builder's after-pack hook: gives the packaged app the main process's snapshot file.
 * Throws when the packaged app holds no single stock snapshot to copy.
 */
export async function afterPack(
  context: Pick<AfterPackContext, "appOutDir" | "electronPlatformName" | "packager">,
): Promise<void> {
  const snapshotFolder =
    context.electronPlatformName === "darwin"
      ? path.join(
          context.appOutDir,
          `${context.packager.appInfo.productFilename}.app`,
          "Contents/Frameworks/Electron Framework.framework/Resources",
        )
      : context.appOutDir;
  const stockSnapshots = (await readdir(snapshotFolder)).filter((name) =>
    STOCK_SNAPSHOT_PATTERN.test(name),
  );
  const [stockSnapshot] = stockSnapshots;
  if (stockSnapshot === undefined || stockSnapshots.length > 1) {
    throw new Error(
      `expected one V8 snapshot in ${snapshotFolder}, found ${stockSnapshots.length}: ` +
        stockSnapshots.join(", "),
    );
  }
  await copyFile(
    path.join(snapshotFolder, stockSnapshot),
    path.join(snapshotFolder, BROWSER_SNAPSHOT_FILE),
  );
}
