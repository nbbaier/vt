# 0003 — Explicit conflict status + direction on every change

Status: accepted

## Context

The brainstorm (§5.2) offers two shapes for the status model:

- **Minimal:** widen `ModifiedItemStatus.where` to
  `"local" | "remote" | "both"`.
- **Explicit:** a dedicated `ConflictedItemStatus` with a `conflictKind` and the
  three content snapshots, plus a sixth map in `ItemStatusManager`.

It also leaves implicit a second representation problem: `created` and `deleted`
are ambiguous in exactly the way `modified` was. Today "created" means "exists
locally, not remotely" — which push interprets as "upload" and which pull used
to interpret as "delete locally". Once the base disambiguates _who_ created or
deleted a path, that direction has to live somewhere, or every consumer
re-derives it wrong.

## Decision

Both halves:

1. **`ConflictedItemStatus` is a first-class status**
   (`status:
   "conflicted"`), with:
   - `conflictKind: "edit/edit" | "delete/modify" | "modify/delete" |
     "create/create"`,
   - optional `baseContent` / `localContent` / `remoteContent` snapshots
     (whichever exist),
   - a sixth map in `ItemStatusManager`, enumerated by every method that
     enumerates categories.

   Rationale (same as the brainstorm's recommendation): `push.ts` iterates
   `.modified` and `.created` and uploads them. A conflict that lives in one of
   those buckets is one forgotten `where` check away from uploading a
   half-merged file. A separate bucket makes that mistake a type error / an
   empty list rather than silent data loss.

2. **`where: "local" | "remote"` moves down to the shared change types**:
   `ModifiedItemStatus` (as today, but never "both" — that's `conflicted` now),
   and _newly_ on `CreatedItemStatus` and `DeletedItemStatus`.
   - push acts on `where === "local"` items only,
   - pull acts on `where === "remote"` items only,
   - `renamed` stays a local-only concept (rename detection only runs on
     local-side created/deleted pairs).

3. **`ModifiedItemStatus` gains an optional `merged?: boolean`** flag, set by
   pull when a both-sides-edited file was auto-merged cleanly by diff3. It
   exists so pull's report can distinguish "took remote" from "merged your edit
   with theirs" — the file's _status_ is an ordinary modification from the
   caller's point of view.

## Alternatives rejected

- **`where: "both"` on modified.** Rejected per the push-safety argument above;
  also cannot represent delete/modify or create/create conflicts.
- **Keeping `created`/`deleted` directionless and letting pull/push infer
  direction from context.** That inference is precisely the two-way bug being
  fixed; encoding it once in the classifier and carrying it in the type is the
  point of the exercise.
- **A separate result type for pull instead of reusing `ItemStatusManager`.**
  Too much churn: display, tests, and VTClient all speak `ItemStatusManager`.

## Consequences

- Every construction site of created/deleted statuses must state a direction.
  Sites that are inherently two-way (clone writing remote files into a fresh
  dir, checkout's branch-switch deletions) use the direction that matches what
  the operation does to the working tree ("remote" for content arriving from the
  server, "local" for the push-perspective in legacy status mode).
- `ItemStatusManager.insert`'s created+deleted→modified transition keeps
  working; the merged item takes the direction of the incoming item.
- Display code grows a `conflicted` style (`!`, red) and per-direction
  annotations ("created remotely", "deleted locally", "auto-merged").
