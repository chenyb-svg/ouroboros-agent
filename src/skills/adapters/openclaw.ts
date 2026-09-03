// =============================================================================
// OpenClawAdapter — Parses ClawHub / agentskills.io skill format
// OpenClaw skills use JSON manifest + instruction files
// =============================================================================

import { existsSync, readFileSync, readdirSync, watch } from "node:fs";
import { join, basename } from "node:path";
import type { SkillAdapter } from "../adapter.js";
import type { AgentContract } from "../../types/agents.js";

interface OpenClawManifest { name?: string; description?: string; tools?: string[]; version?: string; instructions?: string; category?: string; }

export class OpenClawAdapter implements SkillAdapter {
  readonly name = "openclaw";

  canHandle(path: string): boolean {
    return path.includes("openclaw") || path.includes(".openclaw") || basename(path) === "claw.json" || basename(path) === "skill.json" || basename(path) === "manifest.json";
  }

  async parse(path: string): Promise<AgentContract[]> {
    const contracts: AgentContract[] = [];
    if (!existsSync(path)) return contracts;

    // 1. Parse manifest.json / claw.json / skill.json
    for (const manifestName of ["manifest.json", "claw.json", "skill.json", "openclaw.json"]) {
      const manifestPath = join(path, manifestName);
      if (existsSync(manifestPath)) {
        try {
          const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as OpenClawManifest;
          const contract = this.buildContract(manifest, path);
          if (contract) contracts.push(contract);
        } catch { /* */ }
      }
    }

    // 2. Scan subdirectories for skill manifests
    try {
      const entries = readdirSync(path, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const subDir = join(path, entry.name);
        for (const mf of ["manifest.json", "skill.json"]) {
          const mp = join(subDir, mf);
          if (existsSync(mp)) {
            try {
              const manifest = JSON.parse(readFileSync(mp, "utf-8")) as OpenClawManifest;
              const contract = this.buildContract(manifest, subDir);
              if (contract) contracts.push(contract);
            } catch { /* */ }
          }
        }
      }
    } catch { /* */ }

    return contracts;
  }

  private buildContract(manifest: OpenClawManifest, basePath: string): AgentContract | null {
    const name = manifest.name ?? basename(basePath);
    if (!name) return null;

    const tools = (manifest.tools ?? []).map(t => `openclaw:${t.toLowerCase().replace(/\s+/g, "_")}`);
    const instructionsFile = join(basePath, manifest.instructions ?? "instructions.md");
    let systemPrompt = `You are an OpenClaw skill: ${name}. ${manifest.description ?? ""}`;

    // Load instructions file if present
    if (existsSync(instructionsFile)) {
      try { systemPrompt = readFileSync(instructionsFile, "utf-8"); } catch { /* */ }
    }

    return {
      identity: { source: "openclaw", name, version: manifest.version ?? "v1", displayName: name, description: manifest.description ?? `OpenClaw skill: ${name}` },
      type: "Specialist",
      capabilities: {
        canReadFiles: true, canWriteFiles: tools.some(t => t.includes("write")),
        canExecuteBash: tools.some(t => t.includes("bash") || t.includes("exec")),
        canDelegate: false, canModifyContext: false,
        providedTools: tools, domainTags: ["openclaw", manifest.category ?? name].filter(Boolean),
      },
      contextPolicy: { level: "snapshot" },
      systemPrompt,
    };
  }

  watch(path: string, onChange: (cs: AgentContract[]) => void): () => void {
    try { const w = watch(path, { recursive: true }, async () => onChange(await this.parse(path))); w.unref(); return () => w.close(); }
    catch { return () => {}; }
  }
}
