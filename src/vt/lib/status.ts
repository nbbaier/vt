import { getValItemContent, listValItems } from "~/sdk.ts";
import { getValItemType, shouldIgnore } from "~/vt/lib/paths.ts";
import * as fs from "@std/fs";
import * as path from "@std/path";
import {
  type CreatedItemStatus,
  type DeletedItemStatus,
  getItemWarnings,
  type ItemInfo,
  type ItemStatus,
  ItemStatusManager,
  type ModifiedItemStatus,
  type NotModifiedItemStatus,
} from "~/vt/lib/utils/ItemStatusManager.ts";
import { join } from "@std/path";
import { isFileModified } from "~/vt/lib/utils/misc.ts";
import { classifyItemState } from "~/vt/lib/utils/threeWayDiff.ts";
import { exists } from "@std/fs";
import type ValTown from "@valtown/sdk";

/** Result of status operation  */
export interface StatusResult {
  itemStateChanges: ItemStatusManager;
}

/**
 * Parameters for scanning a directory and determining the status of files compared to the Val Town val.
 */
export interface StatusParams {
  /** The directory to scan for changes. */
  targetDir: string;
  /** The Val Town Val ID. */
  valId: string;
  /** Branch ID to check against. */
  branchId: string;
  /** The version to check the status against. Defaults to the latest version. */
  version: number;
  /**
   * The last-synced version recorded in `.vt/state.json`, used as the merge
   * base for three-way classification. When omitted, falls back to the
   * legacy two-way comparison against `version` (direction of modifications
   * is then guessed from mtimes, and existence changes are interpreted from
   * the local perspective).
   */
  baseVersion?: number;
  /** Gitignore rules */
  gitignoreRules?: string[];
}

/**
 * Scans a directory and determines the status of all files compared to the
 * Val Town Val on the website.
 *
 * With a `baseVersion`, every path is classified three-way against the
 * common base: as locally changed, remotely changed, unchanged, or
 * conflicted (changed on both sides). Without one, the legacy two-way
 * comparison is used.
 *
 * @param params Options for status operation.
 * @returns Promise that resolves to a FileState object containing categorized files.
 */
export async function status(params: StatusParams): Promise<StatusResult> {
  if (params.baseVersion === undefined) return await twoWayStatus(params);
  return await threeWayStatus(params);
}

/**
 * Three-way status: classifies each path across the base (remote at
 * `baseVersion`), the working directory, and the remote at `version`.
 *
 * Content fetches are avoided where timestamps already settle the question:
 * a local mtime equal to the base's `updatedAt` proves the file is untouched
 * since the last sync (clone/pull set mtimes to the remote `updatedAt`), and
 * two listings agreeing on a file's `updatedAt` prove the remote side did
 * not change it.
 */
async function threeWayStatus(params: StatusParams): Promise<StatusResult> {
  const { targetDir, valId, branchId, version, gitignoreRules } = params;
  const baseVersion = params.baseVersion!;
  const result = new ItemStatusManager();

  const localFiles = await getLocalFiles({
    valId,
    branchId,
    version,
    targetDir,
    gitignoreRules,
  });
  const localMap = new Map(localFiles.map((file) => [file.path, file]));

  const remoteMap = new Map(
    (await listValItems(valId, branchId, version))
      .filter((file) => !shouldIgnore(file.path, gitignoreRules))
      .map((file) => [file.path, file]),
  );
  const baseMap = new Map(
    (await listValItems(valId, branchId, baseVersion))
      .filter((file) => !shouldIgnore(file.path, gitignoreRules))
      .map((file) => [file.path, file]),
  );

  const allPaths = new Set([
    ...localMap.keys(),
    ...remoteMap.keys(),
    ...baseMap.keys(),
  ]);

  await Promise.all(
    Array.from(allPaths).map(async (filePath) => {
      const item = await classifyPath({
        filePath,
        targetDir,
        valId,
        branchId,
        version,
        baseVersion,
        local: localMap.get(filePath),
        remote: remoteMap.get(filePath),
        base: baseMap.get(filePath),
      });
      if (item) result.insert(item);
    }),
  );

  return { itemStateChanges: result.consolidateRenames() };
}

/**
 * Classifies a single path and builds its `ItemStatus`. Returns null for
 * paths that need no entry (deleted on both sides since the base).
 */
