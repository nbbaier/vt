import { dirname, join, relative } from "@std/path";
import { getValItemType, shouldIgnore } from "~/vt/lib/paths.ts";
import { getValItemContent, listValItems } from "~/sdk.ts";
import {
  type ItemStatus,
  ItemStatusManager,
} from "~/vt/lib/utils/ItemStatusManager.ts";
import { ensureDir, walk } from "@std/fs";
import { clone } from "~/vt/lib/clone.ts";
import { doAtomically, gracefulRecursiveCopy } from "~/vt/lib/utils/misc.ts";
import { status } from "~/vt/lib/status.ts";
import { mergeText } from "~/vt/lib/utils/merge.ts";

/** Result of pull operation  */
export interface PullResult {
  itemStateChanges: ItemStatusManager;
}

/**
 * Parameters for pulling latest changes from a Val Town Val into a vt folder.
 */
export interface PullParams {
  /** The vt Val root directory. */
  targetDir: string;
  /** The id of the Val to download from. */
  valId: string;
  /** The branch ID to download file content from. */
  branchId: string;
  /** The version to pull. Defaults to latest version. */
  version: number;
  /**
   * The last-synced version recorded in `.vt/state.json`, used as the merge
   * base. When provided, pull merges: local-only changes are preserved,
   * remote-only changes are applied, concurrent edits are auto-merged where
   * possible, and true conflicts get git-style conflict markers. When
   * omitted, the legacy behavior applies: remote wins everywhere.
   */
  baseVersion?: number;
  /** A list of gitignore rules. */
  gitignoreRules?: string[];
  /** If true, don't actually modify files, just report what would change. */
  dryRun?: boolean;
}

/**
 * Pulls latest changes from a Val Town Val into a vt folder.
 *
 * With a `baseVersion` (merge mode), after a pull:
 * - Remote-only changes (edits, creations, deletions) are applied locally
 * - Local-only changes (edits, creations, deletions, renames) are preserved
 * - Files edited on both sides are merged line-by-line; overlapping edits
 *   get git-style conflict markers and are reported as `conflicted`
 * - Files matching gitignore rules are untouched
 *
 * Without a `baseVersion` (legacy mode), the remote state wins: all remote
 * files are written and any non-ignored local path missing from the remote
 * listing is deleted.
 *
 * @param params Options for pull operation.
 * @returns Promise that resolves with changes that were applied or would be applied (if dryRun=true)
 */
export function pull(params: PullParams): Promise<PullResult> {
  if (params.baseVersion === undefined) return legacyPull(params);
  return mergePull(params);
}

/**
 * Three-way merging pull. Classifies every path against the merge base and
 * applies the remote side of the sync per-file, leaving local work intact.
 */
function mergePull(params: PullParams): Promise<PullResult> {
  const {
    targetDir,
    valId,
    branchId,
    version,
    baseVersion,
    gitignoreRules = [],
    dryRun = false,
  } = params;
  return doAtomically(
    async (tmpDir) => {
      // Work on a copy of the working tree so the application of changes is
      // atomic from the caller's perspective
      await gracefulRecursiveCopy(targetDir, tmpDir, {
        preserveTimestamps: true,
        overwrite: true,
      });

      const { itemStateChanges } = await status({
        targetDir,
        valId,
        branchId,
        version,
        baseVersion,
        gitignoreRules,
      });

      const changes = new ItemStatusManager();
      // The copy-back after this callback only overwrites; it cannot remove
      // files. So deletions are applied to both the temp dir and the real
      // target dir, mirroring what the legacy pull did.
      const filesToDelete: string[] = [];
      const dirsToDelete: string[] = [];

      const writeRemoteFile = async (item: ItemStatus) => {
        if (item.type === "directory") {
          if (!dryRun) await ensureDir(join(tmpDir, item.path));
          return;
        }
        const remoteContent = await getValItemContent(
          valId,
          branchId,
          version,
          item.path,
        );
        if (!dryRun) {
          const tmpPath = join(tmpDir, item.path);
          await ensureDir(dirname(tmpPath));
          await Deno.writeTextFile(tmpPath, remoteContent);
          // Match the remote updatedAt so the file registers as clean
          // against the new base on the next status
          await Deno.utime(tmpPath, new Date(item.mtime), new Date(item.mtime));
        }
        return remoteContent;
      };

      for (const item of itemStateChanges.all()) {
        switch (item.status) {
          case "not_modified":
            changes.insert(item);
            break;
          case "renamed":
            // A local rename; pull leaves local work alone
            changes.insert(item);
            break;
          case "created":
          case "modified":
            if (item.where === "remote") {
              const remoteContent = await writeRemoteFile(item);
              changes.insert({ ...item, content: remoteContent });
            } else {
              // Local change; preserved as-is
              changes.insert(item);
            }
            break;
          case "deleted":
            if (item.where === "remote") {
              // Deleted remotely and untouched locally: apply the deletion
              if (!dryRun) {
                if (item.type === "directory") {
                  dirsToDelete.push(item.path);
                } else {
                  filesToDelete.push(item.path);
                }
              }
            }
            // Deleted locally (where: "local"): the file is already absent
            // from the working tree; do not resurrect it
            changes.insert(item);
            break;
          case "conflicted": {
            const mergeable = item.conflictKind === "edit/edit" ||
              item.conflictKind === "create/create";
            const isText = item.localContent !== undefined &&
              item.remoteContent !== undefined &&
              !item.warnings?.includes("binary");

            if (mergeable && isText) {
              const merged = mergeText({
                base: item.baseContent ?? "",
                local: item.localContent!,
                remote: item.remoteContent!,
                remoteLabel: `remote (version ${version})`,
              });

              if (!dryRun) {
                const tmpPath = join(tmpDir, item.path);
                await ensureDir(dirname(tmpPath));
                // Written with the current mtime (not the remote's) so the
                // result registers as locally modified against the new base
                // and gets pushed once resolved
                await Deno.writeTextFile(tmpPath, merged.content);
              }

              if (merged.clean) {
                changes.insert({
                  status: "modified",
                  where: "remote",
                  merged: true,
                  type: item.type,
                  path: item.path,
                  mtime: Date.now(),
                  content: merged.content,
                });
              } else {
                changes.insert({ ...item, content: merged.content });
              }
            } else if (item.conflictKind === "delete/modify") {
              // Locally deleted but remotely edited: restore the remote
              // version so the remote edit isn't lost silently. Deleting
              // again (and pushing) resolves in favor of the deletion.
              const remoteContent = await writeRemoteFile(item);
              changes.insert({ ...item, content: remoteContent });
            } else {
              // modify/delete, or binary content on either side: keep the
              // local file and report the conflict
              changes.insert(item);
            }
            break;
          }
        }
      }

      // Delete files first, then directories (deepest first, and only if
      // empty — a directory containing a preserved local file survives)
      await Promise.all(filesToDelete.map(async (path) => {
        for (const dir of [tmpDir, targetDir]) {
          try {
            await Deno.remove(join(dir, path));
          } catch (e) {
            if (!(e instanceof Deno.errors.NotFound)) throw e;
          }
        }
      }));
      dirsToDelete.sort((a, b) => b.split("/").length - a.split("/").length);
      for (const path of dirsToDelete) {
        for (const dir of [tmpDir, targetDir]) {
          await Deno.remove(join(dir, path)).catch(() => {});
        }
      }

      return [{ itemStateChanges: changes }, !dryRun];
    },
    { targetDir, prefix: "vt_pull_" },
  );
}

