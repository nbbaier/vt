/**
 * Helpers for creating an automated git commit after a `vt pull` or `vt push`.
 *
 * The feature is opt-out: when the Val directory lives inside a git working
 * tree, a commit is created automatically once the sync resolves. It can be
 * turned off persistently via the `gitAutoCommit.enabled` config key, and
 * overridden per-invocation with the `gitCommit` tri-state (see
 * {@link maybeGitAutoCommit}).
 */

import { colors } from "@cliffy/ansi/colors";
import { shouldIgnore } from "~/vt/lib/paths.ts";
import { META_FOLDER_NAME } from "~/consts.ts";

/** The kind of sync operation that triggered the commit. */
export type GitAutoCommitOperation = "pull" | "push";

/**
 * Options controlling how {@link maybeGitAutoCommit} behaves.
 */
export interface GitAutoCommitOptions {
  /** Message overriding the default `vt <operation> <timestamp>`. */
  message?: string;
  /**
   * VT ignore rules (from `VTMeta.loadGitignoreRules()`) used to keep VT
   * metadata and VT-ignored files out of the commit. The `.vt` metadata folder
   * is always excluded regardless of this list.
   */
  ignoreRules?: string[];
  /**
   * The resolved `gitAutoCommit.enabled` config value, consulted only when the
   * `gitCommit` tri-state is `undefined`. Defaults to enabled when unset.
   */
  configEnabled?: boolean;
}

/** The outcome of an auto-commit attempt, for display and testing. */
export type GitAutoCommitResult =
  | { status: "disabled" }
  | { status: "not-a-repo" }
  | { status: "nothing-to-commit" }
  | { status: "committed"; message: string };

/**
 * Run a git command in the given directory, returning the trimmed stdout and
 * whether it succeeded. Never throws for a non-zero exit — callers decide how
 * to react.
 *
 * @param cwd Directory to run git in.
 * @param args Arguments to pass to git.
 * @returns The exit success flag along with captured stdout/stderr.
 */
async function runGit(
  cwd: string,
  args: string[],
): Promise<{ success: boolean; stdout: string; stderr: string }> {
  const command = new Deno.Command("git", {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
  });
  const { success, stdout, stderr } = await command.output();
  return {
    success,
    stdout: new TextDecoder().decode(stdout).trim(),
    stderr: new TextDecoder().decode(stderr).trim(),
  };
}

/**
 * Collect the paths under `dir` (the Val root) that have working-tree changes,
 * filtered to exclude VT metadata (the `.vt` folder) and anything matched by
 * the VT ignore rules. Returned paths are relative to `dir`, matching how VT
 * ignore rules are authored.
 *
 * `git status` already honors the repo's own `.gitignore`, so this only needs
 * to additionally drop paths that git tracks but VT deliberately ignores (for
 * example `.vt/state.json`, a local `.vt/config.yaml`, or `.vtignore`d files).
 *
 * @param dir The Val root directory.
 * @param ignoreRules VT ignore rules to filter against.
 * @returns The Val-root-relative paths that should be staged.
 */
async function collectPathsToStage(
  dir: string,
  ignoreRules: string[],
): Promise<string[]> {
  // Path of the Val root relative to the git repo root, e.g. "myval/" (empty
  // when the Val root *is* the repo root). `git status` reports paths relative
  // to the repo root, so we strip this prefix to get Val-root-relative paths.
  const { stdout: prefix } = await runGit(dir, ["rev-parse", "--show-prefix"]);

  // NUL-delimited porcelain status of the Val subtree, with untracked files
  // expanded individually rather than collapsed to their parent directory.
  const command = new Deno.Command("git", {
    args: [
      "status",
      "--porcelain",
      "-z",
      "--untracked-files=all",
      "--",
      ".",
    ],
    cwd: dir,
    stdout: "piped",
    stderr: "piped",
  });
  const { success, stdout } = await command.output();
  if (!success) return [];

  const tokens = new TextDecoder().decode(stdout).split("\0");

  // Always keep VT's own metadata folder out, even if the caller passed no
  // ignore rules.
  const rules = [META_FOLDER_NAME, ...ignoreRules];

  const paths: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === "") continue;

    // Each record is "XY <path>"; the two status columns are followed by a
    // space and the repo-root-relative path.
    const status = token.slice(0, 2);
    const repoRelPath = token.slice(3);

    // Renames/copies encode "R"/"C" and carry the original path in the next
    // NUL-separated token; consume it so it isn't parsed as a status record.
    if (status.includes("R") || status.includes("C")) i++;

    // Convert to a Val-root-relative path for both ignore matching and staging.
    const relPath = prefix && repoRelPath.startsWith(prefix)
      ? repoRelPath.slice(prefix.length)
      : repoRelPath;

    if (relPath === "") continue;
    if (shouldIgnore(relPath, rules)) continue;

    paths.push(relPath);
  }

  return paths;
}

/**
 * Whether the given directory is inside a git working tree.
 *
 * @param dir The directory to check.
 * @returns True if inside a git work tree, false otherwise (including when git
 * is not installed).
 */
