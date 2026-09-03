// =============================================================================
// Project Indexer — Lightweight codebase scanner (Phase 4)
// Scans project directory, builds file tree + symbol table + dependency graph.
// Completes in <5 seconds for typical projects.
// =============================================================================

import { readdirSync, statSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { join, relative, extname, dirname, normalize } from "node:path";
import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";

export interface IndexedFile {
  path: string;
  language: string;
  lines: number;
  lastModified: number;
  symbols: string[];     // functions/classes/interfaces/etc.
}

export interface ProjectIndex {
  projectRoot: string;
  scannedAt: number;
  fileCount: number;
  totalLines: number;
  languages: Record<string, number>;
  files: IndexedFile[];
  dependencies: Record<string, string>;  // dep name → version
  entryPoints: string[];
  gitBranch?: string;
  gitRecentCommits: string[];
  dependents: Record<string, number>;    // file path → how many files import it (for ranking)
}

export class ProjectIndexer {
  private workDir: string;
  private cachePath: string;
  private static readonly CACHE_VERSION = 2;

  constructor(workDir: string) {
    this.workDir = workDir;
    this.cachePath = join(workDir, ".ouroboros", "index", "project.json");
  }

  /** Scan the project directory. Uses cache if recent (< 5 min old) and same format version. */
  scan(): ProjectIndex {
    // Check cache
    if (existsSync(this.cachePath)) {
      try {
        const cached = JSON.parse(readFileSync(this.cachePath, "utf-8")) as ProjectIndex & { version?: number };
        const age = Date.now() - cached.scannedAt;
        if (cached.version === ProjectIndexer.CACHE_VERSION && age < 300_000) return cached; // < 5 minutes old
      } catch { /* re-scan */ }
    }

    const index = this.buildIndex();
    // Write cache
    try {
      const cacheDir = join(this.workDir, ".ouroboros", "index");
      if (!existsSync(cacheDir)) {
        const { mkdirSync } = require("node:fs");
        mkdirSync(cacheDir, { recursive: true });
      }
      writeFileSync(this.cachePath, JSON.stringify({ ...index, version: ProjectIndexer.CACHE_VERSION }, null, 2), "utf-8");
    } catch { /* cache write failure is non-fatal */ }

    return index;
  }

  /** Incrementally update only changed files */
  incrementalUpdate(changedFiles: string[]): void {
    // For now, just invalidate and re-scan
    try {
      const { unlinkSync } = require("node:fs");
      if (existsSync(this.cachePath)) unlinkSync(this.cachePath);
    } catch { /* ok */ }
  }

  /** Get human-readable summary for context injection */
  getSummary(index: ProjectIndex): string {
    const parts: string[] = ["## Project Context"];

    // File overview
    parts.push(`- Files: ${index.fileCount} files, ${index.totalLines} lines total`);
    parts.push(`- Languages: ${Object.entries(index.languages).map(([l, c]) => `${l}(${c})`).join(", ")}`);

    // Entry points
    if (index.entryPoints.length > 0) {
      parts.push(`- Entry points: ${index.entryPoints.join(", ")}`);
    }

    // Dependencies
    const depEntries = Object.entries(index.dependencies);
    if (depEntries.length > 0) {
      const depList = depEntries.slice(0, 10).map(([n, v]) => `${n}@${v}`).join(", ");
      parts.push(`- Dependencies: ${depList}${depEntries.length > 10 ? ` (+${depEntries.length - 10} more)` : ""}`);
    }

    // Git
    if (index.gitBranch) {
      parts.push(`- Git branch: ${index.gitBranch}`);
    }

    return parts.join("\n");
  }

  /**
   * Compact repository symbol graph for context injection (like Claude Code's repo map).
   * Files ranked by importance (dependents, symbol count, small-file bonus),
   * truncated to maxChars budget.
   */
  getSymbolGraph(index: ProjectIndex, maxChars = 1200): string {
    const withSymbols = index.files.filter((f) => f.symbols.length > 0);
    if (withSymbols.length === 0) return "";

    const scored = withSymbols
      .map((f) => {
        const deps = index.dependents?.[f.path] ?? 0;
        // Heuristic: heavily-imported files + dense symbol files rank high; huge files rank low
        const score = deps * 3 + Math.min(f.symbols.length, 25) - Math.min(f.lines / 100, 15);
        return { f, score };
      })
      .sort((a, b) => b.score - a.score);

    const lines: string[] = ["## Symbol Map (ranked by importance)"];
    let used = 0;
    for (const { f } of scored) {
      const line = `${f.path}: ${f.symbols.slice(0, 12).join(", ")}`;
      if (used + line.length + 2 > maxChars) break;
      lines.push(line);
      used += line.length;
    }
    return lines.join("\n");
  }

  private buildIndex(): ProjectIndex {
    const files = this.scanDirectory(this.workDir);
    const totalLines = files.reduce((sum, f) => sum + f.lines, 0);
    const languages: Record<string, number> = {};
    for (const f of files) {
      languages[f.language] = (languages[f.language] ?? 0) + 1;
    }

    const dependencies = this.parseDeps();
    const gitInfo = this.getGitInfo();

    return {
      projectRoot: this.workDir,
      scannedAt: Date.now(),
      fileCount: files.length,
      totalLines,
      languages,
      files,
      dependencies,
      entryPoints: this.findEntryPoints(files),
      gitBranch: gitInfo.branch,
      gitRecentCommits: gitInfo.recentCommits,
      dependents: this.buildDependents(files),
    };
  }

  /**
   * Build a reverse-import map: file path → count of files that import it.
   * Used to rank symbol-map importance (heavily-referenced = core module).
   */
  private buildDependents(files: IndexedFile[]): Record<string, number> {
    const dependents: Record<string, number> = {};
    const byPath = new Map(files.map((f) => [f.path, f]));

    for (const f of files) {
      if (!["TypeScript", "JavaScript", "Python"].includes(f.language)) continue;
      let content = "";
      try {
        content = readFileSync(join(this.workDir, f.path), "utf-8");
      } catch { continue; }

      const re = f.language === "Python"
        ? /^from\s+(\S+)\s+import\s+|^import\s+(\S+)/gm
        : /from\s+['"](\.[^'"]+)['"]|require\(\s*['"](\.[^'"]+)['"]\s*\)/g;

      let m: RegExpExecArray | null;
      while ((m = re.exec(content)) !== null) {
        const rel = (m[1] || m[2]) as string;
        const target = this.resolveImport(f.path, rel);
        if (target && byPath.has(target)) {
          dependents[target] = (dependents[target] ?? 0) + 1;
        }
      }
    }
    return dependents;
  }

  /** Resolve a relative import to a project file path (tries extensions & index files). */
  private resolveImport(fromFile: string, rel: string): string | null {
    const dir = join(this.workDir, dirname(fromFile));
    const base = normalize(join(dir, rel));
    // TS ESM convention: imports use .js/.jsx for .ts/.tsx sources — try all extension swaps
    const ext = extname(base);
    const stem = ext ? base.slice(0, -ext.length) : base;
    const candidates = [
      base,
      stem + ".ts", stem + ".tsx", stem + ".js", stem + ".jsx", stem + ".py",
      join(base, "index.ts"), join(base, "index.js"), join(base, "index.py"),
    ];
    for (const c of candidates) {
      if (existsSync(c)) return relative(this.workDir, c).replace(/\\/g, "/");
    }
    return null;
  }

  private scanDirectory(dir: string, baseDir?: string): IndexedFile[] {
    const results: IndexedFile[] = [];
    const skipDirs = new Set(["node_modules", "dist", ".git", ".ouroboros", "__pycache__", "coverage"]);

    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!skipDirs.has(entry.name) && !entry.name.startsWith(".")) {
            results.push(...this.scanDirectory(fullPath, baseDir ?? this.workDir));
          }
        } else if (entry.isFile()) {
          const relPath = relative(baseDir ?? this.workDir, fullPath).replace(/\\/g, "/");
          const ext = extname(entry.name).toLowerCase();
          const lang = this.guessLanguage(ext, entry.name);

          try {
            const stats = statSync(fullPath);
            let lines = 0;
            try {
              const content = readFileSync(fullPath, "utf-8");
              lines = content.split("\n").length;
            } catch {
              // Binary or unreadable — skip content analysis
            }

            results.push({
              path: relPath,
              language: lang,
              lines,
              lastModified: stats.mtimeMs,
              symbols: this.extractSymbols(fullPath, lang),
            });
          } catch { /* permission error, skip */ }
        }
      }
    } catch { /* directory read error, skip */ }
    return results;
  }

  private guessLanguage(ext: string, filename: string): string {
    const map: Record<string, string> = {
      ".ts": "TypeScript", ".tsx": "TypeScript",
      ".js": "JavaScript", ".jsx": "JavaScript",
      ".py": "Python", ".rs": "Rust", ".go": "Go",
      ".java": "Java", ".kt": "Kotlin",
      ".json": "JSON", ".yaml": "YAML", ".yml": "YAML",
      ".md": "Markdown", ".css": "CSS", ".html": "HTML",
      ".sql": "SQL", ".sh": "Shell", ".toml": "TOML",
      ".c": "C", ".cpp": "C++", ".h": "C/C++ Header",
    };
    if (map[ext]) return map[ext];
    if (filename === "Dockerfile") return "Docker";
    if (filename === "Makefile") return "Makefile";
    return "Other";
  }

  private extractSymbols(filePath: string, lang: string): string[] {
    if (!["TypeScript", "JavaScript", "Python", "Rust", "Go"].includes(lang)) return [];

    try {
      const content = readFileSync(filePath, "utf-8");
      const symbols: string[] = [];
      const seen = new Set<string>();
      const push = (name: string) => {
        if (name && !seen.has(name) && !name.startsWith("_")) {
          seen.add(name);
          symbols.push(name);
        }
      };

      if (lang === "TypeScript" || lang === "JavaScript") {
        const patterns = [
          // exported declarations
          /export\s+(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|enum)\s+(\w+)/g,
          /export\s+(?:async\s+)?(?:const|let|var)\s+(\w+)/g,
          /export\s*\{([^}]*)\}/g,
          // top-level declarations (not necessarily exported)
          /^(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(/gm,
          /^(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/gm,
          /^(?:export\s+)?interface\s+(\w+)/gm,
          /^(?:export\s+)?(?:async\s+)?const\s+(\w+)\s*=\s*(?:\(|async\s*\()/gm, // arrow funcs
        ];
        for (const re of patterns) {
          let m: RegExpExecArray | null;
          while ((m = re.exec(content)) !== null) {
            if (re.source.startsWith("export\\s*\\{")) {
              // export { a, b, c as d } — collect names
              for (const name of m[1].split(",")) {
                const n = name.trim().split(/\s+as\s+/)[0].trim();
                if (n) push(n);
              }
            } else {
              push(m[1]);
            }
          }
        }
      }

      // Python — top-level def/class only (avoid dumping method names)
      if (lang === "Python") {
        const defRegex = /^(?:def|class|async\s+def)\s+(\w+)/gm;
        let match: RegExpExecArray | null;
        while ((match = defRegex.exec(content)) !== null) {
          push(match[1]);
        }
      }

      // Rust
      if (lang === "Rust") {
        const fnRegex = /^(?:pub\s+)?(?:fn|struct|enum|trait|type)\s+(\w+)/gm;
        let match: RegExpExecArray | null;
        while ((match = fnRegex.exec(content)) !== null) {
          push(match[1]);
        }
      }

      // Go
      if (lang === "Go") {
        const fnRegex = /^func\s+(?:\([^)]*\)\s+)?(\w+)/gm;
        const typeRegex = /^type\s+(\w+)\s+(?:struct|interface)/gm;
        let match: RegExpExecArray | null;
        while ((match = fnRegex.exec(content)) !== null) push(match[1]);
        while ((match = typeRegex.exec(content)) !== null) push(match[1]);
      }

      return symbols.slice(0, 50); // Limit per file
    } catch {
      return [];
    }
  }

  private parseDeps(): Record<string, string> {
    const deps: Record<string, string> = {};

    // package.json
    const pkgPath = join(this.workDir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
        Object.assign(deps, pkg.dependencies ?? {}, pkg.devDependencies ?? {});
      } catch { /* parse error */ }
    }

    return deps;
  }

  private getGitInfo(): { branch?: string; recentCommits: string[] } {
    try {
      const branch = execSync("git branch --show-current", {
        cwd: this.workDir, encoding: "utf-8", timeout: 3000,
      }).trim();

      const log = execSync('git log --oneline -5 --format="%s"', {
        cwd: this.workDir, encoding: "utf-8", timeout: 3000,
      }).trim();

      return {
        branch: branch || undefined,
        recentCommits: log.split("\n").filter(Boolean),
      };
    } catch {
      return { recentCommits: [] };
    }
  }

  private findEntryPoints(files: IndexedFile[]): string[] {
    const entryPatterns = [
      "src/index.ts", "src/index.js", "src/main.ts", "src/main.js",
      "src/app.ts", "src/app.js", "main.py", "app.py",
      "src/main.rs", "main.go",
    ];

    const found: string[] = [];
    for (const pattern of entryPatterns) {
      if (files.some((f) => f.path === pattern || f.path.endsWith(pattern))) {
        found.push(pattern);
      }
    }

    // If no standard entry points, take the first .ts/.js file in src/
    if (found.length === 0) {
      const srcFile = files.find((f) =>
        f.path.startsWith("src/") &&
        (f.language === "TypeScript" || f.language === "JavaScript"),
      );
      if (srcFile) found.push(srcFile.path);
    }

    return found;
  }
}
