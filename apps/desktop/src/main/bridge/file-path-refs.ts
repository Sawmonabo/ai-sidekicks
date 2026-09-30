// The renderer never holds a path: a picked file comes back as a `FilePathRef` token and main
// keeps the path. Tokens die with the page that received them, which bounds the table.

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
}
