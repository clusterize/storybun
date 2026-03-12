import { watch } from "fs";

const IGNORE = ["node_modules", ".git", "_storybun_entry"];

export function watchFiles(cwd: string, onChange: () => void) {
  let timeout: ReturnType<typeof setTimeout> | null = null;

  const watcher = watch(cwd, { recursive: true }, (_event, filename) => {
    if (!filename) return;
    if (IGNORE.some((ig) => filename.includes(ig))) return;

    // Debounce: coalesce rapid changes
    if (timeout) clearTimeout(timeout);
    timeout = setTimeout(onChange, 100);
  });

  return watcher;
}
