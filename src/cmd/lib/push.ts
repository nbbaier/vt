import { Command } from "@cliffy/command";
import { doWithSpinner } from "~/cmd/utils.ts";
import VTClient from "~/vt/vt/VTClient.ts";
import { findVtRoot } from "~/vt/vt/utils.ts";
import sdk, { canWriteToVal } from "~/sdk.ts";
import { displayFileStateChanges } from "~/cmd/lib/utils/displayFileStatus.ts";
import { noChangesDryRunMsg } from "~/cmd/lib/utils/messages.ts";
import { reportGitAutoCommit } from "~/cmd/lib/utils/gitAutoCommit.ts";

const nothingNewToPushMsg =
  "No local changes to push, remote state is up to date";

export const pushCmd = new Command()
  .name("push")
  .description("Push local changes to a Val")
  .example("Push local changes", "vt push")
  .option(
    "-d, --dry-run",
    "Show what would be pushed without making any changes",
  )
  .option(
    "--git-commit",
    "Create a git commit after pushing, even if gitAutoCommit.enabled is false",
    { default: undefined },
  )
  .option(
    "--no-git-commit",
    "Do not create a git commit after pushing",
  )
  .option(
    "-m, --message <message:string>",
    "Message for the auto-commit (default: vt push <timestamp>)",
  )
  .action(
    async (
      { dryRun, gitCommit, message }: {
        dryRun?: boolean;
        gitCommit?: boolean;
        message?: string;
      },
    ) => {
      await doWithSpinner(
        dryRun
          ? "Checking for local changes that would be pushed..."
          : "Pushing local changes...",
        async (spinner) => {
          const vtRoot = await findVtRoot(Deno.cwd());
          const vt = VTClient.from(vtRoot);

          const vtState = await vt.getMeta().loadVtState();
          const valToPush = await sdk.vals.retrieve(vtState.val.id);
          if (!(await canWriteToVal(valToPush.id))) {
            throw new Error(
              "You do not have write access to this Val, you cannot push." +
                "\nTo make changes to this Val, go to the website, fork the Val, and clone the fork.",
            );
          }

          // Note that we must wait until we have retrieved the status before
          // stopping the spinner
          if (dryRun) {
            // Perform a dry push to get what would be pushed.
            const statusResult = await vt.push({ dryRun: true });
            spinner.stop();

            console.log(displayFileStateChanges(statusResult, {
              headerText: "Changes that would be pushed:",
              summaryText: "Would push:",
              emptyMessage: nothingNewToPushMsg,
              includeSummary: true,
            }));

            console.log();
            spinner.succeed(noChangesDryRunMsg);
          } else {
            // Perform the actual push, store the status, and then report it.
            const statusResult = await vt.push();
            spinner.stop();

            // Display the changes that were pushed
            console.log(displayFileStateChanges(statusResult, {
              headerText: "Pushed:",
              emptyMessage: nothingNewToPushMsg,
              includeSummary: true,
            }));

            console.log();
            if (statusResult.hasWarnings()) {
              spinner.warn("Failed to push everything");
              Deno.exit(1);
            } else {
              // Once the push has resolved, optionally create a git commit.
              // Enabled automatically inside a git repo; disable persistently
              // with `gitAutoCommit.enabled`, or per-run with --git-commit /
              // --no-git-commit.
              const config = await vt.getConfig().loadConfig();
              await reportGitAutoCommit(vtRoot, "push", gitCommit, {
                message,
                ignoreRules: await vt.getMeta().loadGitignoreRules(),
                configEnabled: config.gitAutoCommit?.enabled,
              });

              spinner.succeed("Successfully pushed local changes");
            }
          }
        },
      );
    },
  );
