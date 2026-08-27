# 0006 — Push only local-side changes; markers gate push

Status: accepted (last consequence bullet superseded by 0009)

## Context

Two push behaviors follow from the two-way model and both destroy collaborator
work:

- A file created remotely since the last sync is classified `deleted` (exists
  remotely, missing locally), and `push.ts` iterates `.deleted` calling
  `sdk.vals.files.delete` — push deletes the collaborator's new file.
- A file modified only remotely is classified `modified` (direction was a
  guess), and push uploads the stale local content — push reverts the
  collaborator's edit.

Separately, once pull can write conflict markers (0005), nothing should be able
to upload a file that still contains them.

## Decision

- `push()` gains a `baseVersion?` parameter (supplied by `VTClient.push()` from
  `state.branch.version`) and runs three-way status.
- Push acts **only on local-side changes**: `created`/`modified`/`deleted` with
  `where: "local"`, plus `renamed` (a local-only status). Remote-side items and
  `conflicted` items are never uploaded or deleted — with a base, the
  remote-created file lands in `created where: "remote"` and push leaves it
  alone. Conflicted paths surface in the push report so the user knows why they
  weren't pushed.
- A new `ItemWarning` member, `"conflict"`, fires when a file's content contains
  git-style conflict markers (a `<<<<<<<` line, a `=======` line, and a
  `>>>>>>>` line, in order). `getItemWarnings` already reads file content (for
  the null-byte/binary check), so the check is free. Since `push.ts` already
  refuses to upload any item with warnings, push and `vt watch` automatically
  refuse marker-bearing files — resolution is git's flow: pull → markers → edit
  → push.

## Alternatives rejected

- **A dedicated "unmerged paths" list in `state.json`** to gate push.
  Content-based detection keeps the design stateless (a re-run of status
  re-detects markers); persisted conflict state is deferred UX (0001).
- **Pushing the local side of conflicts with a confirmation prompt.** Recreates
  last-write-wins with extra steps; the marker flow gives a real resolution path
  instead.

## Consequences

- The marker heuristic can false-positive on a file that legitimately contains
  conflict-marker syntax (e.g. documentation about merges). The failure mode is
  a refused push with a clear message, and the existing warning mechanism
  already tolerates this class of problem (`too_large`, `binary` behave the same
  way). Acceptable.
- The false-_negative_ direction (user deletes only some markers) is also
  handled: any remaining full marker triple still trips the warning.
- After a push, `branch.version` is still bumped via `getLatestVersion()`, which
  retains the pre-existing race documented in the brainstorm §6.2 — recorded in
  0008 rather than fixed here, because closing it needs per-operation version
  info from the API.
