import fs from "node:fs/promises";
import chalk from "chalk";
import { icon } from "../output.js";
import { getDefaultConfig, saveConfig } from "../config.js";
import { cassAvailable, cassTimeline, type CassRunner } from "../cass.js";
import { Config, ConfigSchema, ErrorCode } from "../types.js";
import {
  expandPath,
  ensureGlobalStructure,
  fileExists,
  now,
  getCliName,
  printJsonResult,
  reportError,
  validatePositiveInt,
} from "../utils.js";

function normalizeAgentName(agent: string): string {
  return agent.trim().toLowerCase();
}

async function loadGlobalConfigEnsuringInit(): Promise<Config> {
  const defaultConfig = getDefaultConfig();
  const configPath = expandPath("~/.cass-memory/config.json");

  // Ensure base directories + config exist. (Idempotent; does not overwrite.)
  await ensureGlobalStructure(JSON.stringify(defaultConfig, null, 2));

  if (!(await fileExists(configPath))) {
    // Should not happen (ensureGlobalStructure should create it), but be defensive.
    return defaultConfig;
  }

  const rawText = await fs.readFile(configPath, "utf-8");
  const raw = JSON.parse(rawText) as Partial<Config>;

  const merged: unknown = {
    ...defaultConfig,
    ...raw,
    sanitization: {
      ...defaultConfig.sanitization,
      ...(raw.sanitization || {}),
    },
    scoring: {
      ...defaultConfig.scoring,
      ...(raw.scoring || {}),
    },
    budget: {
      ...defaultConfig.budget,
      ...(raw.budget || {}),
    },
    crossAgent: {
      ...defaultConfig.crossAgent,
      ...(raw.crossAgent || {}),
    },
  };

  const parsed = ConfigSchema.safeParse(merged);
  if (!parsed.success) {
    throw new Error(`Invalid global config: ${parsed.error.message}`);
  }

  return parsed.data;
}

async function getCassAgentCounts(
  days: number,
  cassPath: string,
  runner?: CassRunner
): Promise<Record<string, number> | null> {
  const available = runner ? cassAvailable(cassPath, { quiet: true }, runner) : cassAvailable(cassPath, { quiet: true });
  if (!available) return null;

  const timeline = runner ? await cassTimeline(days, cassPath, runner) : await cassTimeline(days, cassPath);
  const counts: Record<string, number> = {};

  for (const group of timeline.groups) {
    for (const session of group.sessions) {
      const agent = normalizeAgentName(session.agent || "unknown");
      counts[agent] = (counts[agent] || 0) + 1;
    }
  }

  return counts;
}

function formatAgentList(list: string[]): string {
  if (!list.length) return "(all agents)";
  return list.join(", ");
}

