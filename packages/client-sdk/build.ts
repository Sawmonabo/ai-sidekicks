// Builds `crates/sidekicks-client-addon` into this package: the `.node` for this platform, its ES
// module loader and its declarations. CI builds the release profile, which the packaged app ships;
// a development build takes the debug profile, which compiles in a fraction of the time.

import { NapiCli } from "@napi-rs/cli";

const { task } = await new NapiCli().build({
  package: "sidekicks-client-addon",
  manifestPath: "../../Cargo.toml",
  outputDir: ".",
  platform: true,
  esm: true,
  release: process.env["CI"] === "true",
});
await task;
