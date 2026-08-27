# 0007 — diff3 via the `node-diff3` npm package

Status: accepted

## Context

Auto-merging edit/edit conflicts needs a line-based three-way merge (diff3):
diff B→L and B→R, compose non-overlapping hunks, emit conflict regions for
overlapping ones. Nothing in `deno.json` provides this. The brainstorm leaves
the choice open between `npm:diff3` / `npm:node-diff3` and vendoring a ~150-line
implementation (noting the repo already vendors comparable logic, e.g.
levenshtein-based rename detection).

## Decision

Depend on `npm:node-diff3` (MIT, zero dependencies, ships TypeScript types),
wrapped in a small module `src/vt/lib/utils/merge.ts` that is the only importer:

- `mergeText({ base, local, remote, labels })` →
  `{ clean: boolean,
  content: string }` — clean merge or marker-bearing text,
  built from `diff3Merge`'s ok/conflict regions so the marker format (0005) is
  ours, not the library's.
- `containsConflictMarkers(content)` — the detection used by the `conflict`
  warning (0006), kept next to the code that produces the markers so the two
  can't drift apart.

## Alternatives rejected

- **Vendoring a diff3.** A correct diff3 needs a correct underlying LCS / Myers
  diff; that's the kind of subtly-wrong-at-the-edges code that a battle-tested
  library exists for. The rename-detection precedent is a heuristic where
  "roughly right" is fine — a merge that silently drops or duplicates lines is
  not that kind of code.
- **`npm:diff` (jsdiff) + hand-rolled hunk composition.** jsdiff provides
  two-way diffs only; the composition step is exactly the risky part.

## Consequences

- One new entry in `deno.json` imports. The wrapper means a future swap (or
  vendoring, should the dependency rot) touches one file.
- `node-diff3`'s `diff3Merge` operates on arrays of lines; the wrapper owns line
  splitting/joining and preserves a trailing newline if either side had one.
