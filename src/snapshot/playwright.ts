const MISSING_PLAYWRIGHT =
  "Playwright is required for snapshots but not installed.\n" +
  "Install it with:\n\n" +
  "  bun add -d playwright\n" +
  "  bunx playwright install chromium\n";

/** Load Playwright, or report how to install it. Returns null when absent. */
export async function loadPlaywright(): Promise<
  typeof import("playwright") | null
> {
  try {
    return await import("playwright");
  } catch {
    console.error(MISSING_PLAYWRIGHT);
    return null;
  }
}
