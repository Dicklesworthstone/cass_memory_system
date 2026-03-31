import fs from "node:fs/promises";
import path from "node:path";
import yaml from "yaml";
import {
  Playbook,
  PlaybookBullet,
  BulletKind,
  BulletMaturity,
  BulletSource
} from "./types.js";
import { createEmptyPlaybook } from "./playbook.js";
import { expandPath, hashContent, now, resolveGlobalDir } from "./utils.js";

type StarterBulletInput = {
  id?: string;
  content: string;
  category: string;
  kind?: BulletKind;
  maturity?: BulletMaturity;
  tags?: string[];
  scope?: PlaybookBullet["scope"];
  workspace?: string;
  isNegative?: boolean;
  type?: PlaybookBullet["type"];
  source?: BulletSource;
};

export type StarterSource = "builtin" | "custom";

export interface StarterDefinition {
  name: string;
  description: string;
  bullets: StarterBulletInput[];
  source?: BulletSource;
}

export interface StarterSummary {
  name: string;
  description: string;
  bulletCount: number;
  source: StarterSource;
  path?: string;
}

const STARTER_SESSION_TAG = "starter";

const BUILTIN_STARTERS: StarterDefinition[] = [
  {
    name: "general",
    description: "Universal engineering practices for day-one value.",
    bullets: [
      {
        id: "starter-general-small-functions",
        content: "Keep functions small and pure; one responsibility per function.",
        category: "general",
        maturity: "established",
        tags: ["design", "maintainability"],
      },
      {
        id: "starter-general-validate-inputs",
        content: "Validate inputs at boundaries (CLI args, HTTP payloads, env) before use.",
        category: "general",
        maturity: "established",
        tags: ["safety", "validation"],
      },
      {
        id: "starter-general-graceful-shutdown",
        content: "Handle shutdown signals with graceful cleanup of open resources.",
        category: "general",
        maturity: "established",
        tags: ["ops", "reliability"],
      },
      {
        id: "starter-general-observability",
        content: "Emit structured logs with request/task identifiers at boundaries.",
        category: "general",
        maturity: "established",
        tags: ["observability"],
      },
      {
        id: "starter-general-boundary-timeouts",
        content: "Set sane timeouts and retries for all outbound network calls.",
        category: "general",
        maturity: "established",
        tags: ["reliability", "networking"],
      }
    ]
  },
  {
    name: "react",
    description: "React/Next.js conventions that avoid common regressions.",
    bullets: [
      {
        id: "starter-react-effect-deps",
        content: "Include every referenced value in useEffect/useMemo dependency arrays to avoid stale closures.",
        category: "react",
        maturity: "established",
        tags: ["react", "hooks"]
      },
      {
        id: "starter-react-stable-keys",
        content: "Use stable unique keys for lists; avoid array index keys when order can change.",
        category: "react",
        maturity: "proven",
        tags: ["react", "lists"]
      },
      {
        id: "starter-react-conditional-guards",
        content: "Guard browser-only APIs (window, document) behind runtime checks for SSR safety.",
        category: "react",
        maturity: "established",
        tags: ["nextjs", "ssr"]
      },
      {
        id: "starter-react-accessibility",
        content: "Provide accessible names/roles for interactive elements and keep tab order predictable.",
        category: "react",
        maturity: "established",
        tags: ["a11y"]
      }
    ]
  },
  {
    name: "python",
    description: "Python API patterns (FastAPI/Django) for reliability.",
    bullets: [
      {
        id: "starter-python-type-hints",
        content: "Use strict type hints and dataclasses/Pydantic models at module boundaries.",
        category: "python",
        maturity: "established",
        tags: ["typing", "api"]
      },
      {
        id: "starter-python-dependency-injection",
        content: "Share resources (DB clients, HTTP sessions) via dependency injection instead of globals.",
        category: "python",
        maturity: "established",
        tags: ["fastapi", "architecture"]
      },
      {
        id: "starter-python-timeouts",
        content: "Set explicit timeouts on HTTP and DB operations; never rely on defaults.",
        category: "python",
        maturity: "established",
        tags: ["reliability"]
      },
      {
        id: "starter-python-logging",
        content: "Log structured context (request id, user, model) using a shared logger; avoid print.",
        category: "python",
        maturity: "established",
        tags: ["observability"]
      }
    ]
  },
  {
    name: "node",
    description: "Node.js/Express conventions for production services.",
    bullets: [
      {
        id: "starter-node-async-errors",
        content: "Use centralized error middleware; ensure async handlers propagate errors to it.",
        category: "node",
        maturity: "established",
        tags: ["express", "error-handling"]
      },
      {
        id: "starter-node-http-timeouts",
        content: "Set request and socket timeouts for outbound HTTP clients; fail fast on hung peers.",
        category: "node",
        maturity: "established",
        tags: ["networking"]
      },
      {
        id: "starter-node-config",
        content: "Load configuration once at startup and validate required env vars; avoid reading env at runtime hotspots.",
        category: "node",
        maturity: "established",
        tags: ["configuration"]
      },
      {
        id: "starter-node-shutdown",
        content: "Handle SIGTERM by stopping new work, draining in-flight requests, and closing connections.",
        category: "node",
        maturity: "established",
        tags: ["ops", "reliability"]
      }
    ]
  },
  {
    name: "rust",
    description: "Rust service idioms that keep binaries safe and observable.",
    bullets: [
      {
        id: "starter-rust-errors",
        content: "Use thiserror/anyhow for rich errors; avoid unwrap/expect in library code.",
        category: "rust",
        maturity: "established",
        tags: ["error-handling"]
      },
      {
        id: "starter-rust-clippy",
        content: "Run clippy and rustfmt in CI; treat clippy::pedantic warnings as fixes, not noise.",
        category: "rust",
        maturity: "established",
        tags: ["lint"]
      },
      {
        id: "starter-rust-concurrency",
        content: "Prefer Send/Sync-aware primitives and structured concurrency; avoid spawning detached tasks without supervision.",
        category: "rust",
        maturity: "established",
        tags: ["concurrency"]
      },
      {
        id: "starter-rust-logging",
        content: "Use structured tracing (tracing crate) with request ids instead of println! debugging.",
        category: "rust",
        maturity: "established",
        tags: ["observability"]
      }
    ]
  }
];

