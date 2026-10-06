// The process reader both the service and a client that ends it read through: a wrong reading
// signals the wrong process or one that reused the id, so each system's reading is held here
// against the system's own output, its "no such process" answer, and the boot it reads once.
import { describe, expect, it } from "vitest";

import { createProcessIdentityReader, type ProcessIdentitySystem } from "../process-identity.js";

const BOOT_ID = "6f1c2b9e-3d4a-4e5f-8a7b-9c0d1e2f3a4b";

// A failure as Node's calls reject: an `Error` carrying `code`, and `stdout` for a program run.
function systemFailure(fields: { code: unknown; stdout?: string }): Error {
  return Object.assign(new Error("the system call failed"), fields);
}

function linuxSystem(files: Record<string, () => Promise<string>>): ProcessIdentitySystem {
  return {
    platform: "linux",
    readTextFile: (path) => files[path]?.() ?? Promise.reject(systemFailure({ code: "ENOENT" })),
    runProgram: () => Promise.reject(new Error("Linux runs no program")),
  };
}

describe("createProcessIdentityReader on Linux", () => {
  it("reads the start from field 22, counted after a name holding spaces and parentheses", async () => {
    // Fields 3 to 21 are numbered by their field number, so a miscount reads the wrong one.
    const afterName = Array.from({ length: 19 }, (_, index) => `f${String(index + 3)}`);
    const stat = `4242 (my ) (odd) name) ${afterName.join(" ")} 987654 f23 f24\n`;
    const read = createProcessIdentityReader(
      linuxSystem({
        "/proc/4242/stat": () => Promise.resolve(stat),
        "/proc/sys/kernel/random/boot_id": () => Promise.resolve(`${BOOT_ID}\n`),
      }),
    );

    expect(await read(4242)).toStrictEqual({
      processId: 4242,
      bootId: BOOT_ID,
      processStartTime: "987654",
    });
  });

  it("answers undefined when no process has the id", async () => {
    const read = createProcessIdentityReader(linuxSystem({}));

    expect(await read(4242)).toBeUndefined();
  });
});

describe("createProcessIdentityReader on macOS", () => {
  const START = "Mon Oct  5 22:35:01 2026";

  function macSystem(
    runPs: () => Promise<{ stdout: string }>,
    runSysctl: () => Promise<{ stdout: string }> = () =>
      Promise.resolve({ stdout: `${BOOT_ID}\n` }),
  ): ProcessIdentitySystem {
    return {
      platform: "darwin",
      readTextFile: () => Promise.reject(new Error("macOS reads no file")),
      runProgram: (file) => (file === "/bin/ps" ? runPs() : runSysctl()),
    };
  }

  it("answers undefined only for ps's exit 1 with nothing written", async () => {
    const absent = createProcessIdentityReader(
      macSystem(() => Promise.reject(systemFailure({ code: 1, stdout: "" }))),
    );
    expect(await absent(4242)).toBeUndefined();

    // Exit 1 with output is a failure of the reading, never an absent process.
    const failed = createProcessIdentityReader(
      macSystem(() => Promise.reject(systemFailure({ code: 1, stdout: "ps: bad option" }))),
    );
    await expect(failed(4242)).rejects.toThrow("the system call failed");
  });

  it("reads the boot once, and again after a reading of it failed", async () => {
    let sysctlRuns = 0;
    const read = createProcessIdentityReader(
      macSystem(
        () => Promise.resolve({ stdout: `${START}\n` }),
        () => {
          sysctlRuns += 1;
          return sysctlRuns === 1
            ? Promise.reject(systemFailure({ code: 2 }))
            : Promise.resolve({ stdout: `${BOOT_ID}\n` });
        },
      ),
    );

    await expect(read(4242)).rejects.toThrow("the system call failed");
    const expected = { processId: 4242, bootId: BOOT_ID, processStartTime: START };
    expect(await read(4242)).toStrictEqual(expected);
    expect(await read(4242)).toStrictEqual(expected);
    expect(sysctlRuns).toBe(2);
  });
});
