// The two unified patches kept as test data for the diff read.
//
// They are real `git diff` output, `diff --git` lines included: `patch-parse.ts` refuses a
// patch whose `@@` header count disagrees with its hunk count and reads the extended headers
// above the hunks. Between them they cover a textual change, a rename, a mode change and a
// binary file.
//
// The run-attributed patch is the implementer run's work on the worktree's branch. The
// workspace-fallback patch sits in the workspace's own checkout with no run to attribute it
// to, so its attribution is workspace-level.

/**
 * The change set the implementer's run produced, as the unified patch text a
 * `gitflow.diffRead` file carries.
 *
 * Two files and two hunks; the second file is a rename with no textual change, which a
 * renderer deriving its notes from `hunks.length` would report as nothing having happened.
 */
export const RUN_ATTRIBUTED_DIFF_PATCH: string = `diff --git a/packages/runtime-daemon/src/rate-limit/lease-store.ts b/packages/runtime-daemon/src/rate-limit/lease-store.ts
index 1f0a3c9..8b41d02 100644
--- a/packages/runtime-daemon/src/rate-limit/lease-store.ts
+++ b/packages/runtime-daemon/src/rate-limit/lease-store.ts
@@ -14,9 +14,12 @@ export class SubscriptionLeaseStore {
   readonly #capacity: number;

   public async claim(sessionId: string): Promise<LeaseClaim> {
-    const held = await this.#count(sessionId);
-    if (held >= this.#capacity) {
-      return { status: "refused", code: "ratelimit.exceeded" };
-    }
-    return { status: "granted", leaseId: this.#insert(sessionId) };
+    return this.#state.blockConcurrencyWhile(async () => {
+      await this.#pruneExpired(sessionId);
+      const held = await this.#count(sessionId);
+      if (held >= this.#capacity) {
+        return { status: "refused", code: "ratelimit.exceeded" };
+      }
+      return { status: "granted", leaseId: this.#insert(sessionId) };
+    });
   }
@@ -41,6 +43,7 @@ export class SubscriptionLeaseStore {
   }

   async #pruneExpired(sessionId: string): Promise<void> {
+    // The alarm re-arms itself, so a store with no traffic still sheds its rows.
     await this.#rows.delete({ sessionId, expiredBefore: this.#clock.now() });
   }
 }
diff --git a/packages/runtime-daemon/src/rate-limit/lease-clock.ts b/packages/runtime-daemon/src/rate-limit/lease-timing.ts
similarity index 100%
rename from packages/runtime-daemon/src/rate-limit/lease-clock.ts
rename to packages/runtime-daemon/src/rate-limit/lease-timing.ts
`;

/**
 * The change sitting in the git workspace's own checkout ahead of the shared branch, as
 * unified patch text.
 *
 * Three files: a textual change, a mode change with no hunks, and a binary file that
 * carries no text.
 */
export const WORKSPACE_FALLBACK_DIFF_PATCH: string = `diff --git a/apps/desktop/src/renderer/src/components/Nothing/Nothing.css b/apps/desktop/src/renderer/src/components/Nothing/Nothing.css
index 4c1e8a7..d90fe31 100644
--- a/apps/desktop/src/renderer/src/components/Nothing/Nothing.css
+++ b/apps/desktop/src/renderer/src/components/Nothing/Nothing.css
@@ -8,7 +8,7 @@
 .meridian-nothing--block {
   display: flex;
   flex-direction: column;
-  gap: var(--meridian-space-2);
+  gap: var(--meridian-space-3);
 }

 /* \`not-loaded\`: a skeleton in the row's shape, with the transcript row's edge unattributed. */
diff --git a/scripts/prepare-execution-root.sh b/scripts/prepare-execution-root.sh
old mode 100644
new mode 100755
diff --git a/apps/desktop/resources/icon.png b/apps/desktop/resources/icon.png
index 6f1b2c8..a3d90e4 100644
Binary files a/apps/desktop/resources/icon.png and b/apps/desktop/resources/icon.png differ
`;
