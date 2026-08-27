# 0004 — Classifier is a pure, synchronous function

Status: accepted

## Context

The brainstorm (§5.1) wants `computeThreeWayStatus({base, local, remote})` as a
pure function so branch checkout can reuse it later (§8.6). But the inputs are
not free: base content requires an API fetch, and the whole point of the mtime
fast path is to _avoid_ that fetch for clean files. If the classifier itself
fetches, it isn't pure; if it demands all content up front, the fast path is
dead.

## Decision

Split the problem in two:

1. **`classifyItemState(input)` in `src/vt/lib/utils/threeWayDiff.ts` is pure
   and synchronous.** Its input is a small record of facts:

   ```ts
   {
     inBase, inLocal, inRemote: boolean,
     isDirectory: boolean,
     localSameAsBase, remoteSameAsBase, localSameAsRemote: boolean,
   }
   ```

   and its output is a discriminated classification:
   `not_modified | created(where) | deleted(where) | modified(where) |
   conflicted(kind) | absent`.
   It encodes the truth table from the brainstorm §4.1 (including the "both
   sides converged to the same content" → `not_modified` rows) and the
   existence-only rules for directories. It knows nothing about files, mtimes,
   or the API.

2. **`status()` computes the three equality facts, as lazily as it can**, before
   calling the classifier:
   - `localSameAsBase`: mtime fast path (`localMtime ===
     base.updatedAt`),
     else compare local content against base content (lazy fetch, memoized).
   - `remoteSameAsBase`: listing-timestamp fast path
     (`remote.updatedAt
     === base.updatedAt`), else compare remote content
     against base content.
   - `localSameAsRemote`: straight content comparison (both contents are already
     in hand by the time it matters). Equality facts that a given existence
     combination doesn't need are not computed (e.g. no base fetch when the path
     is absent from B).

`isFileModified()` in `utils/misc.ts` — the two-way heuristic with the
mtime-direction guess — stays only for the legacy no-base path (clone, checkout,
`--force`; see 0008) and is no longer used by three-way status.

## Alternatives rejected

- **Async classifier that takes content-fetching thunks.** Testable only with
  fakes, and the laziness logic gets tangled with the truth table. The truth
  table is the part that must be obviously correct; keeping it synchronous makes
  it exhaustively unit-testable offline.
- **Classifier returns `ItemStatus` objects directly.** It would need paths,
  types, mtimes, contents, and warnings — dragging I/O concerns in. Returning a
  classification and letting `status()` build the `ItemStatus` keeps the
  boundary clean.

## Consequences

- The truth table has a dedicated offline test suite (`threeWayDiff_test.ts`)
  covering all 14 rows of the brainstorm's table.
- Checkout can later reuse `classifyItemState` with a fork-point base without
  touching status plumbing.
