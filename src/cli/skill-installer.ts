// =============================================================================
// Skill Installer — Downloads Claude Code / OpenClaw / MCP skills (Phase 6+)
// =============================================================================

import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { dataPath } from "../data-home.js";
import { execSync } from "node:child_process";
import yaml from "js-yaml";

export interface SkillMeta {
  name: string;
  description: string;
  source: string;       // "claude-code", "openclaw", "mcp"
  installedAt: number;
  path: string;
  fullPromptPath?: string;  // Path to full SKILL.md content
}

export class SkillInstaller {
  private installDir: string;

  constructor(customDir?: string) {
    // Install to both locations: user-level cache + project-level .claude/skills/
    this.installDir = customDir ?? dataPath("skills", "claude-code");
    // Also ensure .claude/skills/ exists for ClaudeCodeAdapter auto-discovery
    const projectSkillsDir = join(process.cwd(), ".claude", "skills");
    if (!existsSync(projectSkillsDir)) mkdirSync(projectSkillsDir, { recursive: true });
    if (!existsSync(this.installDir)) mkdirSync(this.installDir, { recursive: true });
  }

  /** Install a skill from a GitHub repo path */
  installFromGitHub(skillName: string, repo: string = "anthropics/skills"): SkillMeta | null {
    const skillDir = join(this.installDir, skillName);
    if (existsSync(skillDir)) {
      return this.loadMeta(skillName); // Already installed
    }

    mkdirSync(skillDir, { recursive: true });

    let mdContent = "";
    // Download via GitHub API (works when raw.githubusercontent.com is blocked)
    const apiUrl = `https://api.github.com/repos/${repo}/contents/skills/${skillName}/SKILL.md?ref=main`;
    try {
      const result = execSync(`curl -sL -H "Accept: application/vnd.github.v3.raw" "${apiUrl}" 2>/dev/null || echo ""`, {
        encoding: "utf-8", timeout: 10000,
      } as any).trim();
      if (result && result.length > 50 && !result.startsWith("{") && !result.startsWith("<!DOCTYPE")) {
        mdContent = result;
      }
    } catch { /* skip */ }

    // Fallback: try raw.githubusercontent.com
    if (!mdContent) {
      const baseUrl = `https://raw.githubusercontent.com/${repo}/main/skills/${skillName}`;
      for (const file of ["SKILL.md", "skill.md", "skill.yaml"]) {
        try {
          const result = execSync(`curl -sL --connect-timeout 5 "${baseUrl}/${file}" 2>/dev/null || echo ""`, {
            encoding: "utf-8", timeout: 10000,
          } as any).trim();
          if (result && result.length > 50 && !result.startsWith("404") && !result.startsWith("<")) {
            mdContent = result; break;
          }
        } catch { /* skip */ }
      }
    }

    // Save downloaded content
    if (mdContent) {
      writeFileSync(join(skillDir, "SKILL.md"), mdContent, "utf-8");
    } else {
      // Nothing downloaded — create stub so skill is at least registered
      writeFileSync(join(skillDir, "SKILL.md"), `---\nname: ${skillName}\ndescription: "${skillName} skill from Claude Code ecosystem"\n---\n\n# ${skillName}\n\nInstall from: https://github.com/anthropics/skills/tree/main/skills/${skillName}\n`);
    }

    return this.loadMeta(skillName);
  }

  /** Install from a local directory */
  installFromLocal(sourcePath: string, skillName: string): SkillMeta | null {
    const skillDir = join(this.installDir, skillName);
    if (!existsSync(sourcePath)) return null;

    mkdirSync(skillDir, { recursive: true });

    // Copy skill files
    try {
      const filesToCopy = ["skill.yaml", "skill.yml", "SKILL.md", "skill.md"];
      for (const file of filesToCopy) {
        const src = join(sourcePath, file);
        if (existsSync(src)) {
          writeFileSync(join(skillDir, file), readFileSync(src, "utf-8"), "utf-8");
        }
      }
    } catch { return null; }

    return this.loadMeta(skillName);
  }

  /** Load only metadata (name + description) — NOT the full skill content */
  private _skillDirs(): string[] {
    return [
      this.installDir,
      join(process.cwd(), ".ouroboros", "skills", "claude-code"),
      join(process.cwd(), ".ouroboros", "skills", "github"),
      join(process.cwd(), ".claude", "skills"),
    ];
  }

  loadMeta(skillName: string): SkillMeta | null {
    for (const baseDir of this._skillDirs()) {
      const skillDir = join(baseDir, skillName);
      if (!existsSync(skillDir)) continue;

      const mdPath = join(skillDir, "SKILL.md");
      if (existsSync(mdPath)) {
        try {
          const md = readFileSync(mdPath, "utf-8");
          const frontmatter = this.parseFrontmatter(md);
          const name = frontmatter?.name ?? skillName;
          const desc = frontmatter?.description ?? `${skillName} skill`;
          return { name, description: desc, source: "claude-code", installedAt: Date.now(), path: skillDir, fullPromptPath: mdPath };
        } catch { /* */ }
      }

      const ymlPath = join(skillDir, "skill.yaml");
      if (existsSync(ymlPath)) {
        try {
          const rawYaml = readFileSync(ymlPath, "utf-8");
          const parsed = yaml.load(rawYaml) as any;
          return { name: parsed?.name ?? skillName, description: parsed?.description ?? `${skillName} skill`, source: "claude-code", installedAt: Date.now(), path: skillDir, fullPromptPath: ymlPath };
        } catch { /* */ }
      }
    }
    return null;
  }

