import * as Effect from "effect/Effect";
import { Argument, Command } from "effect/cli";

/**
 * `t3 skills-cli <args…>` runs the bundled `skills` CLI as a child process, so
 * installs need no Node or npm of their own and its `process.exit` and prompts
 * stay out of the server.
 */
export async function runSkillsCli(args: ReadonlyArray<string>): Promise<void> {
  // The CLI calls `process.exit` right after printing `--json`; POSIX pipe writes are
  // asynchronous, so a large result would be cut at 64 KiB. Block until each write
  // finishes (Windows pipes already do).
  const stdout = process.stdout as typeof process.stdout & {
    readonly _handle?: { readonly setBlocking?: (blocking: boolean) => void };
  };
  stdout._handle?.setBlocking?.(true);
  // The CLI reads its command from argv[2] onward.
  process.argv = [process.argv[0] ?? "node", "skills", ...args];
  await import("skills/dist/cli.mjs");
}

/** Real invocations dispatch through the bin.ts fast path before the CLI graph loads. */
export const skillsCliCommand = Command.make("skills-cli", {
  args: Argument.String("args").pipe(Argument.variadic()),
}).pipe(
  Command.withDescription("Run the bundled skills installer."),
  Command.unlisted,
  Command.withHandler(({ args }) => Effect.promise(() => runSkillsCli(args))),
);
