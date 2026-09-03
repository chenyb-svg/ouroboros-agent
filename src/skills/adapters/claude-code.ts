// =============================================================================
// ClaudeCodeAdapter — Parses SKILL.md + .claude/agents/*.yaml + CLAUDE.md
// Claude Code Skill = YAML frontmatter (metadata) + Markdown body (instructions)
// =============================================================================

import { readFileSync, existsSync, readdirSync, watch, statSync } from "node:fs";
import { join, basename, extname } from "node:path";
import yaml from "js-yaml";
import type { SkillAdapter } from "../adapter.js";
import type { AgentContract } from "../../types/agents.js";

interface ClaudeCodeAgentYaml { name?: string; description?: string; tools?: string[]; model?: string; temperature?: number; systemPrompt?: string; }

export class ClaudeCodeAdapter implements SkillAdapter {
  readonly name = "claude-code";

  canHandle(path: string): boolean {
    return path.includes(".claude") || basename(path) === "CLAUDE.md" || basename(path) === "SKILL.md" || (existsSync(path) && (existsSync(join(path, "SKILL.md")) || existsSync(join(path, "CLAUDE.md"))));
  }

  async parse(path: string): Promise<AgentContract[]> {
    const contracts: AgentContract[] = [];
    if (!existsSync(path)) return contracts;

    const st = statSync(path);

    if (st.isDirectory()) {
      // 1. Scan for SKILL.md in subdirectories (Claude Code skill format)
      try {
        const entries = readdirSync(path, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            const skillMdPath = join(path, entry.name, "SKILL.md");
            if (existsSync(skillMdPath)) {
              const contract = this.parseSkillMd(skillMdPath, entry.name);
              if (contract) contracts.push(contract);
            }
            // Also check for skill.yaml in subdirectory
            const skillYamlPath = join(path, entry.name, "skill.yaml");
            if (existsSync(skillYamlPath)) {
              const contract = this.parseAgentFile(skillYamlPath);
              if (contract) contracts.push(contract);
            }
          }
        }
      } catch { /* */ }

      // 2. Scan for .yaml/.yml in the directory itself
      try {
        const yamlFiles = readdirSync(path).filter(f => f.endsWith(".yaml") || f.endsWith(".yml"));
        for (const file of yamlFiles) {
          try { const c = this.parseAgentFile(join(path, file)); if (c) contracts.push(c); } catch { /* */ }
        }
      } catch { /* directory may have been deleted */ }

      // 3. Also check for a subdirectory "agents" (if path is a .claude parent dir)
      const agentsDir = join(path, "agents");
      if (existsSync(agentsDir) && statSync(agentsDir).isDirectory()) {
        const agentFiles = readdirSync(agentsDir).filter(f => f.endsWith(".yaml") || f.endsWith(".yml"));
        for (const file of agentFiles) {
          try { const c = this.parseAgentFile(join(agentsDir, file)); if (c) contracts.push(c); } catch { /* */ }
        }
      }

      // 4. Scan for SKILL.md files at the top level
      const topSkillMd = join(path, "SKILL.md");
      if (existsSync(topSkillMd)) {
        const c = this.parseSkillMd(topSkillMd, basename(path));
        if (c) contracts.push(c);
      }
    }

    return contracts;
  }

  /** Parse a SKILL.md file with YAML frontmatter */
  parseSkillMd(filePath: string, defaultName?: string): AgentContract | null {
    try {
      const raw = readFileSync(filePath, "utf-8");
      const frontmatter = extractFrontmatter(raw);
      const body = extractBody(raw);

      const name = frontmatter?.name ?? defaultName ?? basename(filePath, ".md");
      const description = frontmatter?.description ?? `${name} skill`;
      const tools = (frontmatter?.tools as string[]) ?? ["Read", "Bash"];

      const toolFqns = tools.map((t: string) => `claude-code:${t.toLowerCase().replace(/\s+/g, "-")}`);

      return {
        identity: { source: "claude-code", name, version: "v1", displayName: name, description },
        type: "Specialist",
        capabilities: {
          canReadFiles: toolFqns.some(t => t.includes("read")),
          canWriteFiles: toolFqns.some(t => t.includes("write") || t.includes("edit")),
          canExecuteBash: toolFqns.some(t => t.includes("bash") || t.includes("shell")),
          canDelegate: false, canModifyContext: false,
          providedTools: toolFqns, domainTags: ["claude-code", name],
        },
        contextPolicy: { level: "snapshot" },
        systemPrompt: body || `You are a Claude Code skill: ${name}. ${description}`,
      };
    } catch { return null; }
  }

  private parseAgentFile(filePath: string): AgentContract | null {
    const raw = readFileSync(filePath, "utf-8");
    const parsed = yaml.load(raw) as ClaudeCodeAgentYaml | undefined;
    if (!parsed) return null;
    const fileName = basename(filePath, extname(filePath));
    const name = parsed.name ?? fileName;
    const tools = (parsed.tools ?? ["Read", "Write", "Bash"]).map(t => `claude-code:${t.toLowerCase().replace(/\s+/g, "-")}`);
    return {
      identity: { source: "claude-code", name, version: "v1", displayName: parsed.name ?? name, description: parsed.description ?? `Claude Code agent: ${name}` },
      type: "Specialist",
      capabilities: {
        canReadFiles: tools.some(t => t.includes("read")), canWriteFiles: tools.some(t => t.includes("write") || t.includes("edit")),
        canExecuteBash: tools.some(t => t.includes("bash") || t.includes("shell")), canDelegate: false, canModifyContext: false,
        preferredModel: parsed.model ? { provider: "anthropic", model: parsed.model, temperature: parsed.temperature ?? 0.7, maxTokens: 8192 } : undefined,
        providedTools: tools, domainTags: ["claude-code", name],
      },
      contextPolicy: { level: "snapshot" },
      systemPrompt: parsed.systemPrompt ?? `You are a Claude Code agent: ${name}. ${parsed.description ?? ""}`,
    };
  }

  watch(path: string, onChange: (cs: AgentContract[]) => void): () => void {
    try { const w = watch(path, { recursive: true }, async () => { const cs = await this.parse(path); onChange(cs); }); w.unref(); return () => w.close(); }
    catch { return () => {}; }
  }
}

// ---- SKILL.md Frontmatter Parser ----
function extractFrontmatter(md: string): Record<string, any> | null {
  const match = md.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return null;
  try { return yaml.load(match[1]) as Record<string, any>; } catch { return null; }
}
function extractBody(md: string): string {
  const parts = md.split(/^---\s*\n/);
  if (parts.length >= 3) return parts.slice(2).join("---\n").trim();
  if (parts.length === 2 && md.startsWith("---")) return parts[1]?.replace(/^[\s\S]*?\n---\n?/, "").trim() ?? md;
  return md;
}