  private parseFrontmatter(md: string): Record<string, any> | null {
    const match = md.match(/^---\s*\n([\s\S]*?)\n---/);
    if (!match) return null;
    try { return yaml.load(match[1]) as Record<string, any>; } catch { return null; }
  }

  /** Load the FULL skill content (for when the model requests it) */
  loadFullContent(skillName: string): string | null {
    // Check both home dir and project dir
    const dirs = [
      join(this.installDir, skillName),
      join(process.cwd(), ".ouroboros", "skills", "claude-code", skillName),
      join(process.cwd(), ".ouroboros", "skills", "github", skillName),
      join(process.cwd(), ".claude", "skills", skillName),
    ];
    for (const skillDir of dirs) {
      if (!existsSync(skillDir)) continue;
      const mdPath = join(skillDir, "SKILL.md");
      if (existsSync(mdPath)) {
        try { return readFileSync(mdPath, "utf-8"); } catch { /* */ }
      }
      const ymlPath = join(skillDir, "skill.yaml");
      if (existsSync(ymlPath)) {
        try { return readFileSync(ymlPath, "utf-8"); } catch { /* */ }
      }
    }
    return null;
  }

  /** Remove a skill from the USER install dirs (~/.ouroboros/skills/claude-code or
   *  <project>/.ouroboros/skills/claude-code). The project .claude/skills dir is
   *  reserved for hand-authored skills and is never touched. */
  uninstall(skillName: string): { ok: boolean; error?: string } {
    const projectSkills = join(process.cwd(), ".claude", "skills");
    for (const dir of this._skillDirs()) {
      if (dir === projectSkills) continue; // never remove hand-authored project skills
      const skillDir = join(dir, skillName);
      if (existsSync(skillDir)) {
        try {
          rmSync(skillDir, { recursive: true, force: true });
          return { ok: true };
        } catch (e: any) {
          return { ok: false, error: String(e?.message ?? e) };
        }
      }
    }
    return { ok: false, error: `${skillName} 未安装，或仅存在于项目 .claude/skills（不可卸载）` };
  }

  /** Re-download a skill, overwriting the installed copy (removes user-dir copies
   *  first so a stale SKILL.md is replaced; project .claude/skills is untouched). */
  update(skillName: string, repo: string = "anthropics/skills"): { ok: boolean; error?: string } {
    const projectSkills = join(process.cwd(), ".claude", "skills");
    for (const dir of this._skillDirs()) {
      if (dir === projectSkills) continue;
      const skillDir = join(dir, skillName);
      if (existsSync(skillDir)) {
        try { rmSync(skillDir, { recursive: true, force: true }); } catch { /* best-effort */ }
      }
    }
    const meta = this.installFromGitHub(skillName, repo);
    return meta ? { ok: true } : { ok: false, error: `安装失败：${skillName}` };
  }

  /** List all installed skills (metadata only). Checks home + project dirs. */
  listInstalled(): SkillMeta[] {
    const seen = new Set<string>();
    const results: SkillMeta[] = [];
    for (const dir of this._skillDirs()) {
      if (!existsSync(dir)) continue;
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const d of entries) {
        if (!d.isDirectory() || seen.has(d.name)) continue;
        seen.add(d.name);
        const meta = this.loadMeta(d.name);
        if (meta) results.push(meta);
      }
    }
    return results;
  }

  /** Build lightweight skill index for system prompt (~200 tokens) */
  buildSkillIndex(): string {
    const skills = this.listInstalled();
    if (skills.length === 0) return "";
    const lines = ["\n## Available Skills"];
    for (const s of skills) {
      lines.push(`- ${s.name}: ${s.description.slice(0, 80)}`);
    }
    lines.push("\nTo use a skill, call the `ouroboros:load_skill` tool with the skill name.");
    return lines.join("\n");
  }

  private createStubYaml(skillName: string): string {
    return `name: ${skillName}
description: "${skillName} skill — downloaded from Claude Code ecosystem"
source: claude-code
tools:
  - Read
  - Bash
model: deepseek-v4-flash
systemPrompt: |
  You are a ${skillName} specialist.
  Use available tools to complete ${skillName}-related tasks.
  Follow the standard Claude Code skill conventions.
`;
  }
}

// ---- Helpers ----

function extractYamlField(yaml: string, field: string): string | null {
  const regex = new RegExp(`^${field}\\s*:\\s*(.+)$`, "m");
  const match = regex.exec(yaml);
  return match?.[1]?.trim()?.replace(/^["']|["']$/g, "") ?? null;
}
