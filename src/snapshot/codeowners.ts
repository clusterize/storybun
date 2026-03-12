import { join } from "path";
import { mkdir } from "node:fs/promises";

const SECTION_START = "# storybun visual snapshots";
const SECTION_END = "# end storybun visual snapshots";

export async function updateCodeowners(
  cwd: string,
  snapshotDir: string,
  owners: string[],
): Promise<void> {
  if (owners.length === 0) {
    console.log("No codeowners configured in snapshot config. Skipping.");
    return;
  }

  const githubDir = join(cwd, ".github");
  const codeownersPath = join(githubDir, "CODEOWNERS");

  await mkdir(githubDir, { recursive: true });

  let content = "";
  const file = Bun.file(codeownersPath);
  if (await file.exists()) {
    content = await file.text();
  }

  const ownersList = owners.join(" ");
  const newSection = `${SECTION_START}\n${snapshotDir}/ ${ownersList}\n${SECTION_END}`;

  if (content.includes(SECTION_START)) {
    const regex = new RegExp(
      `${escapeRegExp(SECTION_START)}[\\s\\S]*?${escapeRegExp(SECTION_END)}`,
    );
    content = content.replace(regex, newSection);
  } else {
    if (content.length > 0 && !content.endsWith("\n")) {
      content += "\n";
    }
    content += `\n${newSection}\n`;
  }

  await Bun.write(codeownersPath, content);
  console.log(`Updated ${codeownersPath}`);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
