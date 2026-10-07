// Bundles the command line into one executable ESM file with commander and the workspace packages
// inlined; Node's built-ins stay external for the `node` platform.
import { chmod } from "node:fs/promises";

import type { RolldownOptions } from "rolldown";

const EXECUTABLE = "dist/main.js";

const config: RolldownOptions = {
  input: "src/main.ts",
  platform: "node",
  output: {
    file: EXECUTABLE,
    format: "esm",
    banner: "#!/usr/bin/env node",
  },
  plugins: [
    {
      // A provider's hook runs the file by its path, so it carries the executable bit itself.
      name: "executable-bit",
      async writeBundle() {
        await chmod(EXECUTABLE, 0o755);
      },
    },
  ],
};

export default config;