async function classifyPath({
  filePath,
  targetDir,
  valId,
  branchId,
  version,
  baseVersion,
  local,
  remote,
  base,
}: {
  filePath: string;
  targetDir: string;
  valId: string;
  branchId: string;
  version: number;
  baseVersion: number;
  local?: ItemInfo;
  remote?: ValTown.Vals.FileRetrieveResponse;
  base?: ValTown.Vals.FileRetrieveResponse;
}): Promise<ItemStatus | null> {
  const isDirectory = local?.type === "directory" ||
    remote?.type === "directory" || base?.type === "directory";

  // Content lookups are lazy and hit the memoized sdk caches, so paths whose
  // timestamps already settle the classification never fetch anything
  const getBaseContent = () =>
    base && !isDirectory
      ? getValItemContent(valId, branchId, baseVersion, filePath)
      : Promise.resolve(undefined);
  const getRemoteContent = () =>
    remote && !isDirectory
      ? getValItemContent(valId, branchId, version, filePath)
      : Promise.resolve(undefined);

  let localSameAsBase = false;
  let remoteSameAsBase = false;
  let localSameAsRemote = false;

  if (!isDirectory) {
    if (local && base) {
      localSameAsBase = local.mtime === new Date(base.updatedAt).getTime() ||
        local.content === await getBaseContent();
    }
    if (remote && base) {
      remoteSameAsBase = base.updatedAt === remote.updatedAt ||
        (await getRemoteContent()) === await getBaseContent();
    }
    // L vs R only matters when neither side matches the base (edit/edit vs
    // converged) or when the path is missing from the base (create/create)
    if (
      local && remote &&
      (!base || (!localSameAsBase && !remoteSameAsBase))
    ) {
      localSameAsRemote = local.content === await getRemoteContent();
    }
  }

  const classification = classifyItemState({
    inBase: base !== undefined,
    inLocal: local !== undefined,
    inRemote: remote !== undefined,
    isDirectory: isDirectory ?? false,
    localSameAsBase,
    remoteSameAsBase,
    localSameAsRemote,
  });

  const type = local?.type ?? remote?.type ?? base?.type ?? "file";
  const localFilePath = join(targetDir, filePath);
  const remoteMtime = remote ? new Date(remote.updatedAt).getTime() : undefined;

  switch (classification.kind) {
    case "absent":
      return null;
    case "not_modified":
      return {
        status: "not_modified",
        type,
        path: filePath,
        mtime: local?.mtime ?? remoteMtime!,
        content: local?.content,
      };
    case "created":
      if (classification.where === "local") {
        return {
          status: "created",
          where: "local",
          type,
          path: filePath,
          mtime: local!.mtime,
          content: local!.content,
          warnings: await getItemWarnings(localFilePath),
        };
      }
      return {
        status: "created",
        where: "remote",
        type,
        path: filePath,
        mtime: remoteMtime!,
        content: await getRemoteContent(),
      };
    case "deleted":
      if (classification.where === "local") {
        // Present remotely, deleted from the working directory. Content is
        // the remote content so local rename detection can pair it up.
        return {
          status: "deleted",
          where: "local",
          type,
          path: filePath,
          mtime: remoteMtime!,
          content: await getRemoteContent(),
        };
      }
      return {
        status: "deleted",
        where: "remote",
        type,
        path: filePath,
        mtime: local!.mtime,
        content: local!.content,
      };
    case "modified":
      return {
        status: "modified",
        where: classification.where,
        type,
        path: filePath,
        // For remote modifications the mtime is the remote updatedAt so
        // pull can stamp the written file with it
        mtime: classification.where === "remote" ? remoteMtime! : local!.mtime,
        content: local!.content,
        warnings: await getItemWarnings(localFilePath),
      };
    case "conflicted":
      return {
        status: "conflicted",
        conflictKind: classification.conflictKind,
        type,
        path: filePath,
        mtime: local?.mtime ?? remoteMtime!,
        content: local?.content ?? await getRemoteContent(),
        baseContent: await getBaseContent(),
        localContent: local?.content,
        remoteContent: await getRemoteContent(),
        warnings: local ? await getItemWarnings(localFilePath) : undefined,
      };
  }
}

/**
 * Legacy two-way status: compares the working directory against the remote
 * at `version` only. Modification direction is guessed from mtimes and
 * existence changes are interpreted from the local (push) perspective.
 */
