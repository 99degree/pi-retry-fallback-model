/**
 * Model Timeout & Fallback Extension
 *
 * Adds timeout to model requests and automatic fallback to next model on timeout.
 * Features:
 * - Cancels the current HTTP request on timeout
 * - Switches to a fallback model from a configured chain
 * - Shows visible messages in the conversation about the switch
 * - pi retries automatically after setModel()
 *
 * Configuration:
 * - Create .pi/model-timeout.json in project or home directory
 * - Or use commands: /timeout, /fallback, /fallback-add
 * - Environment variable: PI_MODEL_TIMEOUT_MS
 *
 * Example .pi/model-timeout.json:
 * {
 *   "timeoutMs": 8000,
 *   "fallbackChain": ["openai/gpt-4", "openai/gpt-3.5-turbo", "anthropic/claude-3-haiku"]
 * }
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";

interface Config {
  timeoutMs: number;
  fallbackChain: string[]; // format "provider/modelId"
}

const DEFAULT_CONFIG: Config = {
  timeoutMs: 30000,
  fallbackChain: [],
};

let config: Config = DEFAULT_CONFIG;
let currentModelId: string = '';
let abortController: AbortController | null = null;
let timeoutId: ReturnType<typeof setTimeout> | null = null;
let enabled = true;
let lastUserPrompt: string | null = null;

function loadConfig(cwd: string): Config {
  // Try project .pi directory first
  const projectConfigPath = join(cwd, ".pi", "model-timeout.json");
  const homeConfigPath = join(process.env.HOME || "/", ".pi", "model-timeout.json");

  for (const configPath of [projectConfigPath, homeConfigPath]) {
    try {
      const content = readFileSync(configPath, "utf8");
      const parsed = JSON.parse(content);
      return {
        timeoutMs: parsed.timeoutMs ?? DEFAULT_CONFIG.timeoutMs,
        fallbackChain: parsed.fallbackChain ?? DEFAULT_CONFIG.fallbackChain,
      };
    } catch {}
  }
  return { ...DEFAULT_CONFIG };
}

function saveConfig(cwd: string, newConfig: Config) {
  const configPath = join(cwd, ".pi", "model-timeout.json");
  try {
    writeFileSync(configPath, JSON.stringify(newConfig, null, 2), "utf8");
  } catch (err) {
    console.error("Failed to save config:", err);
  }
}

function cleanup() {
  if (timeoutId) {
    clearTimeout(timeoutId);
    timeoutId = null;
  }
  if (abortController) {
    abortController.abort();
    abortController = null;
  }
}

function getNextFallback(current: string): string | null {
  if (config.fallbackChain.length === 0) return null;

  // Helper: find index of current model in the chain, trying various formats
  function findInChain(target: string): number {
    // Exact match
    let idx = config.fallbackChain.indexOf(target);
    if (idx !== -1) return idx;

    // Try matching without the first segment (strips "nvidia-nim/" etc.)
    const slashIdx = target.indexOf('/');
    if (slashIdx > 0) {
      const afterFirst = target.substring(slashIdx + 1);
      idx = config.fallbackChain.indexOf(afterFirst);
      if (idx !== -1) return idx;
    }

    // Try matching each chain entry against target without splitting
    for (let i = 0; i < config.fallbackChain.length; i++) {
      const entry = config.fallbackChain[i];
      // If entry contains target or target ends with entry
      if (target.endsWith(entry) || entry.endsWith(target)) return i;
    }

    return -1;
  }

  let idx = findInChain(current);
  // If current model not found in chain, start from the first fallback entry.
  if (idx === -1) return config.fallbackChain[0];
  if (idx >= config.fallbackChain.length - 1) return null;
  return config.fallbackChain[idx + 1];
}

export default function (pi: ExtensionAPI) {
  // Load config on session start
  pi.on("session_start", async (event, ctx) => {
    config = loadConfig(ctx.cwd);

    // Environment variable override
    const envTimeout = process.env.PI_MODEL_TIMEOUT_MS;
    if (envTimeout) {
      const ms = parseInt(envTimeout, 10);
      if (!isNaN(ms) && ms > 0) {
        config.timeoutMs = ms;
      }
    }

    // Check if disabled
    if (process.env.PI_MODEL_TIMEOUT_DISABLE === 'true') {
      enabled = false;
      ctx.ui.notify("Model timeout extension disabled", "info");
      return;
    }

    ctx.ui.notify(`Model timeout: ${config.timeoutMs}ms, ${config.fallbackChain.length} fallback(s)`, "info");
  });

  // Track current model
  pi.on("model_select", async (event, ctx) => {
    currentModelId = `${event.model.provider}/${event.model.id}`;
  });

  // Capture last user prompt for retry
  pi.on("before_agent_start", async (event, ctx) => {
    lastUserPrompt = event.prompt;
  });

  /**
   * Resolve a fallback chain entry (e.g. "qwen/qwen3-coder-480b") to a model
   * by trying provider/modelId split first, then falling back to cross-provider search.
   */
  async function resolveModel(entry: string, ctx: any): Promise<any> {
    const slashIdx = entry.indexOf('/');
    if (slashIdx === -1) return null;
    const provider = entry.substring(0, slashIdx);
    const modelId = entry.substring(slashIdx + 1);
    let model = ctx.modelRegistry.find(provider, modelId);
    if (!model) {
      const allAvailable = await ctx.modelRegistry.getAvailable();
      model = allAvailable.find((m: any) =>
        m.id === entry || m.id === modelId || `${m.provider}/${m.id}` === entry
      );
    }
    return model;
  }

  /**
   * Called when a timeout fires. Aborts the current request, tries the next model
   * in the fallback chain, and sets up a new timeout for the retry so the chain
   * continues walking even if before_provider_request doesn't fire for the retry.
   */
  async function tryFallback(ctx: any) {
    ctx.ui.notify(`⏱ Model request timeout after ${config.timeoutMs}ms`, "warning");

    // Check for more fallbacks BEFORE aborting the current request.
    // If none left, we should abort the request completely
    const next = getNextFallback(currentModelId);
    if (!next) {
      ctx.ui.notify(`✗ No more fallback models. Current: ${currentModelId} — aborting request`, "error");
      
      // If we're at the last available model and it still fails, abort the request
      if (abortController) {
        abortController.abort();
        abortController = null;
      }
      return;
    }

    // We have a fallback — abort the current request
    if (abortController) {
      abortController.abort();
      abortController = null;
    }

    const model = await resolveModel(next, ctx);
    if (!model) {
      ctx.ui.notify(`✗ Fallback model ${next} not found`, "error");
      return;
    }

    const success = await pi.setModel(model);
    if (!success) {
      ctx.ui.notify(`✗ Failed to switch to ${next} (no API key?)`, "error");
      return;
    }

    currentModelId = next;

    pi.sendMessage({
      customType: "timeout-fallback",
      content: `⏱ Request timed out after ${config.timeoutMs}ms.\nSwitched to fallback model: **${next}**\nAuto-retrying...`,
      display: true,
    });
    ctx.ui.notify(`⬇ Switched to fallback: ${next}`, "info");

    // Set up a fresh timeout for the retry request.
    // The follow-up retry may bypass before_provider_request (agent internal
    // retry path), so we ensure a timeout is always in place.
    cleanup();
    
    // Reset timeout for each new model attempt
    abortController = new AbortController();
    timeoutId = setTimeout(() => tryFallback(ctx), config.timeoutMs);

    // pi.setModel() above already causes pi to retry the pending request
    // with the new model automatically — no need for an explicit retry.
  }

  // Intercept provider requests — add abort signal & timeout
  // Intercept provider requests — add standard timeout handling
  pi.on("before_provider_request", (event, ctx) => {
    if (!enabled) return;

    // Clean up any existing timeout
    cleanup();
    
    // Set up new timeout handler
    abortController = new AbortController();
    timeoutId = setTimeout(() => tryFallback(ctx), config.timeoutMs);

    // Attach timeout to provider payload using standard timeout options
    const payload = event.payload as any;
    
    // Notify upper level about the timeout settings
    ctx.ui.notify(`Setting standard timeout of ${config.timeoutMs}ms for the current request`, "info");
    
    if (payload && typeof payload === 'object') {
      if (payload.options && typeof payload.options === 'object') {
        // Add standard timeout to options
        payload.options.timeout = config.timeoutMs;
      } else {
        // Add standard timeout to payload
        payload.timeout = config.timeoutMs;
      }
    }

    return payload;
  });

  // Clean up on agent end
  pi.on("agent_end", () => {
    cleanup();
    
  });

  // Register commands
  pi.registerCommand("timeout", {
    description: "Set timeout (ms, off, or interactive selector)",
    handler: async (args, ctx) => {
      const trimmed = args.trim();

      if (trimmed.toLowerCase() === "off") {
        enabled = false;
        ctx.ui.notify("Model timeout disabled", "warning");
        return;
      }

      const ms = parseInt(trimmed, 10);
      if (!isNaN(ms) && ms > 0) {
        enabled = true;
        config.timeoutMs = ms;
        ctx.ui.notify(`Timeout set to ${ms}ms`, "info");
        return;
      }

      const options = [
        { value: "off", label: "Off", description: "Disable timeout" },
        { value: "5s", label: "5 seconds", description: "Timeout after 5s" },
        { value: "10s", label: "10 seconds", description: "Timeout after 10s" },
        { value: "20s", label: "20 seconds", description: "Timeout after 20s" },
        { value: "30s", label: "30 seconds", description: "Timeout after 30s" },
        { value: "60s", label: "60 seconds", description: "Timeout after 60s" },
        { value: "90s", label: "90 seconds", description: "Timeout after 90s" },
      ];

      const currentVal = enabled
        ? config.timeoutMs <= 5000 ? "5s"
          : config.timeoutMs <= 10000 ? "10s"
          : config.timeoutMs <= 20000 ? "20s"
          : config.timeoutMs <= 30000 ? "30s"
          : config.timeoutMs <= 60000 ? "60s"
          : "90s"
        : "off";

      const items: SelectItem[] = options.map((o) => ({
        value: o.value,
        label: o.value === currentVal ? `${o.label} (current)` : o.label,
        description: o.description,
      }));

      const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
        const container = new Container();
        container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
        container.addChild(new Text(theme.fg("accent", theme.bold("Timeout"))));

        const selectList = new SelectList(items, items.length, {
          selectedPrefix: (t) => theme.fg("accent", t),
          selectedText: (t) => theme.fg("accent", t),
          description: (t) => theme.fg("muted", t),
          scrollInfo: (t) => theme.fg("dim", t),
          noMatch: (t) => theme.fg("warning", t),
        });

        selectList.onSelect = (item) => done(item.value);
        selectList.onCancel = () => done(null);
        container.addChild(selectList);
        container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter select • esc cancel")));
        container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

        return {
          render: (w: number) => container.render(w),
          invalidate: () => container.invalidate(),
          handleInput: (data: string) => {
            selectList.handleInput(data);
            tui.requestRender();
          },
        };
      });

      if (result === "off") {
        enabled = false;
        ctx.ui.notify("Model timeout disabled", "warning");
      } else if (result === "5s") {
        enabled = true;
        config.timeoutMs = 5000;
        ctx.ui.notify("Timeout set to 5s", "info");
      } else if (result === "10s") {
        enabled = true;
        config.timeoutMs = 10000;
        ctx.ui.notify("Timeout set to 10s", "info");
      } else if (result === "20s") {
        enabled = true;
        config.timeoutMs = 20000;
        ctx.ui.notify("Timeout set to 20s", "info");
      } else if (result === "30s") {
        enabled = true;
        config.timeoutMs = 30000;
        ctx.ui.notify("Timeout set to 30s", "info");
      } else if (result === "60s") {
        enabled = true;
        config.timeoutMs = 60000;
        ctx.ui.notify("Timeout set to 60s", "info");
      } else if (result === "90s") {
        enabled = true;
        config.timeoutMs = 90000;
        ctx.ui.notify("Timeout set to 90s", "info");
      }
    },
  });

  pi.registerCommand("fallback", {
    description: "Set or show fallback chain (space-separated provider/model list)",
    handler: async (args, ctx) => {
      const chain = args.trim().split(/\s+/).filter(s => s.length > 0);
      if (chain.length === 0) {
        if (config.fallbackChain.length > 0) {
          ctx.ui.notify(`Current fallback chain: ${config.fallbackChain.join(' → ')}`, "info");
        } else {
          ctx.ui.notify("No fallback chain configured", "info");
        }
        return;
      }
      config.fallbackChain = chain;
      saveConfig(ctx.cwd, config);
      ctx.ui.notify(`Fallback chain set: ${chain.join(' → ')}`, "info");
    },
  });

  pi.registerCommand("fallback-add", {
    description: "Add a model to the end of fallback chain (interactive selector)",
    handler: async (args, ctx) => {
      // If a model string is provided directly, use it
      if (args.trim() && args.includes('/')) {
        config.fallbackChain.push(args.trim());
        saveConfig(ctx.cwd, config);
        ctx.ui.notify(`Added ${args.trim()} to fallback chain`, "info");
        return;
      }

      // Otherwise show interactive model selector
      const models = ctx.modelRegistry.getAll();
      if (models.length === 0) {
        ctx.ui.notify("No models available", "error");
        return;
      }

      const items: SelectItem[] = models.map((m) => ({
        value: `${m.provider}/${m.id}`,
        label: `${m.provider}/${m.id}`,
        description: m.name && m.name !== m.id ? m.name : undefined,
      }));

      const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
        const container = new Container();
        container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
        container.addChild(new Text(theme.fg("accent", theme.bold("Select Fallback Model"))));

        const selectList = new SelectList(items, Math.min(items.length, 10), {
          selectedPrefix: (t) => theme.fg("accent", t),
          selectedText: (t) => theme.fg("accent", t),
          description: (t) => theme.fg("muted", t),
          scrollInfo: (t) => theme.fg("dim", t),
          noMatch: (t) => theme.fg("warning", t),
        });

        selectList.onSelect = (item) => done(item.value);
        selectList.onCancel = () => done(null);
        container.addChild(selectList);
        container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter select • esc cancel")));
        container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

        return {
          render: (w: number) => container.render(w),
          invalidate: () => container.invalidate(),
          handleInput: (data: string) => {
            selectList.handleInput(data);
            tui.requestRender();
          },
        };
      });

      if (result) {
        config.fallbackChain.push(result);
        saveConfig(ctx.cwd, config);
        ctx.ui.notify(`Added ${result} to fallback chain`, "info");
      }
    },
  });

  pi.registerCommand("timeout-status", {
    description: "Show current timeout and fallback configuration",
    handler: async (args, ctx) => {
      ctx.ui.notify(`Timeout: ${config.timeoutMs}ms`, "info");
      if (config.fallbackChain.length > 0) {
        ctx.ui.notify(`Fallback chain: ${config.fallbackChain.join(' → ')}`, "info");
      } else {
        ctx.ui.notify("No fallback chain configured", "info");
      }
      ctx.ui.notify(`Current model: ${currentModelId}`, "info");
    },
  });


}