async function discoverCustomStarterFiles(): Promise<string[]> {
  const roots = [
    path.join(resolveGlobalDir(), "starters"),
    path.join(resolveGlobalDir(), "starters", "custom"),
  ];

  const files: string[] = [];
  for (const root of roots) {
    try {
      const entries = await fs.readdir(root, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        if (entry.name.endsWith(".yaml") || entry.name.endsWith(".yml") || entry.name.endsWith(".json")) {
          files.push(path.join(root, entry.name));
        }
      }
    } catch {
      // Directory may not exist yet; that's fine.
    }
  }
  return files;
}

function stableStarterId(defName: string, bullet: StarterBulletInput, index: number): string {
  if (bullet.id) return bullet.id;
  const digest = hashContent(`${defName}:${bullet.content}`).slice(0, 8);
  return `starter-${defName}-${digest || index}`;
}

function normalizeBullet(
  def: StarterDefinition,
  bullet: StarterBulletInput,
  index: number
): PlaybookBullet {
  const timestamp = now();
  const content = bullet.content || ""; // Handle missing content gracefully
  
  return {
    id: stableStarterId(def.name, bullet, index),
    content: content,
    category: bullet.category || "general",
    kind: bullet.kind || "workflow_rule",
    type: bullet.type || "rule",
    isNegative: Boolean(bullet.isNegative),
    scope: bullet.scope || "global",
    workspace: bullet.workspace,
    source: bullet.source || def.source || "community",
    state: "active",
    maturity: bullet.maturity || "established",
    createdAt: timestamp,
    updatedAt: timestamp,
    helpfulCount: 0,
    harmfulCount: 0,
    feedbackEvents: [],
    deprecated: false,
    pinned: false,
    deprecatedAt: undefined,
    confidenceDecayHalfLifeDays: 90,
    sourceSessions: [`${STARTER_SESSION_TAG}:${def.name}`],
    sourceAgents: [STARTER_SESSION_TAG],
    tags: bullet.tags || [],
    searchPointer: content.slice(0, 80)
  };
}

