# Three-Way Diffing and Merge-on-Pull

> Status: exploratory design — not yet implemented.

This document explores how `vt` could move from its current two-way diffing
model to a three-way model that recognizes when a file has changed both
locally *and* remotely, and that supports merge conflict resolution when
pulling from remote to local.

## 1. Motivation

Today `vt` cannot tell the difference between "you changed this file" and
"someone else changed this file and you also changed it." Concretely:

- `vt pull` silently overwrites local edits when the remote file has a newer
  mtime, after only a generic "changes would overwrite local state"
  confirmation.
- `vt push` can **delete a collaborator's newly created file from the
  server**, because a file that exists remotely but not locally is always
  classified as a local deletion (see §2.2).
- `vt pull` deletes locally created files that were never pushed, because a
  file that exists locally but not remotely at pull time is
  indistinguishable from a remotely deleted file.

The goal is a model where:

1. Every path is classified correctly as locally changed, remotely changed,
   both, or neither.
2. `vt pull` preserves local-only changes, applies remote-only changes,
   auto-merges non-overlapping concurrent edits, and surfaces true conflicts
   with git-style markers for manual resolution.

## 2. How diffing works today

### 2.1 Two-way comparison against latest

The sync core (`src/vt/lib/status.ts`, `pull.ts`, `push.ts`, `clone.ts`)
compares exactly two states: the local working directory and the remote val
at a single version — always the *latest* (`VTClient.status()` and `pull()`
call `getLatestVersion()` first). The heart of it is `isFileModified()` in
`src/vt/lib/utils/misc.ts`:

```ts
if (localMtime === remoteMtime) return [false, "local"];
return [
  localContent !== remoteContent,
  localMtime > remoteMtime ? "local" : "remote",
];
```

Two structural limitations fall out of this:

**Direction is a guess.** When local and remote content differ, the
`where: "local" | "remote"` attribution on `ModifiedItemStatus` is decided
purely by which mtime is newer. If you edited a file locally at 2pm and
someone pushed a remote change at 3pm, the file is classified
`where: "remote"` and `vt pull` will overwrite your edit. The type system
cannot even represent "both sides changed" — `where` is a two-value union.

**Existence changes are ambiguous.** With only two snapshots, "exists
remotely, missing locally" could be either a local deletion or a remote
creation; "exists locally, missing remotely" could be either a local
creation or a remote deletion. Today `status.ts` always picks the local
interpretation (`deleted` / `created` respectively).

### 2.2 Concrete failure modes in the current code

- `status.ts` (the "files in Val but not local" loop): a remotely created
  file lands in the `deleted` bucket. `push.ts` then iterates
  `itemStateChanges.deleted` and calls `sdk.vals.files.delete` for each — so
  running `vt push` before pulling deletes the collaborator's new file.
- `pull.ts`: after cloning remote content over a temp copy of the working
  tree, any path not in the remote listing is deleted (unless gitignored).
  Locally created, never-pushed files are removed. (The docstring claims
  untracked files are preserved; the lib layer does not uphold this.)
- `cmd/lib/pull.ts`: the safety mechanism is a dry-run plus an
  all-or-nothing confirm/`--force`. There is no per-file preservation or
  merging.

## 3. Key insight: the merge base already exists

Three-way diffing needs a **base snapshot** — the common ancestor both sides
diverged from. `vt` already has everything required to reconstruct it,
without adding new local storage:

1. **`.vt/state.json` records the last-synced version.** `VTStateSchema`
   stores `branch.version`, and `VTClient.push()` / `pull()` both update it
   to the latest remote version after every successful sync.

2. **The invariant.** After every successful sync, the local directory
   *matches* the remote at the recorded version — that is what clone/pull
   guarantee (and push, in the other direction). So the remote tree at
   `state.branch.version` is not merely "some old remote state"; it is a
   faithful record of **what the local directory looked like immediately
   after the last sync**. We never stored a local snapshot, but the server's
   version history *is* the local snapshot, because local and remote were
   identical at that version.

3. **The API is version-addressable.** `listValItems(valId, branchId,
   version)` and `getValItemContent(valId, branchId, version, path)` both
   accept an arbitrary version and are already memoized in `src/sdk.ts`. The
   base tree is one extra (memoized) listing call; base file content is
   fetchable lazily, per path, only when needed.

