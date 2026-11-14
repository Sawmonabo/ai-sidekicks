#!/usr/bin/env node
// Runs `cargo fmt` over every crate of the Cargo workspace but the ones the Rust port deletes.
// `cargo fmt` takes no `--exclude`, so the crates that stay are named one by one, read from the
// workspace's own manifests so a new crate needs no edit here. Arguments are passed on to
// `cargo fmt` (`--check`).

import { execFileSync } from "node:child_process";

const UNFORMATTED_CRATES = new Set(["search-index", "sidecar-rust-pty"]);

const metadata = JSON.parse(
  execFileSync("cargo", ["metadata", "--no-deps", "--format-version", "1"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  }),
);
const packageFlags = metadata.packages
  .map((cratePackage) => cratePackage.name)
  .filter((name) => !UNFORMATTED_CRATES.has(name))
  .flatMap((name) => ["-p", name]);

execFileSync("cargo", ["fmt", ...packageFlags, ...process.argv.slice(2)], { stdio: "inherit" });
