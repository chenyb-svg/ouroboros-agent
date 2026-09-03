// =============================================================================
// Bash Sandbox — Command classification + execution isolation (Phase 5)
// =============================================================================

import { execSync } from "node:child_process";
import { buildShellEnv, cmdExe } from "../tools/shell-harness.js";

export type CommandClass = "safe" | "caution" | "dangerous";

export interface SandboxResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  classification: CommandClass;
  blocked: boolean;
  blockReason?: string;
}

const DANGEROUS_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /rm\s+(-[rRf]+\s+)*\//, reason: "Recursive delete on root" },
  { pattern: /sudo\s+/, reason: "Privilege escalation" },
  { pattern: /chmod\s+777/, reason: "World-writable permissions" },
  { pattern: /curl\s+.*\|\s*(ba)?sh/, reason: "Pipe from network to shell" },
  { pattern: />\s*\/etc\//, reason: "Writing to system config" },
  { pattern: /mkfs\./, reason: "Filesystem format" },
  { pattern: /dd\s+if=/, reason: "Raw device access" },
  { pattern: />\s*~\/\.ssh\//, reason: "Writing to SSH config" },
  { pattern: />\s*~\/\.bashrc/, reason: "Writing to shell config" },
  { pattern: /git\s+push\s+--force/, reason: "Force push" },
  { pattern: /git\s+reset\s+--hard/, reason: "Hard reset" },
];

const CAUTION_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /npm\s+(publish|unpublish)/, reason: "Package registry modification" },
  { pattern: /docker\s+(rm|prune)/, reason: "Container/image deletion" },
  { pattern: /rm\s+-[rR]f/, reason: "Recursive delete" },
  { pattern: />\s*\S+:/.test("> /dev/") ? /^$/ : />/, reason: "File write redirection" },
];

export class BashSandbox {
  private workspaceRoot: string;
  private extraPatterns: Array<{ pattern: RegExp; reason: string }>;

  constructor(workspaceRoot: string, extraDangerousPatterns?: Array<{ pattern: RegExp; reason: string }>) {
    this.workspaceRoot = workspaceRoot;
    this.extraPatterns = extraDangerousPatterns ?? [];
  }

  /** Number of dangerous rules in effect (for /sandbox display). */
  dangerousRuleCount(): number {
    return DANGEROUS_PATTERNS.length + this.extraPatterns.length;
  }

  /** Classify a command as safe, caution, or dangerous */
  classifyCommand(command: string): { class: CommandClass; reason?: string } {
    for (const { pattern, reason } of DANGEROUS_PATTERNS) {
      if (pattern.test(command)) {
        return { class: "dangerous", reason };
      }
    }

    for (const { pattern, reason } of this.extraPatterns) {
      if (pattern.test(command)) {
        return { class: "dangerous", reason };
      }
    }

    for (const { pattern, reason } of CAUTION_PATTERNS) {
      if (pattern.test(command)) {
        return { class: "caution", reason };
      }
    }

    return { class: "safe" };
  }

  /** Execute a command in sandboxed environment */
  execute(
    command: string,
    options?: { timeoutMs?: number; maxBuffer?: number },
  ): SandboxResult {
    const classification = this.classifyCommand(command);

    if (classification.class === "dangerous") {
      return {
        success: false,
        stdout: "",
        stderr: `Command blocked by sandbox: ${classification.reason}`,
        exitCode: 1,
        classification: classification.class,
        blocked: true,
        blockReason: classification.reason,
      };
    }

    try {
      const output = execSync(command, {
        cwd: this.workspaceRoot,
        encoding: "utf-8",
        timeout: options?.timeoutMs ?? 30000,
        maxBuffer: options?.maxBuffer ?? 10 * 1024 * 1024,
        env: buildShellEnv(this.filterEnv()),
        shell: process.platform === "win32" ? cmdExe() : "/bin/bash",
      });

      return {
        success: true,
        stdout: output,
        stderr: "",
        exitCode: 0,
        classification: classification.class,
        blocked: false,
      };
    } catch (err: any) {
      return {
        success: false,
        stdout: err.stdout ?? "",
        stderr: err.stderr ?? String(err),
        exitCode: err.status ?? 1,
        classification: classification.class,
        blocked: false,
      };
    }
  }

  /** Filter environment variables to remove secrets */
  private filterEnv(): Record<string, string | undefined> {
    const filtered: Record<string, string | undefined> = {};
    const sensitiveKeys = [
      "AWS_SECRET", "AWS_ACCESS_KEY", "GITHUB_TOKEN", "NPM_TOKEN",
      "DOCKER_PASSWORD", "DATABASE_URL", "REDIS_URL", "API_KEY",
      "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "DEEPSEEK_API_KEY",
    ];

    for (const [key, value] of Object.entries(process.env)) {
      const isSensitive = sensitiveKeys.some((sk) =>
        key.toUpperCase().includes(sk.toUpperCase()),
      );
      filtered[key] = isSensitive ? "[REDACTED]" : value;
    }

    return filtered;
  }
}