4. **A cheap "locally dirty" test already exists.** `clone.ts` sets each
   written file's mtime to the remote `updatedAt`
   (`Deno.utime(path, updatedAt, updatedAt)`), and the pull/checkout paths
   copy with `preserveTimestamps: true`. So `localMtime ===
   baseFile.updatedAt` means the local file is untouched since the last sync
   — no content fetch required. (Today's code compares local mtime against
   the *latest* version's `updatedAt`, which is where the guessing comes
   from; comparing against the *base* version's `updatedAt` is the correct
   pivot.)

No shadow copies, no hash database, no schema migration is strictly
required.

## 4. The three-way classification

For each path, consider three states:

- **B** — base: remote at `state.branch.version`
- **L** — local: the working directory
- **R** — remote: remote at the target version (usually latest)

### 4.1 Classification table

| In B | In L | In R | Content relation      | Classification |
|------|------|------|-----------------------|----------------|
| ✓    | ✓    | ✓    | L=B, R=B              | `not_modified` |
| ✓    | ✓    | ✓    | L≠B, R=B              | modified locally (push candidate; pull keeps it) |
| ✓    | ✓    | ✓    | L=B, R≠B              | modified remotely (pull takes remote, safe) |
| ✓    | ✓    | ✓    | L≠B, R≠B, L=R         | `not_modified` (both converged to same content) |
| ✓    | ✓    | ✓    | L≠B, R≠B, L≠R         | **edit/edit — merge or conflict** |
| ✗    | ✓    | ✗    | —                     | created locally (pull preserves; push uploads) |
| ✗    | ✗    | ✓    | —                     | created remotely (pull creates it) |
| ✗    | ✓    | ✓    | L=R                   | create/create, converged → `not_modified` |
| ✗    | ✓    | ✓    | L≠R                   | **create/create conflict** |
| ✓    | ✗    | ✓    | R=B                   | deleted locally (push deletes; pull keeps deletion) |
| ✓    | ✗    | ✓    | R≠B                   | **delete/modify conflict** |
| ✓    | ✓    | ✗    | L=B                   | deleted remotely (pull deletes, safe) |
| ✓    | ✓    | ✗    | L≠B                   | **modify/delete conflict** |
| ✓    | ✗    | ✗    | —                     | deleted on both sides → nothing to do |

Each ambiguous case in today's model splits into a safe case and a conflict
case once B is available.

### 4.2 Worked example: local delete vs. remote create

Both scenarios present identically to a two-way diff — **path absent
locally, present remotely** — and differ only at the earlier point in time,
which is exactly what the base records.

**Scenario A — the user deleted the file locally:**

|                   | at last sync (v41)     | now                    |
|-------------------|------------------------|------------------------|
| base (remote @41) | `utils.ts` **exists**  | —                      |
| local             | `utils.ts` exists      | **gone** (user delete) |
| remote (latest)   | `utils.ts` exists      | still exists           |

The file is **in B**. Since local matched B right after the sync, the file
*was on disk* and now isn't — the only explanation is a local deletion.
Push propagates the deletion; pull keeps it deleted (does not resurrect it).

One refinement: compare R to B. If R = B (remote untouched), it is a clean
local delete. If R ≠ B, the user deleted a file a collaborator has since
edited — a **delete/modify conflict**. Following git's convention, pull
keeps the modified remote version in the working tree and marks the path
unmerged.

**Scenario B — a collaborator created the file remotely:**

|                   | at last sync (v41)  | now                    |
|-------------------|---------------------|------------------------|
| base (remote @41) | **does not exist**  | —                      |
| local             | does not exist      | still does not exist   |
| remote (v45)      | does not exist      | **exists** (their add) |

The file is **not in B**. The local directory never contained it — there was
nothing to delete. The only explanation is a remote creation. Pull writes it
locally; nothing local is at risk, so no conflict variant exists in this
shape. (The related conflict is create/create: both sides created the same
path with different content.)

The decision rule is a single membership test:

```
absent in L, present in R:
  path in B?      → local delete   (then R vs B decides clean vs conflict)
  path not in B?  → remote create  (always safe to pull)
```

The mirror image (**present in L, absent in R**) splits on the same test:
in B means remotely deleted (pull removes it — unless L ≠ B, which is a
modify/delete conflict); not in B means locally created (pull preserves it,
push uploads it). That row is what fixes pull deleting brand-new local
files.

