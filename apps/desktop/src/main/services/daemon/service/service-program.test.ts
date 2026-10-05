// A development build starts the workspace's built daemon. A wrong relative path fails silently:
// the start succeeds, `node` exits at once on the missing file, and the app spends its five
// starts on nothing. So the path is checked against the checkout itself.

import { readFileSync } from "node:fs";
import path from "node:path";

import { expect, it } from "vitest";

import { PACKAGE_ROOT } from "#test/helpers/fixture/bundle.js";

import { resolveServiceProgram } from "./service-program.js";

it("starts the workspace daemon's built entry from main's built entry in a checkout", () => {
  const program = resolveServiceProgram({
    isPackaged: false,
    // Where the build writes main's entry, and where every launch, test or not, runs it from.
    mainBundleFolder: path.join(PACKAGE_ROOT, "out", "main"),
    resourcesPath: "/unused-in-a-checkout",
  });

  expect(program.command).toBe("node");
  const entry = program.args[0] ?? "";
  expect(path.basename(entry)).toBe("main.js");
  // `dist/main.js` sits under the daemon package's root, whose manifest names it.
  const manifest = JSON.parse(
    readFileSync(path.join(path.dirname(entry), "..", "package.json"), "utf8"),
  ) as { name?: string };
  expect(manifest.name).toBe("@ai-sidekicks/runtime-daemon");
});
