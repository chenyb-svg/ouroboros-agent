// =============================================================================
// Memory Extractor — Auto-extracts structured facts from completed tasks
// Triggered on RESULT_REPORT events. Uses heuristics + optional LLM.
// =============================================================================

import { randomUUID } from "node:crypto";
import type { MemoryStorage } from "./storage.js";
import type { MemoryCategory, ConfidenceLevel } from "../types/memory.js";

export interface ExtractionContext {
  taskDescription: string;
  userInput: string;
  workerResult: string;
  agentId: string;
  sessionId: string;
}

export class MemoryExtractor {
  private storage: MemoryStorage;
  private sessionId: string;

  constructor(storage: MemoryStorage, sessionId: string) {
    this.storage = storage;
    this.sessionId = sessionId;
  }

  /** Extract memories from a completed task */
  extract(ctx: ExtractionContext): number {
    let extracted = 0;

    // 1. User corrections (high priority)
    extracted += this.extractCorrections(ctx);

    // 2. Project setup facts (language, tools, config)
    extracted += this.extractProjectFacts(ctx);

    // 3. User preferences (explicit "I prefer", "use X not Y")
    extracted += this.extractPreferences(ctx);

    // 4. Code style patterns
    extracted += this.extractCodeStyle(ctx);

    return extracted;
  }

  /** Extract explicit corrections: "不对，应该是..." / "correct: X not Y" */
  private extractCorrections(ctx: ExtractionContext): number {
    const text = ctx.userInput + " " + ctx.workerResult;
    let count = 0;

    const correctionPatterns = [
      /不对[，,]?\s*(?:应该|应当|需要|用)\s*(.+)/g,
      /correct(?:ion)?:\s*(.+)/gi,
      /actually[，,]?\s*(.+)/gi,
      /don'?t\s+use\s+(\w+)[，,]?\s*use\s+(\w+)/gi,
      /不要用\s*(\S+)[，,]?\s*用\s*(\S+)/g,
    ];

    for (const pattern of correctionPatterns) {
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(text)) !== null) {
        const fact = match[1]?.trim() || match[0].trim();
        if (fact.length > 5 && fact.length < 200) {
          this.storage.write({
            fact: `用户纠正: ${fact}`,
            category: "correction",
            scope: `session:${this.sessionId}`,
            source: { agentId: ctx.agentId, sessionId: this.sessionId },
            confidence: "auto_high",
          });
          count++;
        }
      }
    }
    return count;
  }

  /** Extract project setup facts */
  private extractProjectFacts(ctx: ExtractionContext): number {
    const text = ctx.workerResult + " " + ctx.userInput; // Check both LLM output and user input
    let count = 0;

    const patterns: Array<{ regex: RegExp; category: MemoryCategory; template: string }> = [
      { regex: /(?:使用|用|uses?|using)\s+(TypeScript|JavaScript|Python|Rust|Go)\b/gi, category: "project_setup", template: "项目使用 {0}" },
      { regex: /package\s+manager[：:]\s*(npm|pnpm|yarn|bun)\b/gi, category: "project_setup", template: "包管理器: {0}" },
      { regex: /(?:framework|框架)[：:]\s*(\w+)/gi, category: "project_setup", template: "框架: {0}" },
      { regex: /test\s+(?:framework|runner)[：:]\s*(\w+)/gi, category: "project_setup", template: "测试框架: {0}" },
      // Wider patterns
      { regex: /用\s+(pnpm|npm|yarn|bun)\s*(?:管理|install|作为)/gi, category: "project_setup", template: "包管理器: {0}" },
      { regex: /不要用\s+(npm|yarn|pnpm)/gi, category: "project_setup", template: "禁止使用: {0}" },
    ];

    for (const { regex, category, template } of patterns) {
      let match: RegExpExecArray | null;
      while ((match = regex.exec(text)) !== null) {
        const fact = template.replace("{0}", match[1] || "");
        this.storage.write({
          fact,
          category,
          scope: `project:${this.sessionId}`,
          source: { agentId: ctx.agentId, sessionId: this.sessionId },
          confidence: "auto_medium",
        });
        count++;
      }
    }
    return count;
  }

  /** Extract user preferences */
  private extractPreferences(ctx: ExtractionContext): number {
    const text = ctx.userInput;
    let count = 0;

    const prefPatterns = [
      /(?:我|I)\s*(?:更|prefer|喜欢|习惯)\s*(.+)/gi,
      /remember\s+(?:that\s+)?(?:I|i)\s+(.+)/gi,
      /记住[：:]?\s*(.+)/g,
    ];

    for (const pattern of prefPatterns) {
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(text)) !== null) {
        const fact = match[1]?.trim();
        if (fact && fact.length > 3 && fact.length < 200) {
          const isExplicitRemember = /remember|记住/.test(match[0]);
          this.storage.write({
            fact,
            category: "user_preference",
            scope: isExplicitRemember ? "global" : `session:${this.sessionId}`,
            source: { agentId: ctx.agentId, sessionId: this.sessionId },
            confidence: isExplicitRemember ? "user_confirmed" : "auto_medium",
          });
          count++;
        }
      }
    }
    return count;
  }

  /** Extract code style patterns */
  private extractCodeStyle(ctx: ExtractionContext): number {
    const text = ctx.workerResult;
    let count = 0;

    const stylePatterns: Array<{ regex: RegExp; template: string }> = [
      { regex: /(?:缩进|indent\w*)[：:]\s*(\d+)\s*(?:空格|spaces?)/gi, template: "缩进: {0}空格" },
      { regex: /(?:引号|quote\w*)[：:]\s*(single|double|单引号|双引号)/gi, template: "引号风格: {0}" },
      { regex: /(?:分号|semicolon\w*)[：:]\s*(always|never|必需|不需要)/gi, template: "分号: {0}" },
    ];

    for (const { regex, template } of stylePatterns) {
      let match: RegExpExecArray | null;
      while ((match = regex.exec(text)) !== null) {
        this.storage.write({
          fact: template.replace("{0}", match[1] || ""),
          category: "coding_style",
          scope: `project:${this.sessionId}`,
          source: { agentId: ctx.agentId, sessionId: this.sessionId },
          confidence: "auto_low",
        });
        count++;
      }
    }
    return count;
  }
}
