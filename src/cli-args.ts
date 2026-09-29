/** The argument following `flag`, unless it is missing or is itself a flag. */
export function flagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx !== -1 && args[idx + 1] && !args[idx + 1]!.startsWith("-")) {
    return args[idx + 1];
  }
  return undefined;
}

/**
 * A flag that may carry an optional path, as `--json` and `--html` do for
 * `snapshot`: absent -> undefined, bare -> true, followed by a non-flag
 * argument -> that argument.
 */
export function parseOptionalPathFlag(args: string[], flag: string): string | true | undefined {
  if (!args.includes(flag)) return undefined;
  return flagValue(args, flag) ?? true;
}
