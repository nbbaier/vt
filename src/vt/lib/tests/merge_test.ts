import { assert, assertEquals, assertFalse } from "@std/assert";
import { containsConflictMarkers, mergeText } from "~/vt/lib/utils/merge.ts";

Deno.test("mergeText merges non-overlapping edits cleanly", () => {
  const base = "one\ntwo\nthree\nfour\nfive\n";
  const local = "ONE\ntwo\nthree\nfour\nfive\n"; // edited line 1
  const remote = "one\ntwo\nthree\nfour\nFIVE\n"; // edited line 5

  const result = mergeText({ base, local, remote });

  assert(result.clean, "non-overlapping edits should merge cleanly");
  assertEquals(result.content, "ONE\ntwo\nthree\nfour\nFIVE\n");
});

Deno.test("mergeText keeps identical edits without conflict", () => {
  const base = "a\nb\nc\n";
  const both = "a\nB\nc\n";

  const result = mergeText({ base, local: both, remote: both });

  assert(result.clean);
  assertEquals(result.content, both);
});

Deno.test("mergeText writes git-style markers for overlapping edits", () => {
  const base = "a\nb\nc\n";
  const local = "a\nlocal change\nc\n";
  const remote = "a\nremote change\nc\n";

  const result = mergeText({
    base,
    local,
    remote,
    remoteLabel: "remote (version 45)",
  });

  assertFalse(result.clean);
  assertEquals(
    result.content,
    "a\n" +
      "<<<<<<< local\n" +
      "local change\n" +
      "=======\n" +
      "remote change\n" +
      ">>>>>>> remote (version 45)\n" +
      "c\n",
  );
  assert(containsConflictMarkers(result.content));
});

Deno.test("mergeText conflicts on a create/create with an empty base", () => {
  const result = mergeText({
    base: "",
    local: "local file\n",
    remote: "remote file\n",
  });

  assertFalse(result.clean);
  assert(containsConflictMarkers(result.content));
});

Deno.test("mergeText preserves the absence of a trailing newline", () => {
  const result = mergeText({
    base: "a\nb",
    local: "a2\nb",
    remote: "a\nb",
  });

  assert(result.clean);
  assertEquals(result.content, "a2\nb");
});

Deno.test("containsConflictMarkers requires a full ordered triple", () => {
  assert(containsConflictMarkers(
    "<<<<<<< local\nx\n=======\ny\n>>>>>>> remote\n",
  ));

  // Out of order or incomplete sequences are not conflicts
  assertFalse(containsConflictMarkers("=======\n<<<<<<< a\n>>>>>>> b\n"));
  assertFalse(containsConflictMarkers("<<<<<<< local\nno separator\n"));
  assertFalse(containsConflictMarkers("plain file\nwith ======= a divider\n"));
  assertFalse(containsConflictMarkers(""));
});