async function twoWayStatus(params: StatusParams): Promise<StatusResult> {
  const {
    targetDir,
    valId,
    branchId,
    version,
    gitignoreRules,
  } = params;
  const result = new ItemStatusManager();

  const localFiles = await getLocalFiles({
    valId,
    branchId,
    version,
    targetDir,
    gitignoreRules,
  });
  const valFiles = await getValFiles({
    valId,
    branchId,
    version,
    gitignoreRules,
    targetDir,
  });
  const valFileMap = new Map(valFiles.map((file) => [file.path, file]));

  // Compare local files against Val files
  for (const localFile of localFiles) {
    const valFileInfo = valFileMap.get(localFile.path);
    const localFilePath = join(targetDir, localFile.path);

    if (valFileInfo === undefined) {
      // File exists locally but not in Val - it's created
      const createdFileState: CreatedItemStatus = {
        status: "created",
        where: "local",
        type: localFile.type,
        path: localFile.path,
        mtime: localFile.mtime,
        content: localFile.content,
        warnings: await getItemWarnings(localFilePath),
      };
      result.insert(createdFileState);
    } else {
      if (localFile.type !== "directory") {
        const localStat = await Deno.stat(path.join(targetDir, localFile.path));

        // File exists in both places, check if modified
        const [isModified, where] = isFileModified({
          localContent: localFile.content!, // We know it isn't a dir, so there should be content
          localMtime: localFile.mtime,
          remoteContent: valFileInfo.content!,
          remoteMtime: valFileInfo.mtime,
        });

        if (isModified) {
          const modifiedFileState: ModifiedItemStatus = {
            type: localFile.type,
            path: localFile.path,
            status: "modified",
            where,
            mtime: localStat.mtime!.getTime(),
            content: localFile.content,
            warnings: await getItemWarnings(localFilePath),
          };
          result.insert(modifiedFileState);
        } else {
          const notModifiedFileState: NotModifiedItemStatus = {
            type: localFile.type,
            path: localFile.path,
            status: "not_modified",
            mtime: localStat.mtime!.getTime(),
            content: localFile.content,
          };
          result.insert(notModifiedFileState);
        }
      } else {
        const notModifiedFileState: NotModifiedItemStatus = {
          type: localFile.type,
          path: localFile.path,
          status: "not_modified",
          mtime: localFile.mtime,
          content: localFile.content,
        };
        result.insert(notModifiedFileState);
      }
    }
  }

  // Check for files that exist in Val but not locally
  for (const valFile of valFiles) {
    if (!localFiles.find((f) => f.path === valFile.path)) {
      const deletedFileState: DeletedItemStatus = {
        type: valFile.type,
        path: valFile.path,
        status: "deleted",
        where: "local",
        mtime: valFile.mtime,
        content: valFile.content,
      };
      result.insert(deletedFileState);
    }
  }

  return { itemStateChanges: result.consolidateRenames() };
}

async function getValFiles({
  valId,
  branchId,
  version,
  gitignoreRules,
  targetDir,
}: {
  valId: string;
  branchId: string;
  version: number;
  gitignoreRules?: string[];
  targetDir: string;
}): Promise<ItemInfo[]> {
  return Promise.all(
    (await listValItems(valId, branchId, version))
      .filter((file) => !shouldIgnore(file.path, gitignoreRules))
      .map(async (file): Promise<ItemInfo> => {
        let itemContent: string | undefined;

        const localFileMTime = await exists(join(targetDir, file.path))
          ? (await Deno
            .stat(join(targetDir, file.path))
            .then((stat) => !stat.isDirectory && stat.mtime!.getTime()))
          : undefined;
        const remoteFileMTime = new Date(file.updatedAt).getTime();

        const definitelyIsNotModified = file.type === "directory" ||
          localFileMTime === remoteFileMTime;

        if (definitelyIsNotModified && file.type !== "directory") {
          // If the file is not modified, we can fetch its content from the local copy
          itemContent = await Deno.readTextFile(join(targetDir, file.path));
        } else if (file.type !== "directory") {
          // If the file is modified, we need to fetch its content from Val
          itemContent = await getValItemContent(
            valId,
            branchId,
            version,
            file.path,
          );
        }

        return ({
          path: file.path,
          type: file.type,
          mtime: new Date(file.updatedAt).getTime(),
          content: itemContent,
        });
      }),
  );
}

async function getLocalFiles({
  valId,
  branchId,
  version,
  targetDir,
  gitignoreRules,
}: {
  valId: string;
  branchId: string;
  version: number;
  targetDir: string;
  gitignoreRules?: string[];
}): Promise<ItemInfo[]> {
  const filePromises: Promise<ItemInfo | null>[] = [];

  for await (const entry of fs.walk(targetDir)) {
    filePromises.push((async () => {
      // Check if this is on the ignore list
      const relativePath = path.relative(targetDir, entry.path).replaceAll(
        "\\",
        "/",
      );
      if (shouldIgnore(relativePath, gitignoreRules)) return null;
      if (entry.path === targetDir) return null;

      const localStat = await Deno.stat(entry.path);

      const fileContent = await Deno.readTextFile(entry.path)
        .catch((_e) => undefined);

      return {
        path: relativePath,
        type: entry.isDirectory ? "directory" : await getValItemType(
          valId,
          branchId,
          version,
          relativePath,
        ),
        mtime: localStat.mtime!.getTime(),
        content: entry.isDirectory ? undefined : fileContent,
      };
    })());
  }

  // Wait for all promises to resolve and filter out nulls
  const results = await Promise.all(filePromises);
  return results.filter((item): item is ItemInfo => item !== null);
}