## 5. Design

### 5.1 Classifier

Replace `isFileModified(local, remote)` with a pure function over the three
states, e.g.:

```ts
computeThreeWayStatus({ base, local, remote }): ItemStatus
```

Content comparisons should use the mtime fast path where valid (local mtime
equals base `updatedAt` ⇒ L = B without fetching content) and fall back to
content equality otherwise. Base content fetches stay lazy: they are only
needed for paths where L changed *and* R's `updatedAt` differs from B's.

Designing this as a pure function over (B, L, R) trees also lets branch
checkout reuse it later (§8.6).

### 5.2 Status model (`ItemStatusManager`)

Two options:

- **Minimal:** widen `ModifiedItemStatus.where` to
  `"local" | "remote" | "both"`. Display code touches `where` in only two
  places (`displayFileStatus.ts`, `cmd/lib/checkout.ts`), so blast radius is
  small.
- **Explicit (recommended):** add a `ConflictedItemStatus`:

  ```ts
  type ConflictedItemStatus = BaseItemStatus & {
    status: "conflicted";
    conflictKind: "edit/edit" | "delete/modify" | "modify/delete" | "create/create";
    baseContent?: string;
    localContent?: string;
    remoteContent?: string;
  };
  ```

  plus a sixth map in `ItemStatusManager`. More code (the class enumerates
  categories in ~8 methods), but it makes conflicts impossible to
  accidentally treat as ordinary modifications — important since `push.ts`
  iterates `.modified` and would happily upload a half-merged file.

A `merged` outcome flag (auto-merge succeeded) is also worth tracking so
pull output can distinguish "merged cleanly" from "took remote".

### 5.3 Status computation (`status.ts`)

`status()` grows a `baseVersion` param (from `vtState.branch.version`)
alongside the existing `version` (target). It fetches two listings —
`listValItems(..., baseVersion)` and `listValItems(..., version)` — both
memoized, so one extra API call total per status run.

### 5.4 Merging

For `edit/edit` conflicts on text files, run a **line-based diff3 merge**
(B→L diff, B→R diff, compose):

- Non-overlapping hunks → auto-merge, write merged content, report as
  `merged`. Pull proceeds.
- Overlapping hunks → write git-style conflict markers and report as
  `conflicted`:

  ```
  <<<<<<< local
  your version
  =======
  their version
  >>>>>>> remote (version 45)
  ```

Nothing in `deno.json` currently provides diff3. Options: `npm:diff3` /
`npm:node-diff3` (small, battle-tested), or vendor a ~150-line
implementation (the repo already vendors comparable logic — the
levenshtein-based rename detection in
`ItemStatusManager.consolidateRenames`).

**Gating unresolved conflicts on push comes nearly for free.** `push.ts`
already filters out any item with warnings before uploading
(`getItemWarnings`). Add a `conflict` member to `ItemWarning` that fires
when file content contains conflict markers (`getItemWarnings` already
reads file content to check for null bytes, so the check is cheap). Then
`vt push` and `vt watch` automatically refuse to upload unmerged files, and
the resolution flow is exactly git's: pull → markers written → user edits →
push.

Files with the existing `binary` warning must never be text-merged — fall
back to a whole-file choice (conflict, resolvable with `--ours`/`--theirs`).

### 5.5 Pull rewrite (`pull.ts`)

Today: copy working dir to temp → `clone()` overwrites everything with
remote → delete anything not in the remote listing → copy back. The
`doAtomically` temp-dir scaffolding is good and stays; the middle changes
from "clone wins" to per-file application of the classification:

| Classification              | Pull action |
|-----------------------------|-------------|
| remote-only change / create | write remote content, set mtime to remote `updatedAt` |
| local-only change / create  | keep local file untouched |
| edit/edit                   | diff3 merge; markers on overlap |
| remotely deleted, L = B     | delete locally |
| remotely deleted, L ≠ B     | keep local file, mark modify/delete conflict |
| locally deleted, R = B      | keep deleted |
| locally deleted, R ≠ B      | restore remote version, mark delete/modify conflict |
| absent in B and R           | **preserve** (fixes deletion of locally created files) |

