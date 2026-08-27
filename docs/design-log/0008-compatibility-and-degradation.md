# 0008 — Degradation, compatibility, and known limitations

Status: accepted

## Context

Not every caller has a meaningful base version, and several callers depend on
the old clobber semantics:

- `checkout.ts` uses `pull()` as its engine for overwriting the working tree
  with the target branch (protecting untracked files via the gitignore trick in
  `VTClient.checkout`). A branch switch's natural base is the fork point, not
  `state.branch.version` — cross-branch three-way is explicitly out of scope
  (brainstorm §6.6).
- `vt pull --force` is documented as "old behavior, remote wins".
- Existing lib tests call `pull()`/`status()` without a base.
- A directory cloned by an older vt has a valid `branch.version`, so normal
  operation needs no migration — but robustness demands a defined behavior when
  no base is available.

## Decision

`baseVersion` is an **optional** parameter on `status()`, `pull()`, and
`push()`:

- **Present** → three-way classification (0003–0006). `VTClient.status()`,
  `VTClient.pull()`, and `VTClient.push()` always supply it from
  `state.branch.version`, so every user-facing command is three-way.
- **Absent** → the legacy two-way path, byte-for-byte the old semantics:
  `status()` classifies against the target version only (direction by mtime
  guess via `isFileModified`), `pull()` clobbers (clone + delete extraneous).
  Used by checkout, by `--force`, and by any external caller of the lib layer
  that hasn't opted in.

Degrading rather than throwing follows the brainstorm §6.7: if the base version
ever becomes unfetchable server-side, behavior falls back to today's, it doesn't
break.

## Known limitations carried forward (not regressions)

Recorded here so they're tracked; all pre-date this change:

1. **Non-atomic push** (brainstorm §6.1): push failures leave warnings but
   `branch.version` may still advance. This turns out to self-correct under the
   three-way classifier — the failed file re-classifies as locally modified and
   is retried — see 0009 for the analysis.
2. **Version-bump race after push** (§6.2): `getLatestVersion()` after push can
   swallow a concurrent writer's version into the recorded base. 0009 closes the
   systematic version of this hole (remote changes that existed _before_ the
   push are never folded into the base), but a write that lands in the window
   between push's status check and its version bump can still be swallowed.
   Closing it fully needs per-operation resulting versions from the API. (Pull
   no longer has this race — it records the version it actually pulled.)
3. **Remote renames** (§6.3): a remote rename is remote-delete + remote-create;
   combined with a local edit of the old path it surfaces as a modify/delete
   conflict rather than a rename. Same behavior as git without rename detection.
4. **mtime fragility** (§6.4): any future write path that skips `Deno.utime`
   degrades the fast path to content comparison — slower, still sound.

## Deferred work (phase 4 and beyond)

- `--ours` / `--theirs` whole-file resolution flags on pull.
- Persisted `conflicts: string[]` in `state.json` for a content-scan-free
  "unmerged paths" section in `vt status`.
- Three-way branch checkout using the fork point as base (§8.6).
- Only advancing the pushed version when zero warnings occurred (§6.1).
