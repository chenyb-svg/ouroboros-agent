// =============================================================================
// Ouroboros Config Loader — 4-level resolution & merging
// Hierarchy (low to high): system → user → project → env
// =============================================================================

import { readFileSync, existsSync } from "node:fs";
import { dataPath } from "../data-home.js";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import type {
  OuroborosConfig,
  PartialOuroborosConfig,
  PermissionMode,
  ColorLevel,
} from "../types/config.js";
import { getDefaults } from "./defaults.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Load and merge config from all 4 levels.
 */
export function loadConfig(projectDir?: string): OuroborosConfig {
  const defaults = getDefaults();

  // Level 1: System config (lowest priority)
  const systemPath = process.platform === "win32"
    ? join(process.env["PROGRAMDATA"] ?? "C:\\ProgramData", "ouroboros", "config.yaml")
    : "/etc/ouroboros/config.yaml";
  const systemConfig = loadYamlFile(systemPath);

  // Level 2: User config
  const userPath = dataPath("config.yaml");
  const userConfig = loadYamlFile(userPath);

  // Level 3: Project config
  const projectPath = projectDir
    ? join(projectDir, ".ouroboros", "config.yaml")
    : join(process.cwd(), ".ouroboros", "config.yaml");
  const projectConfig = loadYamlFile(projectPath);

  // Level 4: Environment variables (highest priority)
  const envConfig = loadEnvConfig();

  // Merge: defaults ← system ← user ← project ← env
  let merged = deepMerge(defaults, systemConfig);
  merged = deepMerge(merged, userConfig);
  merged = deepMerge(merged, projectConfig);
  merged = deepMerge(merged, envConfig);

  return merged as OuroborosConfig;
}

/**
 * Load a single YAML config file. Returns empty object if file doesn't exist.
 */
function loadYamlFile(path: string): PartialOuroborosConfig {
  try {
    if (!existsSync(path)) return {};
    const raw = readFileSync(path, "utf-8");
    const parsed = yaml.load(raw);
    if (typeof parsed === "object" && parsed !== null) {
      return parsed as PartialOuroborosConfig;
    }
    return {};
  } catch (err) {
    // File not found or parse error — skip this level
    process.stderr.write(
      `[Config] Warning: failed to load ${path}: ${err instanceof Error ? err.message : err}\n`,
    );
    return {};
  }
}

/**
 * Extract config overrides from environment variables.
 */
function loadEnvConfig(): PartialOuroborosConfig {
  const config: PartialOuroborosConfig = {};

  const model = process.env["OUROBOROS_MODEL"];
  const provider = process.env["OUROBOROS_PROVIDER"];
  const maxTokens = process.env["OUROBOROS_MAX_TOKENS"];
  const contextWindow = process.env["OUROBOROS_CONTEXT_WINDOW"];
  const temperature = process.env["OUROBOROS_TEMPERATURE"];
  const apiEndpoint = process.env["OUROBOROS_API_ENDPOINT"];
  const apiKeyEnv = process.env["OUROBOROS_API_KEY_ENV"];
  const permissionMode = process.env["OUROBOROS_PERMISSION_MODE"];
  const theme = process.env["OUROBOROS_THEME"];
  const colorLevel = process.env["OUROBOROS_COLOR_LEVEL"];
  const animation = process.env["OUROBOROS_ANIMATION"];

  if (model || provider || maxTokens || contextWindow || temperature || apiEndpoint || apiKeyEnv) {
    config.model = {};
    if (model) config.model.model = model;
    if (provider) config.model.provider = provider;
    if (maxTokens) config.model.maxTokens = parseInt(maxTokens, 10);
    if (contextWindow) config.model.contextWindow = parseInt(contextWindow, 10);
    if (temperature) config.model.temperature = parseFloat(temperature);
    if (apiEndpoint) config.model.apiEndpoint = apiEndpoint;
    if (apiKeyEnv) config.model.apiKeyEnv = apiKeyEnv;
  }

  if (theme || colorLevel || animation) {
    config.terminal = {};
    if (theme === "dark" || theme === "light") config.terminal.theme = theme;
    if (colorLevel) {
      if (colorLevel === "16" || colorLevel === "256" || colorLevel === "truecolor") {
        config.terminal.colorLevel = colorLevel === "16" ? 16 : colorLevel === "256" ? 256 : "truecolor";
      }
    }
    if (animation === "0" || animation === "false") config.terminal.animation = false;
    if (animation === "1" || animation === "true") config.terminal.animation = true;
  }

  if (permissionMode) {
    if (["ask", "accept-edits", "bypass"].includes(permissionMode)) {
      config.permissions = { defaultMode: permissionMode as PermissionMode };
    }
  }

  return config;
}

/**
 * Deep merge two objects. `override` values take precedence over `base`.
 */
function deepMerge<T extends Record<string, unknown>>(
  base: T,
  override: Partial<T> | undefined,
): T {
  if (!override || Object.keys(override).length === 0) return base;

  const result = { ...base };

  for (const key of Object.keys(override) as Array<keyof T>) {
    const overrideVal = override[key];
    const baseVal = result[key];

    if (
      overrideVal !== undefined &&
      typeof overrideVal === "object" &&
      !Array.isArray(overrideVal) &&
      overrideVal !== null &&
      typeof baseVal === "object" &&
      !Array.isArray(baseVal) &&
      baseVal !== null
    ) {
      result[key] = deepMerge(
        baseVal as Record<string, unknown>,
        overrideVal as Record<string, unknown>,
      ) as T[keyof T];
    } else if (overrideVal !== undefined) {
      result[key] = overrideVal as T[keyof T];
    }
  }

  return result;
}

/**
 * Get the project config path (for file watching).
 */
export function getProjectConfigPath(projectDir?: string): string {
  return projectDir
    ? join(projectDir, ".ouroboros", "config.yaml")
    : join(process.cwd(), ".ouroboros", "config.yaml");
}

/**
 * Get the user config path (for file watching).
 */
export function getUserConfigPath(): string {
  return dataPath("config.yaml");
}
