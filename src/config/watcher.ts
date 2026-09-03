// =============================================================================
// Ouroboros Config Watcher — Hot reload via fs.watch
// Emits CONFIG_RELOAD events when project/user config files change.
// =============================================================================

import { watch, existsSync, type FSWatcher } from "node:fs";
import { getProjectConfigPath, getUserConfigPath } from "./loader.js";

type ReloadCallback = (source: "project" | "user", path: string) => void;

let watchers: FSWatcher[] = [];
let debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Start watching config files for changes.
 * Changes are debounced by 200ms to avoid duplicate events from editor saves.
 */
export function startConfigWatching(
  onReload: ReloadCallback,
  projectDir?: string,
): void {
  const paths: Array<{ path: string; source: "project" | "user" }> = [];

  const projectPath = getProjectConfigPath(projectDir);
  if (existsSync(projectPath)) {
    paths.push({ path: projectPath, source: "project" });
  }

  const userPath = getUserConfigPath();
  if (existsSync(userPath)) {
    paths.push({ path: userPath, source: "user" });
  }

  for (const { path, source } of paths) {
    try {
      const watcher = watch(path, (eventType) => {
        if (eventType === "change") {
          // Debounce: editors often write multiple times per save
          const existing = debounceTimers.get(path);
          if (existing) clearTimeout(existing);

          debounceTimers.set(
            path,
            setTimeout(() => {
              onReload(source, path);
              debounceTimers.delete(path);
            }, 200),
          );
        }
      });

      watcher.unref(); // Don't keep process alive just for watchers
      watchers.push(watcher);
    } catch (err) {
      // File may not exist or be watchable — that's fine
      process.stderr.write(
        `[Config] Cannot watch ${path}: ${err instanceof Error ? err.message : err}\n`,
      );
    }
  }
}

/**
 * Stop all config file watchers.
 */
export function stopConfigWatching(): void {
  for (const watcher of watchers) {
    try {
      watcher.close();
    } catch {
      // ignore
    }
  }
  watchers = [];

  for (const timer of debounceTimers.values()) {
    clearTimeout(timer);
  }
  debounceTimers.clear();
}
