// A sealed secret must be one the keychain kept, since a record written over a value
// the keychain dropped names a secret that no run can resolve. These cases hold the
// read-back check behind every seal and the cause a refusal carries.
import type { WorkflowSecretId } from "@ai-sidekicks/contracts";
import { describe, expect, it } from "vitest";

import { WorkflowSecretStoreUnavailableError, type SecretKeychain } from "../secret-keychain.js";
import { WorkflowSecretStore } from "../workflow-secret-store.js";

const SECRET_ID = "44444444-4444-4444-8444-444444444444" as WorkflowSecretId;

// A keychain held in memory that can be told to drop or alter what it is given.
function memoryKeychain(keep: (value: string) => string | undefined = (value) => value): {
  keychain: SecretKeychain;
  held: Map<string, string>;
} {
  const held = new Map<string, string>();
  const keychain: SecretKeychain = {
    write: async (account, value) => {
      const kept = keep(value);
      if (kept !== undefined) held.set(account, kept);
    },
    read: async (account) => held.get(account),
    remove: async (account) => held.delete(account),
  };
  return { keychain, held };
}

describe("WorkflowSecretStore", () => {
  it("seals a value under the secret's id and resolves it back", async () => {
    const { keychain, held } = memoryKeychain();
    const store = new WorkflowSecretStore(keychain);
    await store.seal(SECRET_ID, "example-value");
    expect(held.get(SECRET_ID)).toBe("example-value");
    await expect(store.resolve(SECRET_ID)).resolves.toBe("example-value");
    await store.remove(SECRET_ID);
    await expect(store.resolve(SECRET_ID)).resolves.toBeUndefined();
  });

  it("refuses as unavailable when the keychain drops the value without an error", async () => {
    const store = new WorkflowSecretStore(memoryKeychain(() => undefined).keychain);
    const sealing = store.seal(SECRET_ID, "example-value");
    await expect(sealing).rejects.toBeInstanceOf(WorkflowSecretStoreUnavailableError);
    await expect(sealing).rejects.toMatchObject({
      code: "workflow.secret_store_unavailable",
      detail: { cause: "unavailable" },
    });
  });

  it("refuses when the keychain keeps something other than the value", async () => {
    for (const altered of ["example-valu", "example-valuE", "example-value "]) {
      const store = new WorkflowSecretStore(memoryKeychain(() => altered).keychain);
      await expect(store.seal(SECRET_ID, "example-value"), altered).rejects.toBeInstanceOf(
        WorkflowSecretStoreUnavailableError,
      );
    }
  });

  it("never puts the value in the refusal", async () => {
    const store = new WorkflowSecretStore(memoryKeychain(() => "other").keychain);
    const refusal: unknown = await store.seal(SECRET_ID, "example-value").catch((e) => e);
    expect(JSON.stringify(refusal)).not.toContain("example-value");
    expect(String((refusal as Error).message)).not.toContain("example-value");
  });
});
