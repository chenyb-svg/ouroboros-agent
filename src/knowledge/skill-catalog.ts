// =============================================================================
// Skill marketplace catalog — the "未安装" side of the skill market.
//
// A curated list of well-known Claude Code ecosystem skills that can be installed
// via SkillInstaller.installFromGitHub (network required; the installer falls back
// to a registered stub when the download fails). This is a static, offline catalog
// — the installed side is always read live from disk via SkillInstaller.listInstalled().
// =============================================================================

export interface SkillCatalogEntry {
  name: string;
  description: string;
  /** GitHub repo the skill lives in (skill path: <repo>/skills/<name>). */
  repo: string;
  homepage: string;
}

export const SKILL_CATALOG: SkillCatalogEntry[] = [
  { name: "artifact-builder", description: "Iteratively build & refine interactive web artifacts", repo: "anthropics/skills", homepage: "https://github.com/anthropics/skills/tree/main/skills/artifact-builder" },
  { name: "canvas-design", description: "Design and build large, polished web canvases", repo: "anthropics/skills", homepage: "https://github.com/anthropics/skills/tree/main/skills/canvas-design" },
  { name: "bedtime-stories", description: "Generate illustrated, customizable bedtime stories", repo: "anthropics/skills", homepage: "https://github.com/anthropics/skills/tree/main/skills/bedtime-stories" },
  { name: "brand-guidelines", description: "Produce brand-consistent design artifacts", repo: "anthropics/skills", homepage: "https://github.com/anthropics/skills/tree/main/skills/brand-guidelines" },
  { name: "docx", description: "Create, edit and format Word (.docx) documents", repo: "anthropics/skills", homepage: "https://github.com/anthropics/skills/tree/main/skills/docx" },
  { name: "pdf", description: "Create and edit PDF documents", repo: "anthropics/skills", homepage: "https://github.com/anthropics/skills/tree/main/skills/pdf" },
  { name: "pptx", description: "Create, edit and format PowerPoint (.pptx) decks", repo: "anthropics/skills", homepage: "https://github.com/anthropics/skills/tree/main/skills/pptx" },
  { name: "xlsx", description: "Create, edit and analyze Excel (.xlsx) spreadsheets", repo: "anthropics/skills", homepage: "https://github.com/anthropics/skills/tree/main/skills/xlsx" },
  { name: "websites", description: "Quickly scaffold interactive websites", repo: "anthropics/skills", homepage: "https://github.com/anthropics/skills/tree/main/skills/websites" },
  { name: "workflow", description: "Encode repeatable work as reusable, self-guided workflows", repo: "anthropics/skills", homepage: "https://github.com/anthropics/skills/tree/main/skills/workflow" },
  { name: "line-art", description: "Create consistent, stylized line-art illustrations", repo: "anthropics/skills", homepage: "https://github.com/anthropics/skills/tree/main/skills/line-art" },
  { name: "logo-generator", description: "Generate SVG logos that embed cleanly in documents", repo: "anthropics/skills", homepage: "https://github.com/anthropics/skills/tree/main/skills/logo-generator" },
];
