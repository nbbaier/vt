# 0001 — Scope: implement phases 1–3 together

Status: accepted

## Context

The brainstorm (§7) proposes four implementation phases:

1. Three-way classifier + types (fixes wrong `where` attribution and the
   push-deletes-remote-creation bug).
2. Pull preservation semantics (pull keeps local-only changes; conflicts abort
   with a report, no markers yet).
3. diff3 auto-merge + conflict markers + a `conflict` item warning that makes
   push/watch refuse unmerged files.
4. UX polish (`--ours`/`--theirs`, an unmerged section in `vt status`, optional
   conflict list in `state.json`).

The obvious "initial design" cut is phases 1–2. But working through the
resolution flow shows that stopping at phase 2 leaves the model without any way
to _finish_ a conflict:

- If pull aborts on conflict and push also refuses conflicted files, the user is
  deadlocked — the only escape is `pull --force`, which throws away their local
  work.
- If push instead uploads the local side of a conflicted file, we've recreated
  today's silent-data-loss-on-push, just with a warning attached.

Conflict markers are what close the loop: pull writes both sides into the file,
the recorded base version advances (the working tree now incorporates the remote
side as a merge parent), the user edits the file, and push — which refuses files
still containing markers — uploads the resolution. That is exactly git's flow
and requires no new persistent state.

## Decision

Implement phases 1–3 as one coherent initial implementation:

- the pure three-way classifier and the new status types,
- the per-file pull rewrite,
- diff3 auto-merge, git-style conflict markers, and the `conflict` item warning
  that gates push.

Defer phase 4 almost entirely: no `--ours`/`--theirs` flags, no persisted
conflict list in `state.json`. The only phase-4 items taken now are the minimal
display changes required so `vt status` / `vt pull` output doesn't lie: a
`conflicted` section and an "auto-merged" annotation.

## Alternatives rejected

- **Phases 1–2 only.** Rejected for the deadlock/data-loss reasons above; a
  merge model without a resolution path is not a usable initial design.
- **Everything including phase 4.** `--ours`/`--theirs` and persisted conflict
  state are additive and separable; deferring them keeps the change reviewable.

## Consequences

- The initial PR is larger than a phase-1-only cut, but every piece of it is
  needed for the model to be self-consistent.
- Whole-file resolution of binary conflicts is manual for now (edit or delete
  the file); `--ours`/`--theirs` come later (see 0008).
