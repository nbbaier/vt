# 0002 — Merge base comes from remote version history

Status: accepted

## Context

Three-way diffing needs a base snapshot **B** — the state both sides diverged
from. The brainstorm's key insight (§3) is that vt already has it:
`.vt/state.json` records `branch.version` after every successful sync, and after
a sync the local tree _is_ the remote tree at that version. So the remote
listing at `state.branch.version` is a faithful record of what the local
directory looked like at the last sync, and the API is version-addressable
(`listValItems` / `getValItemContent` both take a version and are memoized in
`src/sdk.ts`).

## Decision

- The base is the remote tree at `state.branch.version`. No shadow copies, no
  local snapshot database, no schema migration.
- `status()` gains an optional `baseVersion` parameter. When provided, it
  fetches one extra (memoized) listing —
  `listValItems(valId, branchId,
  baseVersion)` — and classifies each path
  three-way.
- Base file _content_ is fetched lazily, per path, only when the mtime fast path
  can't settle the question (see 0004). Fetches go through the memoized
  `getValItemContent`, so repeated classification is free.
- When `baseVersion` is absent (older callers, `--force`, checkout), the code
  degrades to the existing two-way behavior (see 0008).

The mtime fast path: clone/pull set each written file's mtime to the remote
`updatedAt`, and every copy in the sync paths preserves timestamps. So
`localMtime === baseFile.updatedAt` proves L = B without any content fetch. The
current code compares local mtime against the _latest_ version's `updatedAt` —
which is exactly where today's direction-guessing comes from — so the pivot to
comparing against the _base_ version's timestamp is the heart of the fix.

For the remote side, R = B is assumed when the two listings report the same
`updatedAt` for the path. This leans on the brainstorm's open question ("does
the listing at an old version return `updatedAt` values as of that version?") —
the API returns per-file update times, so two listings agreeing on a file's
`updatedAt` means the file did not change between those versions. If they
disagree, we fall back to comparing content, so a false negative only costs a
fetch, never correctness.

## Alternatives rejected

- **Local shadow copy of the last-synced tree** (like git's index). Rejected:
  new on-disk state, migration concerns, and the server already stores the same
  information.
- **Content hashes recorded in `state.json`.** Same objection, and it can't
  reconstruct base _content_ for merging, only detect change.

## Consequences

- One extra API call per status/pull (the base listing), plus per-path
  base-content fetches only for paths that changed on both sides.
- Correctness depends on `branch.version` being advanced accurately. Two
  pre-existing gaps documented in the brainstorm (§6.1 non-atomic push, §6.2
  version-bump race) remain and are recorded as known limitations in 0008. One
  real bug found during implementation: `VTClient.pull()` only advanced
  `branch.version` when the caller passed `dryRun: false` _explicitly_ — a plain
  `vt pull` (options omitted) never advanced it. Harmless while the version was
  only informational; load-bearing now. Fixed as part of this change.
