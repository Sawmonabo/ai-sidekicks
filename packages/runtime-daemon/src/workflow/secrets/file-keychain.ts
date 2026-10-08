// The keychain entries kept where the operating system's keychain cannot be used, on Linux when
// no Secret Service answers: the daemon's one items file, `secrets.json` in its data folder, readable by this
// account alone (mode 0600). The file holds each value under its keychain service and account,
// so the daemon's other secrets share it, and the values in it are not encrypted.
//
// Every call reads the disk, so no copy of a value stays in memory, and the calls on one file run
// one at a time, so two writes never lose each other; each write replaces the whole file at once.
// A file that is not an items file refuses every call and is never rewritten, because rewriting
// it would lose every secret it holds.
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { writeFileAtomically } from "../../atomic-file-write.js";
import { WorkflowSecretStoreUnavailableError, type SecretKeychain } from "./keychain.js";

const SECRETS_FILE_NAME = "secrets.json";
const SECRETS_FILE_MODE = 0o600;
const DATA_FOLDER_MODE = 0o700;

// Each keychain service's values, by account.
const ItemsFileSchema = z.record(z.string(), z.record(z.string(), z.string()));
type ItemsFile = z.infer<typeof ItemsFileSchema>;

// The last call queued on each items file, shared by every keychain over that file.
const pendingCallByFile = new Map<string, Promise<unknown>>();

/** One keychain service's entries in the daemon's `secrets.json` items file. */
export class FileSecretKeychain implements SecretKeychain {
  /** The items file's full path, which the daemon names to the person while it keeps secrets. */
  readonly filePath: string;
  readonly #dataFolder: string;
  readonly #service: string;

  constructor(dataFolder: string, service: string) {
    this.filePath = path.join(dataFolder, SECRETS_FILE_NAME);
    this.#dataFolder = dataFolder;
    this.#service = service;
  }

  write(account: string, value: string): Promise<void> {
    return this.#call(async () => {
      const items = await this.#readItems();
      await this.#writeItems({
        ...items,
        [this.#service]: { ...items[this.#service], [account]: value },
      });
    });
  }

  read(account: string): Promise<string | undefined> {
    return this.#call(async () => {
      const entries = (await this.#readItems())[this.#service];
      return entries !== undefined && Object.hasOwn(entries, account)
        ? entries[account]
        : undefined;
    });
  }

  remove(account: string): Promise<boolean> {
    return this.#call(async () => {
      const items = await this.#readItems();
      const entries = items[this.#service];
      if (entries === undefined || !Object.hasOwn(entries, account)) {
        return false;
      }
      const { [account]: _removed, ...kept } = entries;
      await this.#writeItems({ ...items, [this.#service]: kept });
      return true;
    });
  }

  // Runs `operation` after every call already queued on the file, and reports any failure of the
  // file as the keychain being unavailable.
  #call<Result>(operation: () => Promise<Result>): Promise<Result> {
    const queued = pendingCallByFile.get(this.filePath) ?? Promise.resolve();
    const result = queued.then(operation).catch((error: unknown) => {
      if (error instanceof WorkflowSecretStoreUnavailableError) {
        throw error;
      }
      throw new WorkflowSecretStoreUnavailableError(
        "unavailable",
        error instanceof Error ? error.message : String(error),
      );
    });
    pendingCallByFile.set(
      this.filePath,
      result.catch(() => undefined),
    );
    return result;
  }

  async #readItems(): Promise<ItemsFile> {
    let text: string;
    try {
      text = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return {};
      }
      throw error;
    }
    // The parser's own message quotes the file's text, which holds secret values, so it is
    // never carried.
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new WorkflowSecretStoreUnavailableError("unavailable", this.#notAnItemsFile());
    }
    const items = ItemsFileSchema.safeParse(parsed);
    if (!items.success) {
      throw new WorkflowSecretStoreUnavailableError("unavailable", this.#notAnItemsFile());
    }
    return items.data;
  }

  async #writeItems(items: ItemsFile): Promise<void> {
    await mkdir(this.#dataFolder, { recursive: true, mode: DATA_FOLDER_MODE });
    await writeFileAtomically(this.filePath, JSON.stringify(items), SECRETS_FILE_MODE);
  }

  #notAnItemsFile(): string {
    return `${this.filePath} is not a secrets file, so it is left as it is`;
  }
}
