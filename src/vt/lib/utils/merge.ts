import { diff3Merge } from "node-diff3";

/** The label used for the local side of conflict markers. */
export const LOCAL_CONFLICT_LABEL = "local";

/** Result of a three-way text merge. */
export interface MergeTextResult {
  /** True if the merge completed without overlapping hunks. */
  clean: boolean;
  /**
   * The merged content. When `clean` is false this contains git-style
   * conflict markers around each overlapping region.
   */
  content: string;
}

/**
 * Performs a line-based three-way (diff3) merge of a file that changed both
 * locally and remotely since the common base.
 *
 * Non-overlapping hunks are combined automatically. Overlapping hunks are
 * emitted as git-style conflict markers with the local side first:
 *
 * ```
 * <<<<<<< local
 * your version
 * =======
 * their version
 * >>>>>>> remote (version 45)
 * ```
 *
 * @param options.base The common ancestor content
 * @param options.local The local content
 * @param options.remote The remote content
 * @param options.remoteLabel Label for the remote side of conflict markers
 * @returns Whether the merge was clean, plus the merged content
 */
export function mergeText({
  base,
  local,
  remote,
  remoteLabel = "remote",
}: {
  base: string;
  local: string;
  remote: string;
  remoteLabel?: string;
}): MergeTextResult {
  const regions = diff3Merge(
    splitLines(local),
    splitLines(base),
    splitLines(remote),
    { excludeFalseConflicts: true },
  );

  const outputLines: string[] = [];
  let clean = true;

  for (const region of regions) {
    if (region.ok) {
      outputLines.push(...region.ok);
    } else if (region.conflict) {
      clean = false;
      outputLines.push(`<<<<<<< ${LOCAL_CONFLICT_LABEL}`);
      outputLines.push(...region.conflict.a);
      outputLines.push("=======");
      outputLines.push(...region.conflict.b);
      outputLines.push(`>>>>>>> ${remoteLabel}`);
    }
  }

  // Preserve a trailing newline if either changed side ends with one
  const trailingNewline = local.endsWith("\n") || remote.endsWith("\n");
  const content = outputLines.join("\n") +
    (trailingNewline && outputLines.length > 0 ? "\n" : "");

  return { clean, content };
}

/**
 * Detects whether content contains a full git-style conflict marker triple
 * (a `<<<<<<< ` line, then a `=======` line, then a `>>>>>>> ` line, in
 * order). Used to refuse pushing files whose conflicts are unresolved.
 *
 * @param content The file content to scan
 * @returns True if a complete conflict marker sequence is present
 */
export function containsConflictMarkers(content: string): boolean {
  const lines = content.split(/\r?\n/);
  let state: "start" | "sep" | "end" = "start";
  for (const line of lines) {
    if (state === "start" && line.startsWith("<<<<<<< ")) state = "sep";
    else if (state === "sep" && line === "=======") state = "end";
    else if (state === "end" && line.startsWith(">>>>>>> ")) return true;
  }
  return false;
}

/**
 * Splits content into lines without producing a phantom empty final line
 * for content that ends with a newline.
 */
function splitLines(content: string): string[] {
  if (content.length === 0) return [];
  const lines = content.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}
