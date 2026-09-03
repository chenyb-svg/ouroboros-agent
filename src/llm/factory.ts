// =============================================================================
// LLM Provider Factory — Creates providers from config
// =============================================================================

import type { OuroborosConfig, ProviderConfig } from "../types/config.js";
import type { LlmProvider } from "./provider.js";
import { OpenAiProvider } from "./openai-provider.js"; // We'll create this next

/**
 * Resolve a `${ENV_VAR}` string to its actual value.
 */
function resolveEnvVar(value: string): string {
  return value.replace(/\$\{(\w+)\}/g, (_, name) => {
    return process.env[name] ?? "";
  });
}

/**
 * Create all LLM providers from config.
 */
export function createProviders(config: OuroborosConfig): Map<string, LlmProvider> {
  const providers = new Map<string, LlmProvider>();

  for (const pc of config.providers) {
    const apiKey = resolveEnvVar(pc.apiKey);

    switch (pc.type) {
      case "openai":
      case "deepseek": {
        const provider = new OpenAiProvider({
          name: pc.name,
          apiKey,
          baseUrl: pc.baseUrl,
          models: pc.models,
        });
        providers.set(pc.name, provider);
        break;
      }
      case "anthropic":
        // Anthropic exposes an OpenAI-compatible endpoint — reuse OpenAiProvider.
        // Configure: type: anthropic + baseUrl: https://api.anthropic.com/v1
        providers.set(pc.name, new OpenAiProvider({
          name: pc.name,
          apiKey,
          baseUrl: pc.baseUrl,
          models: pc.models,
        }));
        break;
      default:
        // Unknown provider type, skip
        break;
    }
  }

  // Legacy: if no providers configured, auto-convert from model config
  if (providers.size === 0) {
    const apiKey = process.env[config.model.apiKeyEnv] ?? "";
    const legacyProvider = new OpenAiProvider({
      name: config.model.provider,
      apiKey,
      baseUrl: config.model.apiEndpoint,
      models: [config.model.model],
    });
    providers.set(config.model.provider, legacyProvider);
  }

  return providers;
}

/**
 * Resolve which model to use for a specific agent.
 * Checks modelOverrides first, falls back to defaults.
 */
export function resolveModel(
  config: OuroborosConfig,
  agentId: string,
  agentType: string,
): { provider: LlmProvider; model: string; temperature: number; maxTokens: number; contextWindow?: number } {
  const providers = createProviders(config);

  // Check overrides: first by agentId, then by type
  const override =
    config.modelOverrides[agentId] ??
    config.modelOverrides[agentType];

  if (override) {
    const provider = providers.get(override.provider);
    if (provider) {
      return {
        provider,
        model: override.model,
        temperature: override.temperature ?? 0.7,
        maxTokens: override.maxTokens ?? 8192,
        // Real context window: per-override wins, else the top-level model setting.
        contextWindow: override.contextWindow ?? config.model.contextWindow,
      };
    }
  }

  // Fallback to first available provider
  const firstProvider = providers.values().next().value as LlmProvider | undefined;
  if (!firstProvider) {
    throw new Error("No LLM providers configured. Set DEEPSEEK_API_KEY or configure providers in config.");
  }

  return {
    provider: firstProvider,
    model: config.model.model,
    temperature: config.model.temperature,
    maxTokens: config.model.maxTokens,
    contextWindow: config.model.contextWindow,
  };
}
