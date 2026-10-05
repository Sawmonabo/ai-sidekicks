# packages — structure rules

Binding for every change under `packages/`, on top of the root `AGENTS.md`. Paths are relative to each package's `src/`.

## Folders by topic

- **A package's modules are grouped by topic, in folders, never by a shared file-name prefix.** The modules of one domain concept share a `kebab-case/` folder named for it: `daemon/lifecycle.ts` and `daemon/status.ts`, never `daemon-lifecycle.ts` beside `daemon-status.ts`. This holds at every level, so inside `git/` the worktree modules sit in `git/worktree/`, not as `git/worktree-*.ts`.
- **Two names starting with the same topic word mean the topic's folder is missing, and a folder counts like a file.** Two files, two folders, or a folder and a file all count: `run-page/` beside `runs/` becomes `runs/page/`. A new module goes into its topic's folder; the second module of a topic creates that folder and moves the first into it, in the same change. A word that is not a topic, such as a protocol version (`v4-`), is no reason for a folder.
- **A folder holds at least two modules.** A topic with one module is a file (`compaction.ts`), never a folder around a single file; the topic's second module creates the folder.
- **A file or folder name never repeats a word that any folder above it already says.** The path is read with the name, so the name says only what the path does not: `daemon/lifecycle.ts`, not `daemon/daemon-lifecycle.ts`; `runs/page/graph/`, not `runs/page/run-graph/`; `provider/driver/codex/commands.ts`, not `provider/driver/codex/provider-commands/`; `jsonrpc/message.ts`, not `jsonrpc/jsonrpc.ts`. This holds at every depth, and also when the class, type or function in the file carries those words: the identifier keeps its full name, because an import reads it without the path (`daemon/process.ts` exports `DaemonProcess`). The one exception is a React component's or hook's file, which keeps its component's or hook's exact name (`removal/RootRemovalConfirmation.tsx`, `viewport/hooks/useTranscriptViewport.ts`).
- **A name is the word the domain or the spec uses for what the file holds,** never a stand-in chosen to dodge a repeat (`wire`, `core`, `main`, `types`, `envelope` where the spec says message). The JSON-RPC 2.0 spec names a request, a notification and a response, so the file of `JsonRpcMessage` is `message.ts`. A file whose contents no one such word covers holds several things and splits by them: a Codex file of command-list readers and the compaction call becomes `commands.ts` and `compaction.ts`.
- **A folder that grows hard to scan splits by sub-topic,** never by kind of code (`types/`, `schemas/`, `constants/`).
- **A move updates every import, test, doc path and tool config in the same change** (root rule 12), and a public module's import path follows its folder: `@ai-sidekicks/contracts/daemon/lifecycle`.

## Dependencies between packages

- **The direction:** `contracts`, `crypto-paseto` and `search-ranking` depend on no other workspace package; `client-sdk`, `runtime-daemon` and `control-plane` depend on `contracts` alone; only `apps/` depend on `client-sdk`. The client library and the daemon never import each other, so each changes without the other.
- **A package uses another only by listing it in its `package.json` and importing its exported entry points,** never a file across the boundary through `../`. pnpm makes an unlisted package unreachable, so a new workspace dependency is a line in the diff, and it follows the direction above.
