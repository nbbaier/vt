import { Command } from "@cliffy/command";
import { confirmOrExit, doWithSpinner } from "~/cmd/utils.ts";
import VTClient from "~/vt/vt/VTClient.ts";
import { findVtRoot } from "~/vt/vt/utils.ts";
import { colors } from "@cliffy/ansi/colors";
import { displayFileStateChanges } from "~/cmd/lib/utils/displayFileStatus.ts";
import { noChangesDryRunMsg } from "~/cmd/lib/utils/messages.ts";

export const pullCmd = new Command()
  .name("pull")
  .description("Pull the latest changes for the current Val")
  .example("Pull the latest changes", "vt pull")
  .option(
    "-f, --force",
    "Take the remote version of every file, discarding local changes",
  )
  .option(
    "-d, --dry-run",
    "Show what would be pulled without making any changes",
  )
  .action(({ force, dryRun }: { force?: boolean; dryRun?: boolean }) => {
    doWithSpinner(
      dryRun
        ? "Checking for remote changes that would be pulled..."
        : "Pulling latest changes...",
      async (spinner) => {
        const vt = VTClient.from(await findVtRoot(Deno.cwd()));

        if (dryRun) {
          const fileStateChanges = await vt.pull({
            dryRun: true,
            remoteWins: force,
          });
          spinner.stop();
          console.log(displayFileStateChanges(fileStateChanges, {
            headerText: `Changes that ${colors.underline("would be pulled")}:`,
            summaryText: "Would pull:",
            emptyMessage: "No changes to pull, local state is up to date",
            includeTypes: false,
            includeSummary: true,
          }));
          console.log();
          spinner.succeed(noChangesDryRunMsg);
          return;
        }

        // Merging pulls preserve local work, so the only thing worth
        // confirming is writing conflict markers into local files. Forced
        // pulls take the remote state wholesale and skip the check.
        if (!force) {
          const dryChanges = await vt.pull({ dryRun: true });
          if (dryChanges.conflicted.length > 0) {
            spinner.stop();

            console.log(
              displayFileStateChanges(
                dryChanges.filter((f) => f.status === "conflicted"),
                {
                  headerText: `Files that ${colors.underline("conflict")}:`,
                  includeSummary: false,
                  includeTypes: false,
                },
              ) + "\n",
            );

            const shouldProceed = await confirmOrExit(
              {
                message:
                  "These files changed both locally and remotely and cannot be " +
                  "merged automatically. Pulling will write conflict markers " +
                  "into them for you to resolve. Proceed?",
                default: true,
              },
              "There are conflicting changes. Re-run with --force to take the remote version of every file.",
            );
            if (!shouldProceed) Deno.exit(0);
            spinner.start();
          }
        }

        const realPullChanges = await vt.pull({ remoteWins: force });
        spinner.stop();
        console.log(displayFileStateChanges(realPullChanges, {
          headerText: "Changes " + colors.underline("pulled:"),
          summaryText: "Pulled:",
          emptyMessage: "No changes were pulled, local state is up to date",
          includeTypes: true,
          includeSummary: true,
        }));
        console.log();

        const conflicts = realPullChanges.conflicted.length;
        if (conflicts > 0) {
          spinner.warn(
            `Pulled with ${conflicts} conflict${conflicts === 1 ? "" : "s"}. ` +
              "Resolve the marked files, then push.",
          );
          Deno.exit(1);
        } else {
          spinner.succeed("Successfully pulled the latest changes");
        }
      },
    );
  });
