/**
 * Pure three-way classification of a single path across the three states of
 * a sync:
 *
 * - **B** (base): the remote tree at the last-synced version recorded in
 *   `.vt/state.json`. Because clone/pull/push leave the local directory
 *   identical to the remote at that version, B is also a faithful record of
 *   what the local directory looked like right after the last sync.
 * - **L** (local): the working directory now.
 * - **R** (remote): the remote tree at the target version (usually latest).
 *
 * This module is deliberately synchronous and free of any file system or
 * API knowledge: callers gather the existence and equality facts (using
 * whatever fast paths they have available) and get back a classification.
 * See docs/design-log/0004-pure-classifier.md.
 */

/** The kinds of true conflicts a three-way comparison can surface. */
export type ConflictKind =
  | "edit/edit"
  | "delete/modify"
  | "modify/delete"
  | "create/create";

/** Which side of the sync a non-conflicting change happened on. */
export type ChangeSide = "local" | "remote";

/**
 * The facts about one path needed to classify it. Equality flags are only
 * consulted when the corresponding existence flags make them meaningful, so
 * callers may compute them lazily and pass `false` (or anything) for
 * combinations that cannot be reached.
 */
export interface ItemStateInput {
  /** Whether the path exists in the base tree. */
  inBase: boolean;
  /** Whether the path exists in the working directory. */
  inLocal: boolean;
  /** Whether the path exists in the remote tree at the target version. */
  inRemote: boolean;
  /** Whether the path is a directory (directories compare by existence only). */
  isDirectory: boolean;
  /** L = B. Consulted only when both exist. */
  localSameAsBase: boolean;
  /** R = B. Consulted only when both exist. */
  remoteSameAsBase: boolean;
  /** L = R. Consulted only when both exist. */
  localSameAsRemote: boolean;
}

/** The classification of one path. */
export type ItemStateClassification =
  | { kind: "not_modified" }
  | { kind: "created"; where: ChangeSide }
  | { kind: "deleted"; where: ChangeSide }
  | { kind: "modified"; where: ChangeSide }
  | { kind: "conflicted"; conflictKind: ConflictKind }
  /** The path exists in none of the trees that matter (e.g. deleted on both sides). */
  | { kind: "absent" };

/**
 * Classify a single path given its three-way existence and equality facts.
 *
 * Implements the truth table from docs/three-way-diffing.md §4.1. Each
 * two-way-ambiguous case ("exists remotely, missing locally" etc.) splits
 * into a safe case and a conflict case based on membership in the base.
 *
 * @param input The existence and equality facts for the path
 * @returns The classification of the path
 */
export function classifyItemState(
  input: ItemStateInput,
): ItemStateClassification {
  const { inBase, inLocal, inRemote, isDirectory } = input;

  // Directories carry no content: existence-only rules.
  if (isDirectory) {
    if (inLocal && inRemote) return { kind: "not_modified" };
    if (inLocal && !inRemote) {
      return inBase
        ? { kind: "deleted", where: "remote" }
        : { kind: "created", where: "local" };
    }
    if (!inLocal && inRemote) {
      return inBase
        ? { kind: "deleted", where: "local" }
        : { kind: "created", where: "remote" };
    }
    return { kind: "absent" };
  }

  if (inLocal && inRemote) {
    if (inBase) {
      const { localSameAsBase, remoteSameAsBase, localSameAsRemote } = input;
      if (localSameAsBase && remoteSameAsBase) return { kind: "not_modified" };
      if (!localSameAsBase && remoteSameAsBase) {
        return { kind: "modified", where: "local" };
      }
      if (localSameAsBase && !remoteSameAsBase) {
        return { kind: "modified", where: "remote" };
      }
      // Both sides changed: converged edits are clean, divergent ones conflict.
      return localSameAsRemote
        ? { kind: "not_modified" }
        : { kind: "conflicted", conflictKind: "edit/edit" };
    }
    // Created independently on both sides.
    return input.localSameAsRemote
      ? { kind: "not_modified" }
      : { kind: "conflicted", conflictKind: "create/create" };
  }

  if (inLocal && !inRemote) {
    if (!inBase) return { kind: "created", where: "local" };
    // Was synced before and the remote removed it. Deleting locally is only
    // safe if the local copy is untouched since the last sync.
    return input.localSameAsBase
      ? { kind: "deleted", where: "remote" }
      : { kind: "conflicted", conflictKind: "modify/delete" };
  }

  if (!inLocal && inRemote) {
    if (!inBase) return { kind: "created", where: "remote" };
    // Was synced before and the local side removed it. Propagating the
    // deletion is only safe if the remote copy is untouched since then.
    return input.remoteSameAsBase
      ? { kind: "deleted", where: "local" }
      : { kind: "conflicted", conflictKind: "delete/modify" };
  }

  // In base only (deleted on both sides), or nowhere at all.
  return { kind: "absent" };
}
