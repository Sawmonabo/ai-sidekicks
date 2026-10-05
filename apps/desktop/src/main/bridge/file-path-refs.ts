// The renderer never holds a path: a picked file comes back as a `FilePathRef` token and main
// keeps the path. A token stays valid while the page that received it lives, because later
// bridge calls take it again; the page's tokens are dropped when the page is destroyed.

import { randomUUID } from "node:crypto";

import type { FilePathRef } from "@shared/preload-api.js";

/** The page a token was minted for: its id, and a way to hear that it has gone. */
export interface FilePathRefOwner {
  readonly id: number;
  once(event: "destroyed", listener: () => void): unknown;
}

/** Main's table from the tokens it handed a page to the paths they stand for. */
export class FilePathRefs {
  readonly #pathsByOwner = new Map<number, Map<FilePathRef, string>>();

  /** A fresh token for `path`, held for `owner` until it is destroyed. */
  public mint(owner: FilePathRefOwner, path: string): FilePathRef {
    let paths = this.#pathsByOwner.get(owner.id);
    if (paths === undefined) {
      paths = new Map();
      this.#pathsByOwner.set(owner.id, paths);
      owner.once("destroyed", () => {
        this.#pathsByOwner.delete(owner.id);
      });
    }
    const ref = randomUUID() as FilePathRef;
    paths.set(ref, path);
    return ref;
  }

  /** The path a token stands for, while the page it was minted for is open. */
  public pathOf(owner: FilePathRefOwner, ref: FilePathRef): string | undefined {
    return this.#pathsByOwner.get(owner.id)?.get(ref);
  }

  /**
   * The path behind a token the page sent. Throws a `TypeError` for anything that is not a token
   * this page holds, so a page can never name a path, or reach another page's file.
   */
  public requirePath(owner: FilePathRefOwner, ref: unknown): string {
    const path = typeof ref === "string" ? this.pathOf(owner, ref as FilePathRef) : undefined;
    if (path === undefined) {
      throw new TypeError("That file reference is not one this window was given.");
    }
    return path;
  }
}
