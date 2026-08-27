import { assert, assertEquals, assertFalse } from "@std/assert";
import { join } from "@std/path";
import {
  type ConflictedItemStatus,
  getItemWarnings,
  ItemStatusManager,
} from "~/vt/lib/utils/ItemStatusManager.ts";
import { doWithTempDir } from "~/vt/lib/utils/misc.ts";

function conflictedItem(path: string): ConflictedItemStatus {
  return {
    status: "conflicted",
    conflictKind: "edit/edit",
    type: "file",
    path,
    mtime: 1000,
    baseContent: "base",
    localContent: "local",
    remoteContent: "remote",
  };
}

Deno.test("ItemStatusManager tracks conflicted items as a first-class category", () => {
  const manager = new ItemStatusManager();
  manager.insert(conflictedItem("a.ts"));
  manager.insert({
    status: "not_modified",
    type: "file",
    path: "b.ts",
    mtime: 1000,
  });

  assertEquals(manager.conflicted.length, 1);
  assertEquals(manager.size(), 2);
  assertEquals(manager.changes(), 1, "conflicts count as changes");
  assert(manager.has("a.ts"));
  assertEquals(manager.get("a.ts").status, "conflicted");
  assertFalse(manager.isEmpty());

  // Conflicts survive filter/map/merge/toJSON round trips
  assertEquals(
    manager.filter((item) => item.status === "conflicted").conflicted.length,
    1,
  );
  assertEquals(manager.map((item) => item).conflicted.length, 1);
  assertEquals(manager.toJSON().conflicted.length, 1);

  const target = new ItemStatusManager();
  target.insert({
    status: "modified",
    where: "local",
    type: "file",
    path: "a.ts",
    mtime: 500,
    content: "old",
  });
  target.merge(manager);
  assertEquals(
    target.get("a.ts").status,
    "conflicted",
    "merge replaces an existing entry at the same path",
  );

  assert(manager.remove("a.ts"));
  assertFalse(manager.has("a.ts"));
});

Deno.test("consolidateRenames only pairs local-side changes", () => {
  const content = "the file content that moved";

  // A remote delete + remote create with similar content is not a local
  // rename; pull applies each side separately
  const remoteSides = new ItemStatusManager();
  remoteSides.insert({
    status: "deleted",
    where: "remote",
    type: "file",
    path: "old.ts",
    mtime: 1000,
    content,
  });
  remoteSides.insert({
    status: "created",
    where: "remote",
    type: "file",
    path: "new.ts",
    mtime: 2000,
    content,
  });
  remoteSides.consolidateRenames();
  assertEquals(remoteSides.renamed.length, 0);

  const localSides = new ItemStatusManager();
  localSides.insert({
    status: "deleted",
    where: "local",
    type: "file",
    path: "old.ts",
    mtime: 1000,
    content,
  });
  localSides.insert({
    status: "created",
    where: "local",
    type: "file",
    path: "new.ts",
    mtime: 2000,
    content,
  });
  localSides.consolidateRenames();
  assertEquals(localSides.renamed.length, 1);
  assertEquals(localSides.renamed[0].oldPath, "old.ts");
  assertEquals(localSides.renamed[0].path, "new.ts");
});

Deno.test("getItemWarnings flags files containing conflict markers", async () => {
  await doWithTempDir(async (tmpDir) => {
    const conflicted = join(tmpDir, "conflicted.ts");
    await Deno.writeTextFile(
      conflicted,
      "<<<<<<< local\nmine\n=======\ntheirs\n>>>>>>> remote (version 4)\n",
    );
    assert((await getItemWarnings(conflicted)).includes("conflict"));

    const clean = join(tmpDir, "clean.ts");
    await Deno.writeTextFile(clean, "console.log('hi');\n");
    assertFalse((await getItemWarnings(clean)).includes("conflict"));
  });
});
