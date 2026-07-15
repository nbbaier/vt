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

Deno.test("gitAutoCommit.enabled false disables committing", async () => {
  await doWithTempDir(async (tmpDir) => {
    await initRepo(tmpDir);
    await Deno.writeTextFile(join(tmpDir, "main.ts"), "console.log('hi');");

    const result = await maybeGitAutoCommit(tmpDir, "push", undefined, {
      configEnabled: false,
    });
    assertEquals(result.status, "disabled");

    // Nothing was committed, so the new file is still untracked.
    const status = await git(tmpDir, ["status", "--porcelain"]);
    assertEquals(status, "?? main.ts");
  });
});

Deno.test("--git-commit overrides a config-level disable", async () => {
  await doWithTempDir(async (tmpDir) => {
    await initRepo(tmpDir);
    await Deno.writeTextFile(join(tmpDir, "main.ts"), "console.log('hi');");

    const result = await maybeGitAutoCommit(tmpDir, "push", true, {
      configEnabled: false,
    });
    assertEquals(result.status, "committed");

    const committed = await git(tmpDir, ["ls-files"]);
    assertEquals(committed, "main.ts");
  });
});

Deno.test("--no-git-commit wins over gitAutoCommit.enabled true", async () => {
  await doWithTempDir(async (tmpDir) => {
    await initRepo(tmpDir);
    await Deno.writeTextFile(join(tmpDir, "main.ts"), "console.log('hi');");

    const result = await maybeGitAutoCommit(tmpDir, "push", false, {
      configEnabled: true,
    });
    assertEquals(result.status, "disabled");
  });
});

Deno.test("gitAutoCommit.enabled true commits in auto mode", async () => {
  await doWithTempDir(async (tmpDir) => {
    await initRepo(tmpDir);
    await Deno.writeTextFile(join(tmpDir, "main.ts"), "console.log('hi');");

    const result = await maybeGitAutoCommit(tmpDir, "pull", undefined, {
      configEnabled: true,
    });
    assertEquals(result.status, "committed");
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
      { message: "my custom snapshot" },
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

Deno.test("VT metadata is never committed", async () => {
  await doWithTempDir(async (tmpDir) => {
    await initRepo(tmpDir);
    // A real Val file alongside VT metadata that git does not ignore.
    await Deno.writeTextFile(join(tmpDir, "main.ts"), "console.log('hi');");
    await Deno.mkdir(join(tmpDir, ".vt"));
    await Deno.writeTextFile(join(tmpDir, ".vt", "state.json"), "{}");
    await Deno.writeTextFile(join(tmpDir, ".vt", "config.yaml"), "apiKey: x");

    const result = await maybeGitAutoCommit(tmpDir, "push", undefined);
    assertEquals(result.status, "committed");

    // The Val file is committed; the .vt metadata is not.
    const committed = await git(tmpDir, ["ls-files"]);
    assertEquals(committed, "main.ts");

    // The metadata is still present but untracked.
    const status = await git(tmpDir, ["status", "--porcelain"]);
    assertMatch(status, /\?\? \.vt\//);
  });
});

Deno.test("VT ignore rules keep ignored files out of the commit", async () => {
  await doWithTempDir(async (tmpDir) => {
    await initRepo(tmpDir);
    await Deno.writeTextFile(join(tmpDir, "main.ts"), "console.log('hi');");
    await Deno.writeTextFile(join(tmpDir, "secret.env"), "TOKEN=abc");

    // secret.env is ignored by VT but not by git.
    const result = await maybeGitAutoCommit(tmpDir, "push", undefined, {
      ignoreRules: ["secret.env"],
    });
    assertEquals(result.status, "committed");

    const committed = await git(tmpDir, ["ls-files"]);
    assertEquals(committed, "main.ts");
  });
});

Deno.test("a metadata-only change produces no commit", async () => {
  await doWithTempDir(async (tmpDir) => {
    await initRepo(tmpDir);
    await Deno.writeTextFile(join(tmpDir, "main.ts"), "console.log('hi');");
    await git(tmpDir, ["add", "-A"]);
    await git(tmpDir, ["commit", "-q", "-m", "initial"]);

    // Simulate what a no-op sync does: rewrite only VT metadata.
    await Deno.mkdir(join(tmpDir, ".vt"));
    await Deno.writeTextFile(
      join(tmpDir, ".vt", "state.json"),
      '{"updated":true}',
    );

    const result = await maybeGitAutoCommit(tmpDir, "pull", undefined);
    assertEquals(result.status, "nothing-to-commit");
  });
});

Deno.test("the Val root can be nested below the git repo root", async () => {
  await doWithTempDir(async (tmpDir) => {
    await initRepo(tmpDir);
    const valDir = join(tmpDir, "myval");
    await Deno.mkdir(valDir);
    await Deno.writeTextFile(join(valDir, "main.ts"), "console.log('hi');");
    await Deno.mkdir(join(valDir, ".vt"));
    await Deno.writeTextFile(join(valDir, ".vt", "state.json"), "{}");

    // Commit is scoped to the nested Val directory, metadata excluded.
    const result = await maybeGitAutoCommit(valDir, "push", undefined);
    assertEquals(result.status, "committed");

    const committed = await git(tmpDir, ["ls-files"]);
    assertEquals(committed, "myval/main.ts");
  });
});
