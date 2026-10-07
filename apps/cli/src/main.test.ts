import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

// The built executable, run as a person runs it, so the real process streams are under test.
const EXECUTABLE = fileURLToPath(new URL("../dist/main.js", import.meta.url));

it("exits 141 with nothing on stderr when the reader of its output has gone", async () => {
  const child = spawn(process.execPath, [EXECUTABLE, "help"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.destroy();
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  const exitCode = await new Promise<number | null>((resolve) => child.on("close", resolve));
  expect({ exitCode, stderr }).toEqual({ exitCode: 141, stderr: "" });
});
