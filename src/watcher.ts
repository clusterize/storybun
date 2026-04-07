import { watch, readdirSync, statSync, type FSWatcher } from "fs";
import { join } from "path";

const ALWAYS_IGNORE = ["node_modules", ".git", "_storybun_entry"];

/**
 * On macOS, fs.watch recursive uses FSEvents (efficient, single fd).
 * On Linux, it uses inotify (one fd per directory), which causes EMFILE
 * in large repos. We manually walk and watch only non-ignored dirs.
 */
export function watchFiles(cwd: string, onChange: () => void, ignore: string[] = []) {
  const IGNORE = new Set([...ALWAYS_IGNORE, ...ignore]);
  let timeout: ReturnType<typeof setTimeout> | null = null;

  function debounced() {
    if (timeout) clearTimeout(timeout);
    timeout = setTimeout(onChange, 100);
  }

  if (process.platform === "darwin") {
    // macOS: single efficient recursive watcher via FSEvents
    return watch(cwd, { recursive: true }, (_event, filename) => {
      if (!filename) return;
      if (IGNORE.has(filename.split("/")[0])) return;
      debounced();
    });
  }

  // Linux: walk and watch each directory individually, skipping ignored dirs
  const watchers: FSWatcher[] = [];

  function walkAndWatch(dir: string) {
    const w = watch(dir, (_event, filename) => {
      if (!filename) return;
      debounced();
    });
    watchers.push(w);

    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }

    for (const name of entries) {
      if (IGNORE.has(name)) continue;
      const full = join(dir, name);
      try {
        if (statSync(full).isDirectory()) {
          walkAndWatch(full);
        }
      } catch {
        // Permission error or symlink loop — skip
      }
    }
  }

  walkAndWatch(cwd);

  // Return a composite that closes all sub-watchers
  return {
    close() {
      for (const w of watchers) w.close();
    },
  } as FSWatcher;
}