export async function isInsideGitRepo(dir: string): Promise<boolean> {
  try {
    const { success, stdout } = await runGit(dir, [
      "rev-parse",
      "--is-inside-work-tree",
    ]);
    return success && stdout === "true";
  } catch {
    // git binary missing, permission denied, etc. Treat as "not a repo" so the
    // sync itself is never blocked by the auto-commit feature.
    return false;
  }
}

/**
 * Build the default commit message used for an automated commit, of the form
 * `vt <operation> <timestamp>` (e.g. `vt push 2026-07-15T12:34:56.789Z`).
 *
 * @param operation The sync operation that produced the changes.
 * @param timestamp The timestamp to embed. Defaults to the current time as an
 * ISO 8601 string.
 * @returns The commit message.
 */
export function gitAutoCommitMessage(
  operation: GitAutoCommitOperation,
  timestamp: string = new Date().toISOString(),
): string {
  return `vt ${operation} ${timestamp}`;
}

/**
 * Create an automated git commit for the changes in `dir` after a sync.
 *
 * Behavior is governed by the `gitCommit` tri-state, which maps to the
 * `--git-commit` / `--no-git-commit` flags:
 * - `undefined` (no flag): defer to `options.configEnabled` (the
 *   `gitAutoCommit.enabled` config key), which defaults to enabled. Commits
 *   only when `dir` is inside a git repo.
 * - `true` (`--git-commit`): commit even if the config disabled it; a no-op
 *   (with `not-a-repo`) when `dir` is not in a git repo.
 * - `false` (`--no-git-commit`): never commit.
 *
 * Only changes in the Val subtree are considered, and VT metadata (the `.vt`
 * folder) plus anything matched by the supplied VT ignore rules are filtered
 * out before staging. Only the explicitly staged paths are committed, so
 * pre-existing staged changes elsewhere in the repo are left untouched. When
 * there is nothing (left) to commit the function is a no-op.
 *
 * @param dir The Val directory whose changes should be committed.
 * @param operation The sync operation that triggered the commit.
 * @param gitCommit The tri-state controlling whether to commit.
 * @param options Optional message override and VT ignore rules.
 * @returns A result describing what happened.
 */
export async function maybeGitAutoCommit(
  dir: string,
  operation: GitAutoCommitOperation,
  gitCommit: boolean | undefined,
  options: GitAutoCommitOptions = {},
): Promise<GitAutoCommitResult> {
  const { message: customMessage, ignoreRules = [], configEnabled } = options;

  // Explicitly disabled with --no-git-commit.
  if (gitCommit === false) return { status: "disabled" };

  // With no flag, the config decides (defaulting to enabled). An explicit
  // --git-commit overrides a config-level disable for this one invocation.
  if (gitCommit === undefined && configEnabled === false) {
    return { status: "disabled" };
  }

  // Auto mode and forced mode both require an actual git repo.
  if (!(await isInsideGitRepo(dir))) return { status: "not-a-repo" };

  // Figure out which changed paths to stage, dropping VT metadata and
  // VT-ignored files so we never commit `.vt/state.json`, a local
  // `.vt/config.yaml`, or `.vtignore`d files.
  const pathsToStage = await collectPathsToStage(dir, ignoreRules);
  if (pathsToStage.length === 0) return { status: "nothing-to-commit" };

  // Stage exactly those paths (`-A` so deletions are staged too).
  await runGit(dir, ["add", "-A", "--", ...pathsToStage]);

  const message = customMessage && customMessage.length > 0
    ? customMessage
    : gitAutoCommitMessage(operation);
  const { success, stderr } = await runGit(dir, [
    "commit",
    "-m",
    message,
    "--",
    ...pathsToStage,
  ]);

  if (!success) {
    throw new Error(
      `Auto-commit failed: ${stderr || "git commit returned a non-zero exit"}`,
    );
  }

  return { status: "committed", message };
}

/**
 * Run {@link maybeGitAutoCommit} and print a short, user-facing line describing
 * the outcome.
 *
 * In automatic mode (`gitCommit` is `undefined`) nothing is printed unless a
 * commit is actually made, so users who aren't using git, or who disabled the
 * feature via config, never see noise. When the commit was explicitly requested
 * with `--git-commit`, cases that produced no commit are surfaced as warnings
 * so the request isn't silently ignored.
 *
 * @param dir The Val directory whose changes should be committed.
 * @param operation The sync operation that triggered the commit.
 * @param gitCommit The tri-state controlling whether to commit.
 * @param options Optional message override and VT ignore rules.
 * @returns The result of the auto-commit attempt.
 */
export async function reportGitAutoCommit(
  dir: string,
  operation: GitAutoCommitOperation,
  gitCommit: boolean | undefined,
  options: GitAutoCommitOptions = {},
): Promise<GitAutoCommitResult> {
  const result = await maybeGitAutoCommit(dir, operation, gitCommit, options);
  const forced = gitCommit === true;

  switch (result.status) {
    case "committed":
      console.log(
        colors.green("Created git commit: ") + colors.dim(result.message),
      );
      break;
    case "not-a-repo":
      if (forced) {
        console.log(
          colors.yellow(
            "Skipped git commit: this folder is not inside a git repository.",
          ),
        );
      }
      break;
    case "nothing-to-commit":
      if (forced) {
        console.log(
          colors.yellow("Skipped git commit: nothing to commit."),
        );
      }
      break;
    case "disabled":
      break;
  }

  return result;
}