After pull, advancing `vtState.branch.version` is still correct even when
conflicts remain (the working tree now incorporates remote-at-latest as one
merge parent). Because conflict markers are detectable from content, a
re-run of `status` re-detects marker-bearing files via the `conflict`
warning — the design stays stateless. Optionally, persist a
`conflicts: string[]` list in `state.json` for better UX (`vt status`
showing an "unmerged paths" section without content scans).

### 5.6 CLI UX (`cmd/lib/pull.ts`)

- Replace the blanket "would overwrite local state, proceed?" prompt with a
  differentiated report: *N pulled cleanly, M auto-merged, K conflicts*.
- Flags: `--ours` / `--theirs` for whole-file resolution; keep `--force` as
  "old behavior, remote wins everywhere".
- `vt status` surfaces conflicted paths distinctly (an "unmerged" section in
  `displayFileStateChanges`).
- Nonzero exit code (or at least a prominent summary line) when conflicts
  were written, so scripts can detect them.

## 6. Edge cases and caveats

1. **Base drift from partial pushes.** `push()` is explicitly non-atomic;
   items that fail get a warning, but `VTClient.push()` still bumps
   `branch.version` to latest. The recorded base can then claim a version
   local content never fully matched. The classifier degrades gracefully
   (the file shows as locally modified against base, i.e. a retry-push),
   but the version should only be advanced when zero warnings occurred — or
   per-file failures should be recorded.

2. **Race on the version bump.** `getLatestVersion()` is called *after*
   push completes; a concurrent writer's version can be swallowed into the
   recorded base, making their change invisible to the next pull. If the
   push API responses report the resulting version per operation, recording
   `max(returned versions)` instead of `getLatestVersion()` closes the
   hole.

3. **Renames.** `consolidateRenames()` detects local renames only. A remote
   rename appears as remote-delete + remote-create; combined with a local
   edit to the old path this yields a spurious modify/delete conflict.
   Reasonable to punt (git without rename detection behaves comparably),
   but the conflict message can hint ("file was renamed remotely to X").

4. **mtime fragility.** The fast path assumes clone/pull set mtimes to
   remote `updatedAt` and nothing else disturbs them. This holds today
   (`preserveTimestamps: true` in the pull/checkout copy paths), but any
   future code path that writes files without `Deno.utime` silently
   degrades the fast path. Falling back to content comparison against base
   whenever mtimes mismatch keeps the classifier sound, just slower.

5. **Directories** carry no content; existence-only three-way rules apply.
   Empty-directory deletion is already handled specially in pull.

6. **Checkout is the same problem in disguise.** `checkout.ts` currently
   uses the "add locally-created files to gitignore" trick and otherwise
   clobbers. A fork's `forkedFrom` version is a natural merge base, so the
   same classifier could later give branch switching git-like "carry your
   dirty changes across checkout" semantics. Out of scope for the first
   iteration, but a reason to keep the classifier pure.

7. **First sync / missing base.** A directory cloned by an older vt version
   has a valid `branch.version`, so no migration is needed. If the version
   is ever unavailable (e.g. history pruning server-side, should it ever
   exist), degrade to today's two-way behavior with a warning.

## 7. Implementation order

1. **Classifier + types.** Pure `computeThreeWayStatus(base, local,
   remote)` replacing `isFileModified`; add `conflicted` status (or
   `where: "both"`); thread `baseVersion` through `status()`. This alone
   fixes wrong `where` attributions and both existence ambiguities — the
   push-deletes-remote-creation bug dies here, before any merging exists.
2. **Pull preservation semantics.** Pull keeps local-only changes and
   locally created files; clean remote changes are applied; conflicts abort
   with a report (no markers yet). Already a big safety win.
3. **diff3 auto-merge + conflict markers**, plus the `conflict` item
   warning so push/watch refuse unmerged files.
4. **UX polish.** `--ours`/`--theirs`, unmerged section in `vt status`,
   optional conflict list in `state.json`.

## 8. Open questions

- Does the file listing at an old version return `updatedAt` values as of
  that version (assumed here), and is version history retention unbounded?
- Should auto-merged files be pushed automatically on the next push, or
  should `vt pull` require an explicit acknowledgment of merged content?
- Is `where: "both"` (minimal) or `ConflictedItemStatus` (explicit) the
  right shape? This doc recommends the explicit variant for push safety.
- Vendored diff3 vs. npm dependency.