/**
 * Legacy pull: clones the remote state over the working tree and deletes
 * any non-ignored local path that is missing from the remote listing. Used
 * when no merge base is available and for forced "remote wins" pulls.
 */
function legacyPull(params: PullParams): Promise<PullResult> {
  const {
    targetDir,
    valId,
    branchId,
    version,
    gitignoreRules = [],
    dryRun = false,
  } = params;
  return doAtomically(
    async (tmpDir) => {
      const changes = new ItemStatusManager();

      // Copy over all the files in the original dir into the temp dir During a
      // dry run the purpose here is to ensure that clone reports back the
      // proper status for modified files (e.g. if they existed and would be
      // changed then they're modified)
      await gracefulRecursiveCopy(targetDir, tmpDir, {
        preserveTimestamps: true,
        overwrite: true,
      });

      // Clone all the files from the Val into the temp dir. This
      // implicitly will overwrite files with the current version on the
      // server.
      const { itemStateChanges: cloneChanges } = await clone({
        targetDir: tmpDir,
        valId,
        branchId,
        version,
        gitignoreRules,
        dryRun,
      });

      // Merge the clone changes into our changes object
      changes.merge(cloneChanges);

      // Get list of files from the server
      const valItems = await listValItems(
        valId,
        branchId,
        version,
      );
      const valItemsSet = new Set(valItems.map((file) => file.path));

      // Scan the temp directory to identify files that should be deleted
      const pathsToDelete: string[] = [];
      for await (const entry of walk(tmpDir)) {
        const relativePath = relative(tmpDir, entry.path).replaceAll("\\", "/");
        const targetDirPath = join(targetDir, relativePath);
        const tmpDirPath = entry.path;

        if (shouldIgnore(relativePath, gitignoreRules)) continue;
        if (relativePath === "." || entry.path === tmpDir) continue;
        if (valItemsSet.has(relativePath)) continue;

        const stat = await Deno.stat(entry.path);
        const fileStatus: ItemStatus = {
          path: relativePath,
          status: "deleted",
          where: "remote",
          type: stat.isDirectory ? "directory" : await getValItemType(
            valId,
            branchId,
            version,
            relativePath,
          ),
          mtime: stat.mtime?.getTime()!,
        };
        changes.insert(fileStatus);

        // Delete the file from both directories if not in dry run mode
        if (!dryRun) {
          pathsToDelete.push(targetDirPath);
          pathsToDelete.push(tmpDirPath);
        }
      }

      // Perform the deletions
      await Promise.all(pathsToDelete.map(async (path) => {
        try {
          await Deno.remove(path, { recursive: true });
        } catch (e) {
          if (!(e instanceof Deno.errors.NotFound)) throw e;
        }
      }));

      return [{ itemStateChanges: changes }, !dryRun];
    },
    { targetDir, prefix: "vt_pull_" },
  );
}
