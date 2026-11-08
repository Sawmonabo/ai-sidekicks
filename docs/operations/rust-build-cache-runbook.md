# Rust Build Cache Runbook

## Purpose

Set up, check and reclaim `mbx`, the shared compile cache and machine-wide compile scheduler every Rust build in this repository runs through. One cache and one scheduler serve every checkout and worktree on the machine, so parallel worktrees reuse each other's compiled crates and share the processor and memory budget instead of multiplying the load. The project's policy is the tracked `.mbx.toml` at the workspace root; each machine installs the tool once.

## Symptoms

- A worktree recompiles the whole workspace chain although another checkout built the same sources
- Several worktrees building at once drive the machine into memory pressure or swap
- `cargo` resolves to `~/.cargo/bin/cargo`, so builds bypass the cache and the scheduler
- The cache or the managed build targets fill the disk
- A removed worktree's build state is still counted by the cache
- Scope and blast radius: one machine, every checkout and worktree of this repository on it

## Detection

- `command -v cargo` from the shell an agent or editor actually uses. Through the cache it prints the shim, `~/Library/Application Support/mbx/bin/cargo` on macOS; `~/.cargo/bin/cargo` means the shim is not on that shell's `PATH`.
- `mbx setup --status` says whether the shim is installed and current and whether rust-analyzer's checks run through it.
- `mbx stats --scheduler` shows the admitted and queued compiler jobs and the memory budget in force; `mbx tui` shows the same live while worktrees build.
- `mbx cache stats` and `mbx cache projects` show the cache's size and which checkouts hold managed targets.
- `MBX_SUMMARY=full cargo build --locked` prints one build's cache hits and compiled units. A cache hit is a reused complete output; the `incremental` count is units compiled with private incremental state, not proof of reuse.

## Preconditions

- The Rust toolchain `rust-toolchain.toml` pins, installed through rustup; the cache never changes it
- `mbx` 1.26.0 or newer; the release page is `https://github.com/jdx/mr-boxington/releases`
- The cache root and the checkouts on one local filesystem (the default cache root is `~/Library/Caches/mbx` on macOS)

## Recovery Steps

### First setup on a machine

1. Install the prebuilt release for the machine's platform into `~/.local/bin`; on an Apple Silicon Mac:

   ```sh
   (
     set -eu
     mbx_download_directory="$(mktemp -d -t mbx-install)"
     trap 'rm -r -- "$mbx_download_directory"' EXIT
     cd "$mbx_download_directory"
     mbx_release_url="https://github.com/jdx/mr-boxington/releases/download/v1.26.0"
     mbx_archive="mbx-aarch64-apple-darwin.tar.gz"
     curl -fsSLO "$mbx_release_url/$mbx_archive"
     curl -fsSLO "$mbx_release_url/SHA256SUMS"
     grep "  $mbx_archive\$" SHA256SUMS | shasum -a 256 --check --strict -
     mkdir -p "$HOME/.local/bin"
     tar -xzf "$mbx_archive" -C "$HOME/.local/bin"
   )
   ```

2. Run `mbx setup`. It installs the Cargo shim and routes rust-analyzer's check command through the cache. If it asks about a mise scope, create the shim without activating it; the project uses no tool manager.
3. Put the shim first on `PATH` in the shell startup file every tool inherits, once:

   ```sh
   export PATH="$HOME/Library/Application Support/mbx/bin:$HOME/.local/bin:$PATH"
   ```

   Then start a new shell and relaunch any editor or agent host, and confirm with `command -v cargo` inside an actual agent command. A tool that cannot inherit that `PATH` runs `mbx build`, `mbx check` or `mbx nextest run` explicitly.

4. Do not run `cargo clean` or delete an existing `target/` first: the first build through the cache adopts a real `target/` into managed storage and leaves a `target` symlink in its place.
5. In the main checkout, run the normal development workload once (`cargo build --locked`, `cargo clippy --workspace --all-targets --all-features`, `cargo nextest run --workspace`); that warms the cache that new worktrees draw on. Build, check and test modes, features and profiles are separate reusable units, so warm the workload the worktrees will run, not a release build.

### Project policy

The tracked `.mbx.toml` holds the whole policy and needs no per-machine change:

- `share_workspace_root = true`: a crate compiled in one checkout is reused by every other checkout with the same sources
- `[scheduler]`: one core reserved and a memory budget for compilers and test binaries, with `tests = false` so a test binary takes no permit (nextest bounds its own parallelism and its two-minute limit would count a permit wait as a hang)
- a build beside the Linux container's virtual machine exports `MBX_SCHEDULER_MEMORY=6GiB`, which wins over the file

Never add a per-worktree `MBX_CACHE_DIR`, a shared writable `CARGO_TARGET_DIR`, or a second cache layer such as sccache. Eager incremental state (`eager_incremental`) is off; `MBX_EAGER_INCREMENTAL=1` on one command tries it without changing the policy.

### Reclaiming disk

1. `mbx gc --dry-run`, then `mbx gc`: deletes cached build data past the disk-scaled budgets; later builds restore or recompile what they need. Never delete the cache directory by hand.
2. For one finished worktree, after `python3 .claude/hooks/worktree-occupancy.py --occupancy <path>` prints no occupant: `mbx cache remove /absolute/path/to/the/worktree`. That drops its managed target and private incremental state and its cache claims, not its source checkout; shared objects other checkouts use stay.
3. `cargo clean` in a worktree leaves the cache's private state; `mbx clean` discards that workspace's private incremental state too. Neither is routine between edits.

### Release and CI

Release builds come from a dedicated checkout through the project's release procedure, never from a development worktree's artifacts. CI builds through plain Cargo; a non-incremental release build through the cache sets `MBX_EAGER_INCREMENTAL=0 MBX_LEARNED_INCREMENTAL=0 CARGO_INCREMENTAL=0`.

## Validation

- `command -v cargo` prints the shim in the shell an agent uses, and `mbx setup --status` reads installed and current
- A second worktree's first `cargo build --locked` reports cache hits for the crates the main checkout compiled (`MBX_SUMMARY=full`)
- `mbx stats --scheduler` during two parallel builds shows jobs queued against the policy's memory budget rather than both running unbounded
- After `mbx cache remove`, `mbx cache projects` no longer lists the worktree

## Escalation

- A build that fails only through the shim and passes through `~/.cargo/bin/cargo` is a cache defect: record the `MBX_SUMMARY=full` output and `mbx --version`, build through `~/.cargo/bin/cargo` meanwhile, and report it upstream at `https://github.com/jdx/mr-boxington/issues`

## Related Architecture Docs

- [Repository and worktree layout](../../AGENTS.md#project-structure)

## Related Specs

- None; the cache is development tooling and no product spec names it.

## Related Plans

- None; the policy lives in `.mbx.toml` and this runbook.
