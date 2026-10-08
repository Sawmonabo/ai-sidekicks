// The items file holds every secret the daemon keeps where no keychain can, so a lost write or a
// rewritten file loses secrets for good. These cases hold that each value lands readable by this
// account alone, that calls made together all land, and that a file the daemon cannot read is
// refused and left untouched.
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FileSecretKeychain } from "../file-keychain.js";

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

  it("lands every write made at once, across keychains over the same file", async () => {
    const accounts = Array.from({ length: 20 }, (_, index) => `account-${String(index)}`);
    await Promise.all(
      accounts.map((account) =>
        new FileSecretKeychain(dataFolder, "workflow").write(account, `${account}-value`),
      ),
    );
    const keychain = new FileSecretKeychain(dataFolder, "workflow");
    for (const account of accounts) {
      await expect(keychain.read(account)).resolves.toBe(`${account}-value`);
    }
  });

  it("refuses a file that is not an items file, never quoting it, and leaves it as it is", async () => {
    const keychain = new FileSecretKeychain(dataFolder, "workflow");
    for (const text of [
      '{"workflow": {"account": secret-value}}',
      '{"workflow": "secret-value"}',
    ]) {
      await writeFile(keychain.filePath, text, { mode: 0o600 });
      const refusal = {
        code: "workflow.secret_store_unavailable",
        unavailableCause: "unavailable",
      };
      await expect(keychain.read("account")).rejects.toMatchObject(refusal);
      await expect(keychain.write("account", "new-value")).rejects.toMatchObject(refusal);
      await expect(keychain.read("account")).rejects.not.toThrow(/secret-val/);
      await expect(readFile(keychain.filePath, "utf8")).resolves.toBe(text);
    }
  });
});
