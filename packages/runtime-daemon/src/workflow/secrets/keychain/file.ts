// The keychain entries kept where the operating system's keychain cannot be used, on Linux with
// no Secret Service and on a Mac whose service runs while the person is logged out: the daemon's
// one items file, `secrets.json` in its data folder, readable by this account alone (mode 0600).
// The file holds each value under its keychain service and account, so the daemon's other
// secrets can share it, and the values in it are not encrypted.
//
// Every call reads the disk, so no copy of a value stays in memory, and in this process the calls
// on one file run one at a time, so two writes never lose each other; another process writes the
// file only while the daemon is stopped, as the data folder's lock ensures. Each write replaces
// the whole file at once, and the first call on the file deletes the temporary files a write cut
// short left behind, since each holds every value. An items file that cannot be read refuses
// every call and is never rewritten, because rewriting it would lose every secret it holds.
import { readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";

import pLimit, { type LimitFunction } from "p-limit";
import { z } from "zod";

import { writeFileAtomically } from "../../../file/atomic-write.js";
import { isMissingFileError } from "../../../file/missing-error.js";
import { WorkflowSecretStoreUnavailableError, type SecretKeychain } from "../store.js";

const ITEMS_FILE_NAME = "secrets.json";
const ITEMS_FILE_MODE = 0o600;

// Each keychain service's values, by account.
const ItemsFileSchema = z.record(z.string(), z.record(z.string(), z.string()));
type ItemsFile = z.infer<typeof ItemsFileSchema>;

// The calls on one items file, shared by every keychain over that file.
interface FileCallQueue {
  readonly run: LimitFunction;
  hasRemovedLeftovers: boolean;
}

const callQueueByFile = new Map<string, FileCallQueue>();

/**
 * One keychain service's entries in the daemon's `secrets.json` items file. The data folder must
 * exist, readable by this account alone, as the daemon makes it at start.
 */
export class FileSecretKeychain implements SecretKeychain {
  /** The items file's full path, which the daemon names to the person while it keeps secrets. */
  readonly filePath: string;
  readonly #service: string;

  constructor(dataFolder: string, service: string) {
    this.filePath = path.join(path.resolve(dataFolder), ITEMS_FILE_NAME);
    this.#service = service;
  }

  write(account: string, value: string): Promise<void> {
    return this.#call(async () => {
      const items = await this.#readItems();
      const entries = { ...items[this.#service], [account]: value };
      await this.#writeItems({ ...items, [this.#service]: entries });
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

  // Queues `operation` behind every call already queued on the file, after removing the
  // leftovers of a cut-short write, and reports any failure of the file as the keychain being
  // unavailable.
  #call<Result>(operation: () => Promise<Result>): Promise<Result> {
    let callQueue = callQueueByFile.get(this.filePath);
    if (callQueue === undefined) {
      callQueue = { run: pLimit(1), hasRemovedLeftovers: false };
      callQueueByFile.set(this.filePath, callQueue);
    }
    const queue = callQueue;
    return queue.run(async () => {
      try {
        if (!queue.hasRemovedLeftovers) {
          await this.#removeLeftoverTemporaryFiles();
          queue.hasRemovedLeftovers = true;
        }
        return await operation();
      } catch (error) {
        if (error instanceof WorkflowSecretStoreUnavailableError) {
          throw error;
        }
        throw new WorkflowSecretStoreUnavailableError("unavailable", failureText(error), error);
      }
    });
  }

  // A write cut short leaves `secrets.json.<random>.tmp` beside the file.
  async #removeLeftoverTemporaryFiles(): Promise<void> {
    const folder = path.dirname(this.filePath);
    const prefix = `${ITEMS_FILE_NAME}.`;
    const names = await readdir(folder);
    const leftovers = names.filter((name) => name.startsWith(prefix) && name.endsWith(".tmp"));
    await Promise.all(leftovers.map((name) => rm(path.join(folder, name), { force: true })));
  }

  async #readItems(): Promise<ItemsFile> {
    let text: string;
    try {
      text = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (isMissingFileError(error)) {
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
      throw this.#unreadableItemsFile();
    }
    const items = ItemsFileSchema.safeParse(parsed);
    if (!items.success) {
      throw this.#unreadableItemsFile();
    }
    return items.data;
  }

  async #writeItems(items: ItemsFile): Promise<void> {
    await writeFileAtomically(this.filePath, JSON.stringify(items), ITEMS_FILE_MODE);
  }

  #unreadableItemsFile(): WorkflowSecretStoreUnavailableError {
    return new WorkflowSecretStoreUnavailableError(
      "unavailable",
      `${this.filePath} is not an items file, so it is left as it is`,
    );
  }
}

// The file system's own text; for a write whose cleanup failed too, the write's failure first.
function failureText(error: unknown): string {
  const failure = error instanceof AggregateError ? error.errors[0] : error;
  return failure instanceof Error ? failure.message : String(failure);
}
