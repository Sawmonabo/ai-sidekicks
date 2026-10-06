// `@napi-rs/keyring` is replaced here so no real keychain is touched. These cases hold what the
// adapter promises the store: the Linux entry is pinned to the Secret Service, a keychain that
// never answers is abandoned as locked, and each failure the library reports carries the right
// cause.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const keyring = vi.hoisted(() => ({
  constructed: [] as unknown[][],
  construct: (): void => undefined,
  setPassword: (_value: string): Promise<void> => Promise.resolve(),
  getPassword: (): Promise<string | null> => Promise.resolve(null),
  deleteCredential: (): Promise<boolean> => Promise.resolve(true),
}));

vi.mock("@napi-rs/keyring", () => ({
  AsyncEntry: class {
    constructor(...args: unknown[]) {
      keyring.constructed.push(args);
      keyring.construct();
    }
    setPassword(value: string): Promise<void> {
      return keyring.setPassword(value);
    }
    getPassword(): Promise<string | null> {
      return keyring.getPassword();
    }
    deleteCredential(): Promise<boolean> {
      return keyring.deleteCredential();
    }
  },
}));

const { OsSecretKeychain } = await import("../os-keychain.js");

// The library's errors are plain errors whose message is the keychain's own text.
function keyringError(message: string): Error {
  return Object.assign(new Error(message), { code: "GenericFailure" });
}

beforeEach(() => {
  keyring.constructed = [];
  keyring.construct = () => undefined;
  keyring.getPassword = () => Promise.resolve(null);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("OsSecretKeychain", () => {
  it("files the entry under its service and pins Linux to the Secret Service", async () => {
    keyring.getPassword = () => Promise.resolve("example-value");
    await expect(new OsSecretKeychain("service").read("account")).resolves.toBe("example-value");
    expect(keyring.constructed).toEqual([
      ["service", "account", { linux: { store: "secret-service" } }],
    ]);
  });

  it("reads an absent entry as undefined", async () => {
    await expect(new OsSecretKeychain("service").read("account")).resolves.toBeUndefined();
  });

  it("abandons a call that never answers as locked", async () => {
    vi.useFakeTimers();
    keyring.getPassword = () => new Promise<never>(() => undefined);
    const reading = new OsSecretKeychain("service", 1_000).read("account");
    const settled = expect(reading).rejects.toMatchObject({ unavailableCause: "locked" });
    await vi.advanceTimersByTimeAsync(1_000);
    await settled;
  });

  it(
    "reports a refused storage access as locked, and a platform failure or no keychain as " +
      "unavailable",
    async () => {
      keyring.getPassword = () =>
        Promise.reject(keyringError("Couldn't access platform storage: keychain is locked"));
      await expect(new OsSecretKeychain("service").read("account")).rejects.toMatchObject({
        code: "workflow.secret_store_unavailable",
        unavailableCause: "locked",
      });

      keyring.getPassword = () =>
        Promise.reject(keyringError("Platform failure: org.freedesktop.DBus.Error.ServiceUnknown"));
      await expect(new OsSecretKeychain("service").read("account")).rejects.toMatchObject({
        unavailableCause: "unavailable",
      });
      keyring.construct = () => {
        throw keyringError("Platform failure: no secret service");
      };
      await expect(new OsSecretKeychain("service").read("account")).rejects.toMatchObject({
        unavailableCause: "unavailable",
      });
    },
  );
});
