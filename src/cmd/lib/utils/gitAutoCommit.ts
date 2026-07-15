/**
 * Helpers for creating an automated git commit after a `vt pull` or `vt push`.
 *
 * The feature is opt-out: when the Val directory lives inside a git working
 * tree, a commit is created automatically once the sync resolves. Callers can
 * force the behavior on or off with the `gitCommit` tri-state (see
 * {@link maybeGitAutoCommit}).
 */

import { colors } from "@cliffy/ansi/colors";

/** The kind of sync operation that triggered the commit. */
export type GitAutoCommitOperation = "pull" | "push";

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
 * Behavior is governed by the `gitCommit` tri-state:
 * - `undefined` (default): commit only when `dir` is inside a git repo.
 * - `true`: force a commit; a no-op (with `not-a-repo`) when `dir` is not in a
 *   git repo.
 * - `false`: never commit.
 *
 * Only the current directory subtree is staged (`git add -A -- .`) and only
 * those paths are committed, so pre-existing staged changes elsewhere in the
 * repo are left untouched. When there is nothing to commit the function is a
 * no-op.
 *
 * @param dir The Val directory whose changes should be committed.
 * @param operation The sync operation that triggered the commit.
 * @param gitCommit The tri-state controlling whether to commit.
 * @param customMessage Optional message overriding the default
 * `vt <operation> <timestamp>` commit message.
 * @returns A result describing what happened.
 */
export async function maybeGitAutoCommit(
  dir: string,
  operation: GitAutoCommitOperation,
  gitCommit: boolean | undefined,
  customMessage?: string,
): Promise<GitAutoCommitResult> {
  // Explicitly disabled.
  if (gitCommit === false) return { status: "disabled" };

  // Auto mode and forced mode both require an actual git repo.
  if (!(await isInsideGitRepo(dir))) return { status: "not-a-repo" };

  // Stage everything under the current directory subtree.
  await runGit(dir, ["add", "-A", "--", "."]);

  // If nothing is staged for these paths, there is nothing to commit.
  const { success: nothingStaged } = await runGit(dir, [
    "diff",
    "--cached",
    "--quiet",
    "--",
    ".",
  ]);
  if (nothingStaged) return { status: "nothing-to-commit" };

  const message = customMessage && customMessage.length > 0
    ? customMessage
    : gitAutoCommitMessage(operation);
  const { success, stderr } = await runGit(dir, [
    "commit",
    "-m",
    message,
    "--",
    ".",
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
 * commit is actually made, so users who aren't using git never see noise. When
 * the commit was explicitly requested with `--git-commit`, cases that produced
 * no commit are surfaced as warnings so the request isn't silently ignored.
 *
 * @param dir The Val directory whose changes should be committed.
 * @param operation The sync operation that triggered the commit.
 * @param gitCommit The tri-state controlling whether to commit.
 * @param customMessage Optional message overriding the default
 * `vt <operation> <timestamp>` commit message.
 * @returns The result of the auto-commit attempt.
 */
export async function reportGitAutoCommit(
  dir: string,
  operation: GitAutoCommitOperation,
  gitCommit: boolean | undefined,
  customMessage?: string,
): Promise<GitAutoCommitResult> {
  const result = await maybeGitAutoCommit(
    dir,
    operation,
    gitCommit,
    customMessage,
  );
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