function buildPlaybookFromDefinition(def: StarterDefinition): Playbook {
  const playbook = createEmptyPlaybook(def.name);
  playbook.description = def.description;
  playbook.bullets = def.bullets.map((b, idx) => normalizeBullet(def, b, idx));
  return playbook;
}

async function loadCustomStarter(pathname: string): Promise<StarterDefinition | null> {
  try {
    const raw = await fs.readFile(pathname, "utf-8");
    const parsed = pathname.endsWith(".json") ? JSON.parse(raw) : yaml.parse(raw);
    if (!parsed || !Array.isArray(parsed.bullets)) return null;
    return {
      name: parsed.name || path.basename(pathname, path.extname(pathname)),
      description: parsed.description || "Custom starter",
      bullets: parsed.bullets,
      source: "custom"
    };
  } catch {
    return null;
  }
}

export async function listStarters(): Promise<StarterSummary[]> {
  const builtins = BUILTIN_STARTERS.map<StarterSummary>((starter) => ({
    name: starter.name,
    description: starter.description,
    bulletCount: starter.bullets.length,
    source: "builtin"
  }));

  const customs: StarterSummary[] = [];
  const files = await discoverCustomStarterFiles();
  for (const file of files) {
    const loaded = await loadCustomStarter(file);
    if (!loaded) continue;
    customs.push({
      name: loaded.name,
      description: loaded.description,
      bulletCount: loaded.bullets.length,
      source: "custom",
      path: file
    });
  }

  return [...builtins, ...customs].sort((a, b) => a.name.localeCompare(b.name));
}

async function findStarterDefinition(name: string): Promise<StarterDefinition | null> {
  const normalized = name.toLowerCase();
  const customFiles = await discoverCustomStarterFiles();
  for (const file of customFiles) {
    const base = path.basename(file, path.extname(file)).toLowerCase();
    const def = await loadCustomStarter(file);
    if (!def) continue;
    if (base === normalized || def.name.toLowerCase() === normalized) return def;
  }

  const builtin = BUILTIN_STARTERS.find((s) => s.name.toLowerCase() === normalized);
  return builtin ? { ...builtin, source: builtin.source || "community" } : null;
}

export async function loadStarter(name: string): Promise<Playbook | null> {
  const def = await findStarterDefinition(name);
  if (!def) return null;
  return buildPlaybookFromDefinition(def);
}

export function applyStarter(
  target: Playbook,
  starter: Playbook,
  options: { preferExisting?: boolean } = {}
): { added: number; skipped: number } {
  const preferExisting = options.preferExisting !== false;
  const existingIds = new Set(target.bullets.map((b) => b.id));
  const existingContentHashes = new Set(target.bullets.map((b) => hashContent(b.content)));

  let added = 0;
  let skipped = 0;

  for (const bullet of starter.bullets) {
    const contentHash = hashContent(bullet.content);
    const idCollision = existingIds.has(bullet.id);
    const contentCollision = existingContentHashes.has(contentHash);

    if (preferExisting && (idCollision || contentCollision)) {
      skipped++;
      continue;
    }

    const uniqueId = idCollision ? `${bullet.id}-starter` : bullet.id;
    target.bullets.push({ ...bullet, id: uniqueId });
    existingIds.add(uniqueId);
    existingContentHashes.add(contentHash);
    added++;
  }

  return { added, skipped };
}
