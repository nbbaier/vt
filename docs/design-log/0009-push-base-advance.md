# 0009 — Push must not advance the base past unincorporated remote changes

Status: accepted (found during implementation; supersedes part of what 0006 said
about keeping the post-push version bump as-is)

## Context

`VTClient.push()` has always bumped `branch.version` to `getLatestVersion()`
after a push. Under the two-way model that was merely racy (brainstorm §6.2).
Under the three-way model it becomes actively wrong in a common case:

1. Base is v41. A collaborator edits `x.ts` → v42. You edit `y.ts`.
2. You push. Three-way status correctly classifies `x.ts` as modified remotely
   and _skips_ it (0006); `y.ts` is uploaded → v43.
3. The old code then records v43 as the base. But your local `x.ts` still has
   the v41 content, while the base now claims the v42 content.
4. Next status: local `x.ts` differs from base, remote equals base — so `x.ts`
   classifies as **modified locally**, and the next push uploads your stale
   copy, reverting the collaborator's edit. The remote change was never pulled
   and is now invisible.

The recorded version is only a valid merge base if the local directory has fully
incorporated that version. A push that skipped remote-side changes has, by
definition, not incorporated them.

## Decision

After a real (non-dry) push, advance `branch.version` to latest **only when the
push's status found nothing remote-side**: no `conflicted` items and no
created/deleted/modified items with `where: "remote"`. Otherwise keep the old
base until a pull incorporates the remote changes.

This is safe and converging in both directions because of the classifier's
converged-content rule (L ≠ B but L = R → `not_modified`):

- Files you pushed read as clean against the _old_ base too — their local and
  remote contents now agree — so holding the base back does not make pushed
  files reappear as pending changes.
- The skipped remote change keeps classifying as modified-remote, so the next
  `vt pull` picks it up, and the pull then advances the base.

Push _failures_ (items with warnings) do **not** hold the base back: a failed
upload leaves the file locally different from remote-at-latest, so even with an
advanced base it correctly re-classifies as modified locally and is retried on
the next push. This refines the brainstorm's §6.1 suggestion ("only advance when
zero warnings occurred") — the warning case turns out to self-correct; only the
remote-side case doesn't.

The cost of holding back: while the base is stale, a local delete of a file you
just pushed classifies as a delete/modify conflict rather than a clean local
delete (remote no longer equals the old base for that path). Conservative,
resolvable, and only lasts until the next pull.

Also fixed here: both `VTClient.pull()` and `VTClient.push()` gated the version
bump on `options.dryRun === false` — an _explicitly passed_ false — so plain
`vt pull` / `vt watch` (which omit the option) never advanced the recorded
version at all. Harmless when the version was informational; load-bearing now.
The gate is now "not a dry run".

## Alternatives rejected

- **Advance to `initialVersion` (the version push classified against).** Same
  flaw: that version may already contain the skipped remote change.
- **Record a per-file base.** Precise, but new persistent state and schema —
  against the stateless design (0002); the hold-back achieves the same safety
  with a one-pull lag.
