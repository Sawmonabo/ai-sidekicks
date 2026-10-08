// The items file holds every secret the daemon keeps where no keychain can, so a lost write or a
// rewritten file loses secrets for good. These cases hold that each value lands readable by this
// account alone, that calls made together all land, that a file the daemon cannot read is
// refused and left untouched, and that a cut-short write leaves no copy of the values behind.
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FileSecretKeychain } from "../file.js";

const REFUSAL = { code: "workflow.secret_store_unavailable", unavailableCause: "unavailable" };

let dataFolder: string;

beforeEach(async () => {
  dataFolder = await mkdtemp(join(tmpdir(), "file-keychain-"));
});

afterEach(async () => {
  await rm(dataFolder, { recursive: true, force: true });
});

describe("FileSecretKeychain", () => {
  it("keeps each service's values in one file readable by this account alone", async () => {
    const workflowSecrets = new FileSecretKeychain(dataFolder, "workflow");
    const otherSecrets = new FileSecretKeychain(dataFolder, "other");
    await expect(workflowSecrets.read("account")).resolves.toBeUndefined();
    await expect(workflowSecrets.remove("account")).resolves.toBe(false);

    await workflowSecrets.write("account", "workflow-value");
    await otherSecrets.write("account", "other-value");
    await expect(workflowSecrets.read("account")).resolves.toBe("workflow-value");
    expect(workflowSecrets.filePath).toBe(join(dataFolder, "secrets.json"));
    expect((await stat(workflowSecrets.filePath)).mode & 0o777).toBe(0o600);

    await expect(workflowSecrets.remove("account")).resolves.toBe(true);
    await expect(workflowSecrets.read("account")).resolves.toBeUndefined();
    await expect(otherSecrets.read("account")).resolves.toBe("other-value");
  });

  it("lands every write made at once, across keychains and spellings of the folder", async () => {
    const accounts = Array.from({ length: 20 }, (_, index) => `account-${String(index)}`);
    const relativeFolder = relative(process.cwd(), dataFolder);
    await Promise.all(
      accounts.map((account, index) =>
        new FileSecretKeychain(index % 2 === 0 ? dataFolder : relativeFolder, "workflow").write(
          account,
          `${account}-value`,
        ),
      ),
    );
    const keychain = new FileSecretKeychain(dataFolder, "workflow");
    for (const account of accounts) {
      await expect(keychain.read(account)).resolves.toBe(`${account}-value`);
    }
  });

  it("refuses an items file it cannot read, never quoting it, and leaves it as it is", async () => {
    const keychain = new FileSecretKeychain(dataFolder, "workflow");
    for (const text of [
      '{"workflow": {"account": secret-value}}',
      '{"workflow": "secret-value"}',
    ]) {
      await writeFile(keychain.filePath, text, { mode: 0o600 });
      await expect(keychain.read("account")).rejects.toMatchObject(REFUSAL);
      await expect(keychain.write("account", "new-value")).rejects.toMatchObject(REFUSAL);
      await expect(keychain.read("account")).rejects.not.toThrow(/secret-val/);
      await expect(readFile(keychain.filePath, "utf8")).resolves.toBe(text);
    }

    await rm(keychain.filePath);
    await keychain.write("account", "new-value");
    await expect(keychain.read("account")).resolves.toBe("new-value");
  });

  it("refuses when the file system fails, keeping its failure as the cause", async () => {
    const keychain = new FileSecretKeychain(dataFolder, "workflow");
    await mkdir(keychain.filePath);
    await expect(keychain.read("account")).rejects.toMatchObject({
      ...REFUSAL,
      cause: expect.objectContaining({ code: "EISDIR" }),
    });
  });

  it("deletes the temporary files a cut-short write left before its first call", async () => {
    const leftover = join(dataFolder, "secrets.json.0123456789abcdef.tmp");
    await writeFile(leftover, '{"workflow": {"account": "removed-value"}}', { mode: 0o600 });
    await writeFile(join(dataFolder, "other.tmp"), "", { mode: 0o600 });
    await expect(new FileSecretKeychain(dataFolder, "workflow").read("account")).resolves.toBe(
      undefined,
    );
    expect(await readdir(dataFolder)).toEqual(["other.tmp"]);
  });
});
