import { assert, assertEquals, assertMatch } from "@std/assert";
import { doWithTempDir } from "~/vt/lib/utils/misc.ts";
import { join } from "@std/path";
import {
  gitAutoCommitMessage,
  isInsideGitRepo,
  maybeGitAutoCommit,
} from "./gitAutoCommit.ts";

/** Run a git command in a directory, asserting it succeeds. */
async function git(cwd: string, args: string[]): Promise<string> {
  const { success, stdout } = await new Deno.Command("git", {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!success) throw new Error(`git ${args.join(" ")} failed`);
  return new TextDecoder().decode(stdout).trim();
}

/** Initialize a git repo with a committer identity in the given dir. */
async function initRepo(dir: string): Promise<void> {
  await git(dir, ["init", "-q"]);
  await git(dir, ["config", "user.email", "test@example.com"]);
  await git(dir, ["config", "user.name", "Test"]);
}

Deno.test("isInsideGitRepo detects git and non-git dirs", async () => {
  await doWithTempDir(async (tmpDir) => {
    assertEquals(await isInsideGitRepo(tmpDir), false);
    await initRepo(tmpDir);
    assertEquals(await isInsideGitRepo(tmpDir), true);
  });
});

Deno.test("auto mode commits when in a git repo", async () => {
  await doWithTempDir(async (tmpDir) => {
    await initRepo(tmpDir);
    await Deno.writeTextFile(join(tmpDir, "main.ts"), "console.log('hi');");

    const result = await maybeGitAutoCommit(tmpDir, "pull", undefined);
    assertEquals(result.status, "committed");

    // The working tree should now be clean (everything committed).
    const status = await git(tmpDir, ["status", "--porcelain"]);
    assertEquals(status, "");

    // Default message is "vt <operation> <timestamp>".
    const log = await git(tmpDir, ["log", "-1", "--pretty=%s"]);
    assertMatch(log, /^vt pull \d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
  });
});

Deno.test("auto mode is a no-op outside a git repo", async () => {
  await doWithTempDir(async (tmpDir) => {
    await Deno.writeTextFile(join(tmpDir, "main.ts"), "console.log('hi');");
    const result = await maybeGitAutoCommit(tmpDir, "push", undefined);
    assertEquals(result.status, "not-a-repo");
  });
});

Deno.test("--no-git-commit disables committing", async () => {
  await doWithTempDir(async (tmpDir) => {
    await initRepo(tmpDir);
    await Deno.writeTextFile(join(tmpDir, "main.ts"), "console.log('hi');");

    const result = await maybeGitAutoCommit(tmpDir, "push", false);
    assertEquals(result.status, "disabled");

    // Nothing was committed, so the new file is still untracked.
    const status = await git(tmpDir, ["status", "--porcelain"]);
    assertEquals(status, "?? main.ts");
  });
});

Deno.test("nothing-to-commit when tree is clean", async () => {
  await doWithTempDir(async (tmpDir) => {
    await initRepo(tmpDir);
    await Deno.writeTextFile(join(tmpDir, "main.ts"), "console.log('hi');");
    await git(tmpDir, ["add", "-A"]);
    await git(tmpDir, ["commit", "-q", "-m", "initial"]);

    const result = await maybeGitAutoCommit(tmpDir, "pull", undefined);
    assertEquals(result.status, "nothing-to-commit");
  });
});

Deno.test("push commit message differs from pull", async () => {
  await doWithTempDir(async (tmpDir) => {
    await initRepo(tmpDir);
    await Deno.writeTextFile(join(tmpDir, "main.ts"), "console.log('hi');");

    const result = await maybeGitAutoCommit(tmpDir, "push", true);
    assertEquals(result.status, "committed");

    const log = await git(tmpDir, ["log", "-1", "--pretty=%s"]);
    assertMatch(log, /^vt push \d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
  });
});

Deno.test("a custom message overrides the default", async () => {
  await doWithTempDir(async (tmpDir) => {
    await initRepo(tmpDir);
    await Deno.writeTextFile(join(tmpDir, "main.ts"), "console.log('hi');");

    const result = await maybeGitAutoCommit(
      tmpDir,
      "push",
      undefined,
      "my custom snapshot",
    );
    assertEquals(result.status, "committed");
    assert(result.status === "committed");
    assertEquals(result.message, "my custom snapshot");

    const log = await git(tmpDir, ["log", "-1", "--pretty=%s"]);
    assertEquals(log, "my custom snapshot");
  });
});

Deno.test("gitAutoCommitMessage builds vt <op> <timestamp>", () => {
  assertEquals(
    gitAutoCommitMessage("pull", "2026-07-15T12:34:56.789Z"),
    "vt pull 2026-07-15T12:34:56.789Z",
  );
  assertEquals(
    gitAutoCommitMessage("push", "2026-07-15T12:34:56.789Z"),
    "vt push 2026-07-15T12:34:56.789Z",
  );
});
