// Bundles the command line into one executable ESM file with commander and the workspace packages
// inlined; Node's built-ins stay external for the `node` platform.
import type { RolldownOptions } from "rolldown";

const config: RolldownOptions = {
  input: "src/main.ts",
  platform: "node",
  output: {
    file: "dist/main.js",
    format: "esm",
    banner: "#!/usr/bin/env node",
  },
};

export default config;
