# 0005 — Pull merge semantics and conflict markers

Status: accepted

## Context

Today's pull is "clone wins": copy the working dir to a temp dir, clone remote
over it, delete anything not in the remote listing, copy back. That deletes
locally created files and overwrites local edits. The brainstorm (§5.5) replaces
the middle with per-file application of the three-way classification, keeping
the `doAtomically` temp-dir scaffolding.

## Decision

`pull()` (when given a `baseVersion`; without one see 0008) computes a three-way
`status()` and applies, per path, into the temp directory:

| Classification                            | Action                                                                                                                                |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| created/modified `where: "remote"`        | write remote content, set mtime to remote `updatedAt`                                                                                 |
| deleted `where: "remote"`                 | delete locally                                                                                                                        |
| created/modified/renamed `where: "local"` | keep the local file untouched                                                                                                         |
| deleted `where: "local"`                  | keep it deleted (do not resurrect)                                                                                                    |
| `not_modified` / absent everywhere        | nothing                                                                                                                               |
| conflicted `edit/edit` (text)             | diff3(L, B, R): clean → write merged content, report as modified `merged: true`; overlap → write git-style markers, report conflicted |
| conflicted `create/create` (text)         | same, with an empty base                                                                                                              |
| conflicted `modify/delete`                | keep the local file, report conflicted                                                                                                |
| conflicted `delete/modify`                | restore the remote version, report conflicted                                                                                         |
| conflicted, binary on either side         | never text-merge: keep the local bytes, report conflicted                                                                             |

Marker format (local side first, like git; the remote label carries the pulled
version so the user knows what they merged with):

```
<<<<<<< local
your version
=======
their version
>>>>>>> remote (version 45)
```

No `|||||||` base section — git's default style, and the base is recoverable
from version history if anyone needs it.

**mtimes carry the bookkeeping.** Files written from remote get their mtime set
to the remote `updatedAt`, so after the version advance they hit the fast path
as clean. Merged files and marker files are written with the current time, so
they classify as _locally modified against the new base_ — which is exactly
right: an auto-merge must be pushed, and a marker file is work in progress
(blocked from push by the marker warning, see 0006).

**The recorded version advances to the pulled version even when conflicts were
written.** The working tree now embeds the remote side (markers carry it), so
the pulled version is a legitimate merge parent — same reasoning as the
brainstorm §5.5. This is also what makes resolution converge: after editing the
markers away, the file is an ordinary local modification and push uploads it.
The advance uses the version that was actually pulled, not a second
`getLatestVersion()` call after the fact (which could silently swallow a
concurrent writer's version into the base).

**Deletions happen in both the temp dir and the target dir** (the copy-back is
overwrite-only, it cannot remove files) — same mechanism as the old pull.
Directory deletions are non-recursive and best-effort: if a remotely-deleted
directory still contains a locally kept file (e.g. a modify/delete conflict
inside it), the directory simply survives.

**CLI (`vt pull`):**

- The blanket "changes would overwrite local state, proceed?" prompt is gone for
  safe pulls — merge-mode pull no longer overwrites local work, so there is
  nothing to warn about.
- If the dry-run classification finds conflicts, pull shows them and asks for
  confirmation before writing markers into local files (declining exits with no
  changes). `--force` skips the prompt the way it always has — but `--force` now
  also means "remote wins everywhere" (the old clobber behavior, run without a
  base).
- The result report separates pulled / auto-merged / conflicted, and the process
  exits non-zero when conflicts were written so scripts can tell.

## Alternatives rejected

- **Abort the whole pull when any conflict exists** (the brainstorm's phase-2
  stopgap). Rejected with the phase split itself (0001): with markers available
  there's no reason to hold clean changes hostage to one conflicted file. Git
  doesn't.
- **Keep local content for conflicts and don't advance the version.** Sound (the
  conflict re-surfaces next pull) but it makes pull non-converging — repeated
  pulls report the same conflicts forever and the remote side is never brought
  local for resolution.
- **Auto-merged files reported as `conflicted` with a resolved flag.** An
  auto-merge is not a conflict; consumers (push) must treat it as an ordinary
  modification, so it is one (`merged: true` is display-only).

## Consequences

- `pull()` grows a `baseVersion?` parameter; `VTClient.pull()` supplies it from
  `state.branch.version` and passes the pre-computed target version down so
  state and content can't disagree.
- The old clobber implementation survives as the no-base path in `pull.ts` —
  used by `--force` and by checkout (0008) — rather than being deleted.
- `vt watch` pushes on a timer and never pulls, so watch users get the push-side
  protections (0006) but merge still only happens on `vt pull`.
