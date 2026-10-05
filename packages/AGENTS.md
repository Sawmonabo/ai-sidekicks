# packages — structure rules

Binding for every change under `packages/`, on top of the root `AGENTS.md`. Paths are relative to each package's `src/`.

## Folders by topic

- **A package's modules are grouped by topic, in folders, never by a shared file-name prefix.** The modules of one domain concept share a `kebab-case/` folder named for it: `daemon/lifecycle.ts` and `daemon/status.ts`, never `daemon-lifecycle.ts` beside `daemon-status.ts`. This holds at every level, so inside `git/` the worktree modules sit in `git/worktree/`, not as `git/worktree-*.ts`.
- **Two names starting with the same topic word mean the topic's folder is missing, and a folder counts like a file.** Two files, two folders, or a folder and a file all count: `run-page/` beside `runs/` becomes `runs/page/`. A new module goes into its topic's folder; the second module of a topic creates that folder and moves the first into it, in the same change. A word that is not a topic, such as a protocol version (`v4-`), is no reason for a folder.
- **A file or folder inside a folder is named for what it holds and does not repeat the folder's word.** The word goes when it was only a grouping prefix (`daemon-lifecycle.ts` becomes `daemon/lifecycle.ts`, `runs/page/run-graph/` becomes `runs/page/graph/`) and stays only when it is part of the name of the class, component, hook or function the file holds (`daemon/daemon-process.ts` holds `DaemonProcess`).
- **A folder that grows hard to scan splits by sub-topic,** never by kind of code (`types/`, `schemas/`, `constants/`).
- **A move updates every import, test, doc path and tool config in the same change** (root rule 12), and a public module's import path follows its folder: `@ai-sidekicks/contracts/daemon/lifecycle`.

## Dependencies between packages

- **The direction:** `contracts`, `crypto-paseto` and `search-ranking` depend on no other workspace package; `client-sdk`, `runtime-daemon` and `control-plane` depend on `contracts` alone; only `apps/` depend on `client-sdk`. The client library and the daemon never import each other, so each changes without the other.
- **A package uses another only by listing it in its `package.json` and importing its exported entry points,** never a file across the boundary through `../`. pnpm makes an unlisted package unreachable, so a new workspace dependency is a line in the diff, and it follows the direction above.
