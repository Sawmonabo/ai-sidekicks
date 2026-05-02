#!/usr/bin/env node
// install-lychee — provisions the lychee Rust binary into node_modules/.bin
// during `pnpm install` so the doc-corpus pre-commit hook catches anchor /
// link breakage locally instead of waiting for CI.
//
// Design notes:
//   - Skipped in CI by default; the docs-corpus workflow installs lychee
//     inline (curl + sha256sum) for ADR-023 §Axis 2 D-1 parity — keeping the
//     pinned `VERSION` constant below in sync with the workflow's
//     `LYCHEE_VERSION` env is the single contract. `FORCE_LYCHEE_INSTALL=1`
//     overrides the CI skip if a future workflow needs it.
//   - Skipped on Windows (ADR-019 §V1 deployment puts Windows on its own tier;
//     warn-and-skip is the right default until that tier ships).
//   - Tolerant of network failure: failing to provision MUST NOT break
//     `pnpm install`. The lefthook hook degrades to a WARNING when lychee is
//     missing locally — CI is the authoritative gate.
//   - Pinned version + SHA256 verification close the supply-chain edge of
//     "download a binary at install time".
//   - Cache at node_modules/.cache/lychee/<version>/lychee survives across
//     dependency upgrades (the .bin/ directory is rebuilt by pnpm but the
//     .cache/ tree is not).

import { existsSync, mkdirSync, writeFileSync, chmodSync, copyFileSync, rmSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

const VERSION = "v0.24.2";
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const CACHE_DIR = resolve(REPO_ROOT, "node_modules", ".cache", "lychee", VERSION);
const CACHED_BIN = resolve(CACHE_DIR, "lychee");
const BIN_DIR = resolve(REPO_ROOT, "node_modules", ".bin");
const BIN_TARGET = resolve(BIN_DIR, "lychee");

function platformAssetTriple() {
  // On Linux, prefer the statically-linked musl tarballs over gnu — the gnu
  // builds depend on a recent host GLIBC (2.38+ at v0.24.2), which trips on
  // older Debian / Ubuntu LTS / WSL2 distributions. musl tarballs run anywhere.
  const { platform, arch } = process;
  if (platform === "linux") {
    if (arch === "x64") return "x86_64-unknown-linux-musl";
    if (arch === "arm64") return "aarch64-unknown-linux-musl";
  }
  if (platform === "darwin") {
    if (arch === "x64") return "x86_64-apple-darwin";
    if (arch === "arm64") return "aarch64-apple-darwin";
  }
  return null;
}

function lycheeVersionFrom(binary) {
  try {
    const out = execFileSync(binary, ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const m = out.match(/lychee\s+([\d.]+)/);
    return m ? `v${m[1]}` : null;
  } catch {
    return null;
  }
}

async function fetchToBuffer(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

async function provision(triple) {
  if (lycheeVersionFrom(CACHED_BIN) !== VERSION) {
    mkdirSync(CACHE_DIR, { recursive: true });
    const asset = `lychee-${triple}.tar.gz`;
    const baseUrl = `https://github.com/lycheeverse/lychee/releases/download/lychee-${VERSION}`;
    const tarballUrl = `${baseUrl}/${asset}`;
    const sha256Url = `${tarballUrl}.sha256`;
    const tarballPath = resolve(CACHE_DIR, asset);

    console.log(`install-lychee: downloading lychee@${VERSION} for ${triple}`);
    const [tarball, sha256Text] = await Promise.all([
      fetchToBuffer(tarballUrl),
      fetch(sha256Url).then((r) => r.text()),
    ]);
    const expected = sha256Text.trim().split(/\s+/)[0].toLowerCase();
    const actual = createHash("sha256").update(tarball).digest("hex");
    if (expected !== actual) {
      throw new Error(`SHA256 mismatch for ${asset}: expected ${expected}, got ${actual}`);
    }
    writeFileSync(tarballPath, tarball);

    // Lychee tarballs nest under `lychee-<triple>/`; strip-components flattens
    // so the binary lands at CACHED_BIN (`<cache>/lychee`) regardless of the
    // archive's internal layout.
    execFileSync("tar", ["-xzf", tarballPath, "-C", CACHE_DIR, "--strip-components=1"], {
      stdio: "inherit",
    });
    rmSync(tarballPath);

    if (!existsSync(CACHED_BIN)) {
      throw new Error(`extraction did not produce expected binary at ${CACHED_BIN}`);
    }
    chmodSync(CACHED_BIN, 0o755);
  }

  if (!existsSync(BIN_DIR)) {
    // pnpm hasn't created node_modules/.bin yet — caller is running this
    // script outside of a normal `pnpm install`. The cache still gets
    // populated; subsequent installs will copy from cache.
    return;
  }
  if (existsSync(BIN_TARGET)) rmSync(BIN_TARGET);
  copyFileSync(CACHED_BIN, BIN_TARGET);
  chmodSync(BIN_TARGET, 0o755);
}

async function main() {
  if (process.env.CI === "true" && process.env.FORCE_LYCHEE_INSTALL !== "1") return;
  if (process.env.SKIP_LYCHEE_INSTALL === "1") return;

  if (process.platform === "win32") {
    console.warn(
      "install-lychee: Windows not provisioned (ADR-019 §V1 deployment defers Windows tier).",
    );
    console.warn(
      "install-lychee: install via 'cargo install lychee' or https://github.com/lycheeverse/lychee/releases",
    );
    return;
  }

  const triple = platformAssetTriple();
  if (!triple) {
    console.warn(`install-lychee: no provisioning rule for ${process.platform}/${process.arch}.`);
    return;
  }

  if (lycheeVersionFrom("lychee") === VERSION) {
    return; // System install at the right version is already on PATH.
  }

  try {
    await provision(triple);
  } catch (err) {
    console.warn("install-lychee: provisioning failed; pre-commit will degrade to WARNING.");
    console.warn(`install-lychee: ${err.message}`);
  }
}

main().catch((err) => {
  console.warn(`install-lychee: unexpected error: ${err?.message ?? err}`);
});
