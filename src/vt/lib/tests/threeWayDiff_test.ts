import { assertEquals } from "@std/assert";
import {
  classifyItemState,
  type ItemStateClassification,
  type ItemStateInput,
} from "~/vt/lib/utils/threeWayDiff.ts";

function file(input: Partial<ItemStateInput>): ItemStateInput {
  return {
    inBase: false,
    inLocal: false,
    inRemote: false,
    isDirectory: false,
    localSameAsBase: false,
    remoteSameAsBase: false,
    localSameAsRemote: false,
    ...input,
  };
}

Deno.test("classifyItemState covers the full three-way truth table", () => {
  const cases: [string, ItemStateInput, ItemStateClassification][] = [
    [
      "untouched on both sides",
      file({
        inBase: true,
        inLocal: true,
        inRemote: true,
        localSameAsBase: true,
        remoteSameAsBase: true,
      }),
      { kind: "not_modified" },
    ],
    [
      "modified locally only",
      file({
        inBase: true,
        inLocal: true,
        inRemote: true,
        localSameAsBase: false,
        remoteSameAsBase: true,
      }),
      { kind: "modified", where: "local" },
    ],
    [
      "modified remotely only",
      file({
        inBase: true,
        inLocal: true,
        inRemote: true,
        localSameAsBase: true,
        remoteSameAsBase: false,
      }),
      { kind: "modified", where: "remote" },
    ],
    [
      "both sides converged to the same content",
      file({
        inBase: true,
        inLocal: true,
        inRemote: true,
        localSameAsRemote: true,
      }),
      { kind: "not_modified" },
    ],
    [
      "both sides diverged",
      file({ inBase: true, inLocal: true, inRemote: true }),
      { kind: "conflicted", conflictKind: "edit/edit" },
    ],
    [
      "created locally",
      file({ inLocal: true }),
      { kind: "created", where: "local" },
    ],
    [
      "created remotely",
      file({ inRemote: true }),
      { kind: "created", where: "remote" },
    ],
    [
      "created identically on both sides",
      file({ inLocal: true, inRemote: true, localSameAsRemote: true }),
      { kind: "not_modified" },
    ],
    [
      "created differently on both sides",
      file({ inLocal: true, inRemote: true }),
      { kind: "conflicted", conflictKind: "create/create" },
    ],
    [
      "deleted locally, remote untouched",
      file({ inBase: true, inRemote: true, remoteSameAsBase: true }),
      { kind: "deleted", where: "local" },
    ],
    [
      "deleted locally but modified remotely",
      file({ inBase: true, inRemote: true }),
      { kind: "conflicted", conflictKind: "delete/modify" },
    ],
    [
      "deleted remotely, local untouched",
      file({ inBase: true, inLocal: true, localSameAsBase: true }),
      { kind: "deleted", where: "remote" },
    ],
    [
      "deleted remotely but modified locally",
      file({ inBase: true, inLocal: true }),
      { kind: "conflicted", conflictKind: "modify/delete" },
    ],
    [
      "deleted on both sides",
      file({ inBase: true }),
      { kind: "absent" },
    ],
  ];

  for (const [name, input, expected] of cases) {
    assertEquals(classifyItemState(input), expected, name);
  }
});

Deno.test("classifyItemState uses existence-only rules for directories", () => {
  const dir = (input: Partial<ItemStateInput>): ItemStateInput =>
    file({ ...input, isDirectory: true });

  const cases: [string, ItemStateInput, ItemStateClassification][] = [
    [
      "directory on both sides",
      dir({ inLocal: true, inRemote: true }),
      { kind: "not_modified" },
    ],
    [
      "directory created locally",
      dir({ inLocal: true }),
      { kind: "created", where: "local" },
    ],
    [
      "directory created remotely",
      dir({ inRemote: true }),
      { kind: "created", where: "remote" },
    ],
    [
      "directory deleted remotely",
      dir({ inBase: true, inLocal: true }),
      { kind: "deleted", where: "remote" },
    ],
    [
      "directory deleted locally",
      dir({ inBase: true, inRemote: true }),
      { kind: "deleted", where: "local" },
    ],
    [
      "directory deleted on both sides",
      dir({ inBase: true }),
      { kind: "absent" },
    ],
  ];

  for (const [name, input, expected] of cases) {
    assertEquals(classifyItemState(input), expected, name);
  }
});