export async function privacyCommand(
  action: "status" | "enable" | "disable" | "allow" | "deny",
  args: string[],
  flags: { json?: boolean; days?: number } = {},
  deps: { cassRunner?: CassRunner } = {}
): Promise<void> {
  const startedAtMs = Date.now();
  const command = `privacy:${action}`;
  const config = await loadGlobalConfigEnsuringInit();
  const runner = deps.cassRunner;
  const cli = getCliName();
  const daysCheck = validatePositiveInt(flags.days, "days", { min: 1, allowUndefined: true });
  if (!daysCheck.ok) {
    reportError(daysCheck.message, {
      code: ErrorCode.INVALID_INPUT,
      details: daysCheck.details,
      hint: `Example: ${cli} privacy status --days 30 --json`,
      json: flags.json,
      command,
      startedAtMs,
    });
    return;
  }
  const days = daysCheck.value ?? 365;

  switch (action) {
    case "status": {
      const counts = await getCassAgentCounts(days, config.cassPath, runner);
      const cassIsAvailable = runner
        ? cassAvailable(config.cassPath, { quiet: true }, runner)
        : cassAvailable(config.cassPath, { quiet: true });
      const result = {
        crossAgent: config.crossAgent,
        cass: {
          available: cassIsAvailable,
          timelineDays: days,
          sessionCountsByAgent: counts,
        },
        notes: {
          enable: `${cli} privacy enable [agents...]`,
          disable: `${cli} privacy disable`,
          allow: `${cli} privacy allow <agent>`,
          deny: `${cli} privacy deny <agent>`,
        },
      };

      if (flags.json) {
        printJsonResult(command, result, { startedAtMs });
        return;
      }

      console.log(chalk.bold("\nPrivacy Status"));
      console.log(chalk.gray("═".repeat(50)));
      console.log(
        `Cross-agent enrichment: ${config.crossAgent.enabled ? chalk.green("ENABLED") : chalk.yellow("DISABLED")}`
      );
      console.log(`Consent given: ${config.crossAgent.consentGiven ? chalk.green("yes") : chalk.yellow("no")}`);
      console.log(`Consent date: ${config.crossAgent.consentDate || "none"}`);
      console.log(`Allowlist: ${formatAgentList((config.crossAgent.agents || []).map(normalizeAgentName))}`);
      console.log(`Audit log: ${config.crossAgent.auditLog === false ? chalk.yellow("off") : chalk.green("on")}`);

      if (counts) {
        console.log(chalk.bold(`\nAgents seen in cass timeline (last ${days} days):`));
        const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
        if (entries.length === 0) {
          console.log(chalk.gray("  (no sessions found)"));
        } else {
          for (const [agent, count] of entries) {
            console.log(`  - ${agent}: ${count} session(s)`);
          }
        }
      } else {
        console.log(chalk.yellow("\n(cass not available; cannot compute per-agent session counts)"));
      }

      console.log(chalk.dim(`\nTo enable: ${cli} privacy enable`));
      console.log(chalk.dim(`To disable: ${cli} privacy disable\n`));
      return;
    }

    case "enable": {
      const requested = args.map(normalizeAgentName).filter(Boolean);
      const discoveredCounts = await getCassAgentCounts(days, config.cassPath, runner);
      const discoveredAgents = discoveredCounts ? Object.keys(discoveredCounts) : [];

      const allowlist =
        requested.length > 0
          ? Array.from(new Set(requested)).sort()
          : discoveredAgents.length > 0
            ? discoveredAgents.sort()
            : ["claude", "cursor", "codex", "aider", "pi_agent"];

      config.crossAgent = {
        ...config.crossAgent,
        enabled: true,
        consentGiven: true,
        consentDate: config.crossAgent.consentDate || now(),
        agents: allowlist,
      };

      await saveConfig(config);

      if (flags.json) {
        printJsonResult(command, { crossAgent: config.crossAgent }, { startedAtMs });
      } else {
        console.log(chalk.green(`${icon("success")} Cross-agent enrichment enabled`));
        console.log(`  Allowlist: ${formatAgentList(allowlist)}`);
      }
      return;
    }

    case "disable": {
      config.crossAgent = { ...config.crossAgent, enabled: false };
      await saveConfig(config);

      if (flags.json) {
        printJsonResult(command, { crossAgent: config.crossAgent }, { startedAtMs });
      } else {
        console.log(chalk.green(`${icon("success")} Cross-agent enrichment disabled`));
      }
      return;
    }

    case "allow": {
      const agent = args[0];
      if (!agent) {
        reportError("privacy allow requires <agent>", {
          code: ErrorCode.MISSING_REQUIRED,
          hint: `Example: ${cli} privacy allow cursor --json`,
          details: { missing: "agent" },
          json: flags.json,
          command,
          startedAtMs,
        });
        return;
      }

      const normalized = normalizeAgentName(agent);
      const next = Array.from(new Set([...(config.crossAgent.agents || []).map(normalizeAgentName), normalized])).sort();

      config.crossAgent = {
        ...config.crossAgent,
        agents: next,
      };
      await saveConfig(config);

      if (flags.json) {
        printJsonResult(command, { crossAgent: config.crossAgent }, { startedAtMs });
      } else {
        console.log(chalk.green(`${icon("success")} Allowed agent '${normalized}'`));
        console.log(`  Allowlist: ${formatAgentList(next)}`);
      }
      return;
    }

    case "deny": {
      const agent = args[0];
      if (!agent) {
        reportError("privacy deny requires <agent>", {
          code: ErrorCode.MISSING_REQUIRED,
          hint: `Example: ${cli} privacy deny cursor --json`,
          details: { missing: "agent" },
          json: flags.json,
          command,
          startedAtMs,
        });
        return;
      }

      const normalized = normalizeAgentName(agent);
      const next = (config.crossAgent.agents || []).map(normalizeAgentName).filter((a) => a !== normalized).sort();

      config.crossAgent = {
        ...config.crossAgent,
        agents: next,
      };
      await saveConfig(config);

      if (flags.json) {
        printJsonResult(command, { crossAgent: config.crossAgent }, { startedAtMs });
      } else {
        console.log(chalk.green(`${icon("success")} Removed agent '${normalized}' from allowlist`));
        console.log(`  Allowlist: ${formatAgentList(next)}`);
      }
      return;
    }
  }
}
