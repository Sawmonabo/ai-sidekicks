// The renderer never holds a path: a picked file comes back as a `FilePathRef` token and main
// keeps the path. A token stays valid while the document that received it is loaded, because later
// bridge calls take it again; the page's tokens are dropped when it loads a new document, after a
// reload or a crash, and when it is destroyed. Each token is minted for one purpose, and each verb
// that takes one accepts only its own, so a file picked to import is never an export's destination.

import { randomUUID } from "node:crypto";

import type { FilePathRef } from "#shared/preload-api.js";

/**
 * What a token was minted for: a file to attach, a file to import, a folder picked, or a path a
 * daemon reply offers to open.
 */
export type FilePathPurpose = "attach" | "import" | "folder" | "open";

/**
 * The page a token was minted for: its id, whether it has gone, and a way to hear that it goes or
 * loads a new document.
 */
export interface FilePathRefOwner {
  readonly id: number;
  isDestroyed(): boolean;
  once(event: "destroyed", listener: () => void): unknown;
  on(event: "did-navigate", listener: () => void): unknown;
}

/** Main's table from the tokens it handed a page to the paths they stand for. */
export class FilePathRefs {
  readonly #pagesById = new Map<number, PageTokens>();

  /**
   * The token for `path` minted for `owner` and `purpose`, the one already handed out when there
   * is one, so a page that asks again for the same path grows nothing. Throws for a page that has
   * gone, which would never drop the token.
   */
  public mint(owner: FilePathRefOwner, purpose: FilePathPurpose, path: string): FilePathRef {
    if (owner.isDestroyed()) {
      throw new Error("The window asking for a file reference has closed.");
    }
    const page = this.#pageOf(owner);
    const key = mintKey(purpose, path);
    const known = page.refsByMintKey.get(key);
    if (known !== undefined) {
      return known;
    }
    const ref = randomUUID() as FilePathRef;
    page.refsByMintKey.set(key, ref);
    page.mintsByRef.set(ref, { purpose, path });
    return ref;
  }

  /** The path a token stands for, while the document it was minted for is loaded. */
  public pathOf(owner: FilePathRefOwner, ref: FilePathRef): string | undefined {
    return this.#pagesById.get(owner.id)?.mintsByRef.get(ref)?.path;
  }

  /**
   * The path behind a token the page sent for `purpose`. Throws a `TypeError` for anything that is
   * not a token this page holds for that purpose, so a page can never name a path, reach another
   * page's file, or hand one verb a file picked for another.
   */
  public requirePath(owner: FilePathRefOwner, ref: unknown, purpose: FilePathPurpose): string {
    const mint =
      typeof ref === "string"
        ? this.#pagesById.get(owner.id)?.mintsByRef.get(ref as FilePathRef)
        : undefined;
    if (mint === undefined || mint.purpose !== purpose) {
      throw new TypeError("That file reference is not one this window was given for this.");
    }
    return mint.path;
  }

  #pageOf(owner: FilePathRefOwner): PageTokens {
    const known = this.#pagesById.get(owner.id);
    if (known !== undefined) {
      return known;
    }
    const page: PageTokens = { refsByMintKey: new Map(), mintsByRef: new Map() };
    this.#pagesById.set(owner.id, page);
    owner.on("did-navigate", () => {
      page.refsByMintKey.clear();
      page.mintsByRef.clear();
    });
    owner.once("destroyed", () => {
      this.#pagesById.delete(owner.id);
    });
    return page;
  }
}

/** One page's tokens: each by what it was minted for, and what each stands for. */
interface PageTokens {
  readonly refsByMintKey: Map<string, FilePathRef>;
  readonly mintsByRef: Map<
    FilePathRef,
    { readonly purpose: FilePathPurpose; readonly path: string }
  >;
}

// A purpose holds no NUL and a path cannot contain one, so the key names one pair.
function mintKey(purpose: FilePathPurpose, path: string): string {
  return `${purpose}\0${path}`;
}
