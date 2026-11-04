// Gathers the images the published report needs into a staging directory, so
// that one `aws s3 sync` of that directory uploads exactly them, in parallel.
// Env: REPORT_PATH, SNAPSHOT_DIR, STAGE_DIR. Writes `images=<count>` to
// GITHUB_OUTPUT when set.
import { appendFile, copyFile, link, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { SnapshotReport } from "../src/snapshot/report-model.ts";
import { filesToPublish } from "../src/snapshot/publish.ts";

/**
 * Hard-links each file into `stageDir` (a copy when the two sit on different
 * filesystems). A listed file that is missing is skipped with a warning: the
 * page then shows one broken image instead of the whole publish failing.
 */
export async function stageImages(files: string[], snapshotDir: string, stageDir: string): Promise<number> {
  let staged = 0;
  for (const file of files) {
    const from = join(snapshotDir, file);
    const to = join(stageDir, file);
    await mkdir(dirname(to), { recursive: true });
    try {
      await link(from, to);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        console.log(`::warning::storybun: ${from} is listed in the report but missing; not published`);
        continue;
      }
      if (code !== "EXDEV" && code !== "EPERM") throw err;
      await copyFile(from, to);
    }
    staged++;
  }
  return staged;
}

if (import.meta.main) {
  const { REPORT_PATH, SNAPSHOT_DIR, STAGE_DIR } = process.env;
  if (!REPORT_PATH || !SNAPSHOT_DIR || !STAGE_DIR) throw new Error("REPORT_PATH, SNAPSHOT_DIR and STAGE_DIR must be set");

  const report = (await Bun.file(REPORT_PATH).json()) as SnapshotReport;
  await mkdir(STAGE_DIR, { recursive: true });
  const staged = await stageImages(filesToPublish(report), SNAPSHOT_DIR, STAGE_DIR);
  const scope = report.images === "review" ? "that need a look" : "in the report";
  console.log(`storybun: publishing ${staged} image(s) ${scope}`);
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `images=${staged}\n`);
}
