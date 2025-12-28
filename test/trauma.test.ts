import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import {
  DOOM_PATTERNS,
  loadTraumas,
  saveTrauma,
  findMatchingTrauma,
  scanForTraumas,
  setTraumaStatusById,
  healTraumaById,
  removeTraumaById,
  type TraumaCandidate
} from "../src/trauma.js";
import { TraumaEntry } from "../src/types.js";
import { type CassRunner } from "../src/cass.js";
import { withTempDir, withTempCassHome, createTestConfig } from "./helpers/index.js";

/**
 * Create a CassRunner stub for trauma tests.
 * Supports search and export commands with predefined outputs.
 */
function createCassRunnerStub(opts: {
  searchOutput?: string;
  exportOutput?: string;
}): CassRunner {
  return {
    execFile: async (_file, args) => {
      const cmd = args[0] ?? "";
      if (cmd === "search") {
        return { stdout: opts.searchOutput ?? "[]", stderr: "" };
      }
      if (cmd === "export") {
        return { stdout: opts.exportOutput ?? "", stderr: "" };
      }
      throw new Error(`Unexpected cass execFile command: ${cmd}`);
    },
    spawnSync: (_file, args) => {
      const cmd = args[0];
      if (cmd === "--version") {
        return { status: 0, stdout: "", stderr: "" };
      }
      if (cmd === "health") {
        return { status: 0, stdout: "", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    },
    spawn: () => {
      throw new Error("spawn not implemented in stub");
    }
  };
}

// =============================================================================
// DOOM_PATTERNS - Pattern Validation
// =============================================================================
describe("DOOM_PATTERNS - Pattern Validation", () => {
  it("has required pattern categories", () => {
    const descriptions = DOOM_PATTERNS.map(p => p.description);

    // Filesystem destruction
    expect(descriptions.some(d => d.includes("deletion"))).toBe(true);

    // Database destruction
    expect(descriptions.some(d => d.includes("database") || d.includes("table"))).toBe(true);

    // Git destruction
    expect(descriptions.some(d => d.includes("Git"))).toBe(true);

    // Infrastructure
    expect(descriptions.some(d => d.includes("Terraform") || d.includes("Kubernetes"))).toBe(true);
  });

  it("matches rm -rf / commands", () => {
    const rmPatterns = DOOM_PATTERNS.filter(p => p.pattern.includes("rm"));

    const dangerousCommands = [
      "rm -rf /etc/passwd",
      "rm -rf /usr/local",
      "rm -rf /home/user",
      "rm -rf ~",
      "rm -rf /var/log"
    ];

    for (const cmd of dangerousCommands) {
      const matched = rmPatterns.some(p => new RegExp(p.pattern, "mi").test(cmd));
      expect(matched).toBe(true);
    }
  });

  it("matches git force push commands", () => {
    const gitPatterns = DOOM_PATTERNS.filter(p => p.pattern.includes("git"));

    const dangerousCommands = [
      "git push --force",
      "git push -f origin main",
      "git reset --hard HEAD~5",
      "git clean -fd"
    ];

    for (const cmd of dangerousCommands) {
      const matched = gitPatterns.some(p => new RegExp(p.pattern, "mi").test(cmd));
      expect(matched).toBe(true);
    }
  });

  it("matches database destruction commands", () => {
    const dbPatterns = DOOM_PATTERNS.filter(p =>
      p.pattern.includes("DROP") ||
      p.pattern.includes("TRUNCATE") ||
      p.pattern.includes("DELETE")
    );

    const dangerousCommands = [
      "DROP DATABASE production",
      "DROP SCHEMA public CASCADE",
      "TRUNCATE TABLE users",
      "DELETE FROM orders;"
    ];

    for (const cmd of dangerousCommands) {
      const matched = dbPatterns.some(p => new RegExp(p.pattern, "mi").test(cmd));
      expect(matched).toBe(true);
    }
  });

  it("matches infrastructure destruction commands", () => {
    const infraPatterns = DOOM_PATTERNS.filter(p =>
      p.pattern.includes("terraform") ||
      p.pattern.includes("kubectl") ||
      p.pattern.includes("docker")
    );

    const dangerousCommands = [
      "terraform destroy -auto-approve",
      "kubectl delete node worker-1",
      "kubectl delete namespace production",
      "docker system prune -a --volumes"
    ];

    for (const cmd of dangerousCommands) {
      const matched = infraPatterns.some(p => new RegExp(p.pattern, "mi").test(cmd));
      expect(matched).toBe(true);
    }
  });

  it("does NOT match safe commands", () => {
    const safeCommands = [
      "rm file.txt",
      "rm -i important.txt",
      "git push origin feature",
      "git status",
      "SELECT * FROM users",
      "docker ps",
      "kubectl get pods"
    ];

    for (const cmd of safeCommands) {
      const matched = DOOM_PATTERNS.some(p => new RegExp(p.pattern, "mi").test(cmd));
      expect(matched).toBe(false);
    }
  });
});

// =============================================================================
// loadTraumas - Loading from JSONL files
// =============================================================================
describe("loadTraumas - Loading from JSONL files", () => {
  it("returns empty array when no trauma files exist", async () => {
    await withTempCassHome(async (env) => {
      const traumas = await loadTraumas();
      expect(traumas).toEqual([]);
    });
  });

  it("loads traumas from global file", async () => {
    await withTempCassHome(async (env) => {
      const traumaEntry: TraumaEntry = {
        id: "trauma-001",
        severity: "CRITICAL",
        pattern: "rm -rf /",
        scope: "global",
        status: "active",
        trigger_event: {
          session_path: "/sessions/bad-day.jsonl",
          timestamp: new Date().toISOString(),
          human_message: "Never again"
        },
        created_at: new Date().toISOString()
      };

      await writeFile(
        join(env.cassMemoryDir, "traumas.jsonl"),
        JSON.stringify(traumaEntry) + "\n"
      );

      const traumas = await loadTraumas();
      expect(traumas.length).toBe(1);
      expect(traumas[0].id).toBe("trauma-001");
      expect(traumas[0].pattern).toBe("rm -rf /");
    });
  });

  it("loads multiple traumas from file", async () => {
    await withTempCassHome(async (env) => {
      const trauma1: TraumaEntry = {
        id: "trauma-001",
        severity: "CRITICAL",
        pattern: "rm -rf",
        scope: "global",
        status: "active",
        trigger_event: {
          session_path: "/sessions/s1.jsonl",
          timestamp: new Date().toISOString()
        },
        created_at: new Date().toISOString()
      };

      const trauma2: TraumaEntry = {
        id: "trauma-002",
        severity: "FATAL",
        pattern: "DROP DATABASE",
        scope: "global",
        status: "active",
        trigger_event: {
          session_path: "/sessions/s2.jsonl",
          timestamp: new Date().toISOString()
        },
        created_at: new Date().toISOString()
      };

      const content = JSON.stringify(trauma1) + "\n" + JSON.stringify(trauma2) + "\n";
      await writeFile(join(env.cassMemoryDir, "traumas.jsonl"), content);

      const traumas = await loadTraumas();
      expect(traumas.length).toBe(2);
      expect(traumas.map(t => t.id).sort()).toEqual(["trauma-001", "trauma-002"]);
    });
  });

  it("skips invalid JSON lines gracefully", async () => {
    await withTempCassHome(async (env) => {
      const validTrauma: TraumaEntry = {
        id: "trauma-valid",
        severity: "CRITICAL",
        pattern: "test",
        scope: "global",
        status: "active",
        trigger_event: {
          session_path: "/sessions/s1.jsonl",
          timestamp: new Date().toISOString()
        },
        created_at: new Date().toISOString()
      };

      const content = "not valid json\n" + JSON.stringify(validTrauma) + "\n{malformed\n";
      await writeFile(join(env.cassMemoryDir, "traumas.jsonl"), content);

      const traumas = await loadTraumas();
      expect(traumas.length).toBe(1);
      expect(traumas[0].id).toBe("trauma-valid");
    });
  });

  it("skips entries that don't match schema", async () => {
    await withTempCassHome(async (env) => {
      const validTrauma: TraumaEntry = {
        id: "trauma-valid",
        severity: "CRITICAL",
        pattern: "test",
        scope: "global",
        status: "active",
        trigger_event: {
          session_path: "/sessions/s1.jsonl",
          timestamp: new Date().toISOString()
        },
        created_at: new Date().toISOString()
      };

      // Missing required fields
      const invalidEntry = { id: "bad", foo: "bar" };

      const content = JSON.stringify(invalidEntry) + "\n" + JSON.stringify(validTrauma) + "\n";
      await writeFile(join(env.cassMemoryDir, "traumas.jsonl"), content);

      const traumas = await loadTraumas();
      expect(traumas.length).toBe(1);
      expect(traumas[0].id).toBe("trauma-valid");
    });
  });

  it("handles empty file", async () => {
    await withTempCassHome(async (env) => {
      await writeFile(join(env.cassMemoryDir, "traumas.jsonl"), "");

      const traumas = await loadTraumas();
      expect(traumas).toEqual([]);
    });
  });

  it("handles file with only whitespace/empty lines", async () => {
    await withTempCassHome(async (env) => {
      await writeFile(join(env.cassMemoryDir, "traumas.jsonl"), "\n\n  \n\n");

      const traumas = await loadTraumas();
      expect(traumas).toEqual([]);
    });
  });
});

// =============================================================================
// saveTrauma - Atomic persistence with locking
// =============================================================================
describe("saveTrauma - Atomic persistence", () => {
  it("saves global-scoped trauma to global file", async () => {
    await withTempCassHome(async (env) => {
      const trauma: TraumaEntry = {
        id: "trauma-save-001",
        severity: "CRITICAL",
        pattern: "rm -rf /",
        scope: "global",
        status: "active",
        trigger_event: {
          session_path: "/sessions/test.jsonl",
          timestamp: new Date().toISOString()
        },
        created_at: new Date().toISOString()
      };

      await saveTrauma(trauma);

      const content = await readFile(join(env.cassMemoryDir, "traumas.jsonl"), "utf-8");
      const savedTrauma = JSON.parse(content.trim());
      expect(savedTrauma.id).toBe("trauma-save-001");
      expect(savedTrauma.pattern).toBe("rm -rf /");
    });
  });

  it("appends to existing trauma file", async () => {
    await withTempCassHome(async (env) => {
      const existingTrauma: TraumaEntry = {
        id: "trauma-existing",
        severity: "CRITICAL",
        pattern: "old pattern",
        scope: "global",
        status: "active",
        trigger_event: {
          session_path: "/sessions/old.jsonl",
          timestamp: new Date().toISOString()
        },
        created_at: new Date().toISOString()
      };

      await writeFile(
        join(env.cassMemoryDir, "traumas.jsonl"),
        JSON.stringify(existingTrauma) + "\n"
      );

      const newTrauma: TraumaEntry = {
        id: "trauma-new",
        severity: "FATAL",
        pattern: "new pattern",
        scope: "global",
        status: "active",
        trigger_event: {
          session_path: "/sessions/new.jsonl",
          timestamp: new Date().toISOString()
        },
        created_at: new Date().toISOString()
      };

      await saveTrauma(newTrauma);

      const content = await readFile(join(env.cassMemoryDir, "traumas.jsonl"), "utf-8");
      const lines = content.trim().split("\n");
      expect(lines.length).toBe(2);

      const saved1 = JSON.parse(lines[0]);
      const saved2 = JSON.parse(lines[1]);
      expect(saved1.id).toBe("trauma-existing");
      expect(saved2.id).toBe("trauma-new");
    });
  });

  it("saves project-scoped trauma to project file", async () => {
    await withTempDir("trauma-project", async (tempDir) => {
      // Create a mock repo with .cass directory
      const repoDir = join(tempDir, "my-project");
      const cassDir = join(repoDir, ".cass");
      await mkdir(cassDir, { recursive: true });

      // Also create .git to make it look like a repo
      await mkdir(join(repoDir, ".git"), { recursive: true });

      const trauma: TraumaEntry = {
        id: "trauma-project-001",
        severity: "CRITICAL",
        pattern: "project-specific-danger",
        scope: "project",
        projectPath: repoDir,
        status: "active",
        trigger_event: {
          session_path: "/sessions/test.jsonl",
          timestamp: new Date().toISOString()
        },
        created_at: new Date().toISOString()
      };

      await saveTrauma(trauma);

      const content = await readFile(join(cassDir, "traumas.jsonl"), "utf-8");
      const savedTrauma = JSON.parse(content.trim());
      expect(savedTrauma.id).toBe("trauma-project-001");
      expect(savedTrauma.scope).toBe("project");
    });
  });

  it("creates directory if needed for project trauma", async () => {
    await withTempDir("trauma-mkdir", async (tempDir) => {
      const repoDir = join(tempDir, "new-project");
      // Note: .cass directory does NOT exist yet

      const trauma: TraumaEntry = {
        id: "trauma-mkdir-001",
        severity: "CRITICAL",
        pattern: "test",
        scope: "project",
        projectPath: repoDir,
        status: "active",
        trigger_event: {
          session_path: "/sessions/test.jsonl",
          timestamp: new Date().toISOString()
        },
        created_at: new Date().toISOString()
      };

      await saveTrauma(trauma);

      // Should have created .cass directory
      const content = await readFile(join(repoDir, ".cass", "traumas.jsonl"), "utf-8");
      expect(content).toContain("trauma-mkdir-001");
    });
  });
});

// =============================================================================
// findMatchingTrauma - Pattern matching
// =============================================================================
describe("findMatchingTrauma - Pattern matching", () => {
  const createTestTrauma = (id: string, pattern: string, status: "active" | "healed" = "active"): TraumaEntry => ({
    id,
    severity: "CRITICAL",
    pattern,
    scope: "global",
    status,
    trigger_event: {
      session_path: "/sessions/test.jsonl",
      timestamp: new Date().toISOString()
    },
    created_at: new Date().toISOString()
  });

  it("returns null when no traumas match", () => {
    const traumas = [
      createTestTrauma("t1", "rm -rf /"),
      createTestTrauma("t2", "DROP DATABASE")
    ];

    const result = findMatchingTrauma("git status", traumas);
    expect(result).toBeNull();
  });

  it("returns matching trauma for exact pattern", () => {
    const traumas = [
      createTestTrauma("t1", "rm -rf"),
      createTestTrauma("t2", "DROP DATABASE")
    ];

    const result = findMatchingTrauma("rm -rf /home/user", traumas);
    expect(result).not.toBeNull();
    expect(result?.id).toBe("t1");
  });

  it("matches case-insensitively", () => {
    const traumas = [
      createTestTrauma("t1", "DROP DATABASE")
    ];

    const result = findMatchingTrauma("drop database production", traumas);
    expect(result).not.toBeNull();
    expect(result?.id).toBe("t1");
  });

  it("ignores healed traumas", () => {
    const traumas = [
      createTestTrauma("t1", "rm -rf", "healed"),
      createTestTrauma("t2", "DROP DATABASE", "active")
    ];

    const result = findMatchingTrauma("rm -rf /home", traumas);
    expect(result).toBeNull();

    const result2 = findMatchingTrauma("DROP DATABASE test", traumas);
    expect(result2?.id).toBe("t2");
  });

  it("returns first matching trauma when multiple match", () => {
    const traumas = [
      createTestTrauma("t1", "rm"),
      createTestTrauma("t2", "rm -rf"),
      createTestTrauma("t3", "rm.*-rf")
    ];

    const result = findMatchingTrauma("rm -rf /", traumas);
    expect(result).not.toBeNull();
    expect(result?.id).toBe("t1"); // First match wins
  });

  it("handles regex patterns", () => {
    const traumas = [
      createTestTrauma("t1", "git\\s+push\\s+.*--force")
    ];

    const result = findMatchingTrauma("git push origin main --force", traumas);
    expect(result).not.toBeNull();

    const result2 = findMatchingTrauma("git push origin main", traumas);
    expect(result2).toBeNull();
  });

  it("handles invalid regex patterns gracefully", () => {
    const traumas = [
      createTestTrauma("t1", "[invalid(regex"),
      createTestTrauma("t2", "valid-pattern")
    ];

    // Should not throw, should skip invalid pattern
    const result = findMatchingTrauma("valid-pattern-test", traumas);
    expect(result?.id).toBe("t2");
  });

  it("returns null for empty trauma list", () => {
    const result = findMatchingTrauma("rm -rf /", []);
    expect(result).toBeNull();
  });
});

// =============================================================================
// setTraumaStatusById / healTraumaById - Status updates
// =============================================================================
describe("setTraumaStatusById - Status updates", () => {
  it("updates trauma status in global file", async () => {
    await withTempCassHome(async (env) => {
      const trauma: TraumaEntry = {
        id: "trauma-to-heal",
        severity: "CRITICAL",
        pattern: "test",
        scope: "global",
        status: "active",
        trigger_event: {
          session_path: "/sessions/test.jsonl",
          timestamp: new Date().toISOString()
        },
        created_at: new Date().toISOString()
      };

      await writeFile(
        join(env.cassMemoryDir, "traumas.jsonl"),
        JSON.stringify(trauma) + "\n"
      );

      const result = await setTraumaStatusById("trauma-to-heal", "healed");
      expect(result.updated).toBe(1);

      const content = await readFile(join(env.cassMemoryDir, "traumas.jsonl"), "utf-8");
      const updated = JSON.parse(content.trim());
      expect(updated.status).toBe("healed");
    });
  });

  it("healTraumaById convenience function works", async () => {
    await withTempCassHome(async (env) => {
      const trauma: TraumaEntry = {
        id: "trauma-heal-test",
        severity: "CRITICAL",
        pattern: "test",
        scope: "global",
        status: "active",
        trigger_event: {
          session_path: "/sessions/test.jsonl",
          timestamp: new Date().toISOString()
        },
        created_at: new Date().toISOString()
      };

      await writeFile(
        join(env.cassMemoryDir, "traumas.jsonl"),
        JSON.stringify(trauma) + "\n"
      );

      const result = await healTraumaById("trauma-heal-test");
      expect(result.updated).toBe(1);

      const traumas = await loadTraumas();
      expect(traumas[0].status).toBe("healed");
    });
  });

  it("returns 0 when trauma not found", async () => {
    await withTempCassHome(async (env) => {
      const trauma: TraumaEntry = {
        id: "some-other-trauma",
        severity: "CRITICAL",
        pattern: "test",
        scope: "global",
        status: "active",
        trigger_event: {
          session_path: "/sessions/test.jsonl",
          timestamp: new Date().toISOString()
        },
        created_at: new Date().toISOString()
      };

      await writeFile(
        join(env.cassMemoryDir, "traumas.jsonl"),
        JSON.stringify(trauma) + "\n"
      );

      const result = await setTraumaStatusById("nonexistent-id", "healed");
      expect(result.updated).toBe(0);
    });
  });

  it("respects scope option", async () => {
    await withTempCassHome(async (env) => {
      const trauma: TraumaEntry = {
        id: "global-trauma",
        severity: "CRITICAL",
        pattern: "test",
        scope: "global",
        status: "active",
        trigger_event: {
          session_path: "/sessions/test.jsonl",
          timestamp: new Date().toISOString()
        },
        created_at: new Date().toISOString()
      };

      await writeFile(
        join(env.cassMemoryDir, "traumas.jsonl"),
        JSON.stringify(trauma) + "\n"
      );

      // Try to update with project scope only - should not find it
      const result = await setTraumaStatusById("global-trauma", "healed", { scope: "project" });
      expect(result.updated).toBe(0);

      // With global scope - should find it
      const result2 = await setTraumaStatusById("global-trauma", "healed", { scope: "global" });
      expect(result2.updated).toBe(1);
    });
  });
});

// =============================================================================
// removeTraumaById - Removal
// =============================================================================
describe("removeTraumaById - Removal", () => {
  it("removes trauma from global file", async () => {
    await withTempCassHome(async (env) => {
      const trauma1: TraumaEntry = {
        id: "keep-this",
        severity: "CRITICAL",
        pattern: "test1",
        scope: "global",
        status: "active",
        trigger_event: {
          session_path: "/sessions/test.jsonl",
          timestamp: new Date().toISOString()
        },
        created_at: new Date().toISOString()
      };

      const trauma2: TraumaEntry = {
        id: "remove-this",
        severity: "FATAL",
        pattern: "test2",
        scope: "global",
        status: "active",
        trigger_event: {
          session_path: "/sessions/test.jsonl",
          timestamp: new Date().toISOString()
        },
        created_at: new Date().toISOString()
      };

      await writeFile(
        join(env.cassMemoryDir, "traumas.jsonl"),
        JSON.stringify(trauma1) + "\n" + JSON.stringify(trauma2) + "\n"
      );

      const result = await removeTraumaById("remove-this");
      expect(result.removed).toBe(1);

      const traumas = await loadTraumas();
      expect(traumas.length).toBe(1);
      expect(traumas[0].id).toBe("keep-this");
    });
  });

  it("returns 0 when trauma not found", async () => {
    await withTempCassHome(async (env) => {
      const trauma: TraumaEntry = {
        id: "existing",
        severity: "CRITICAL",
        pattern: "test",
        scope: "global",
        status: "active",
        trigger_event: {
          session_path: "/sessions/test.jsonl",
          timestamp: new Date().toISOString()
        },
        created_at: new Date().toISOString()
      };

      await writeFile(
        join(env.cassMemoryDir, "traumas.jsonl"),
        JSON.stringify(trauma) + "\n"
      );

      const result = await removeTraumaById("nonexistent");
      expect(result.removed).toBe(0);

      // Original should still exist
      const traumas = await loadTraumas();
      expect(traumas.length).toBe(1);
    });
  });

  it("handles removing last trauma (results in empty file)", async () => {
    await withTempCassHome(async (env) => {
      const trauma: TraumaEntry = {
        id: "only-one",
        severity: "CRITICAL",
        pattern: "test",
        scope: "global",
        status: "active",
        trigger_event: {
          session_path: "/sessions/test.jsonl",
          timestamp: new Date().toISOString()
        },
        created_at: new Date().toISOString()
      };

      await writeFile(
        join(env.cassMemoryDir, "traumas.jsonl"),
        JSON.stringify(trauma) + "\n"
      );

      const result = await removeTraumaById("only-one");
      expect(result.removed).toBe(1);

      const traumas = await loadTraumas();
      expect(traumas.length).toBe(0);
    });
  });
});

// =============================================================================
// scanForTraumas - Cass history scanning
// =============================================================================
describe("scanForTraumas - Cass history scanning", () => {
  it("scans cass for sessions with apologies and dangerous commands", async () => {
    // Create a cass runner stub that returns sessions with apologies
    const searchResults = JSON.stringify({
      count: 1,
      hits: [
        {
          source_path: "/sessions/bad-day.jsonl",
          line_number: 42,
          agent: "claude",
          snippet: "I'm sorry, I made a terrible mistake",
          score: 0.95
        }
      ]
    });

    // The export will return session content with a dangerous command
    // NOTE: DOOM_PATTERNS use ^ anchor so commands must be at line start
    const sessionContent = `
User: Please delete the old data
Assistant: Executing command:
rm -rf /var/data
[error occurred]
I'm so sorry, I made a mistake. The data is gone.
`;

    const runner = createCassRunnerStub({
      searchOutput: searchResults,
      exportOutput: sessionContent
    });

    const config = createTestConfig();

    const candidates = await scanForTraumas(config, 30, runner);

    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates[0].sessionPath).toBe("/sessions/bad-day.jsonl");
    expect(candidates[0].evidence).toContain("rm -rf");
  });

  it("returns empty array when no matches found", async () => {
    const runner = createCassRunnerStub({
      searchOutput: JSON.stringify({ count: 0, hits: [] }),
      exportOutput: "Normal session with no issues"
    });

    const config = createTestConfig();

    const candidates = await scanForTraumas(config, 30, runner);
    expect(candidates).toEqual([]);
  });

  it("handles cass errors gracefully", async () => {
    // Create a runner that returns valid search but empty export
    const searchResults = JSON.stringify({
      count: 1,
      hits: [
        {
          source_path: "/sessions/test.jsonl",
          line_number: 1,
          agent: "claude",
          snippet: "sorry",
          score: 0.9
        }
      ]
    });

    const runner = createCassRunnerStub({
      searchOutput: searchResults,
      exportOutput: "" // Empty export simulates no dangerous content
    });

    const config = createTestConfig();

    // Should not throw
    const candidates = await scanForTraumas(config, 30, runner);
    expect(Array.isArray(candidates)).toBe(true);
  });

  it("detects multiple DOOM patterns in session", async () => {
    const searchResults = JSON.stringify({
      count: 1,
      hits: [
        {
          source_path: "/sessions/disaster.jsonl",
          line_number: 1,
          agent: "claude",
          snippet: "I apologize for the disaster",
          score: 0.99
        }
      ]
    });

    // NOTE: DOOM_PATTERNS use ^ anchor - commands must be at line start
    const sessionContent = `
User: Clean up everything
Assistant: Executing the following commands:
rm -rf /var/data
DROP DATABASE production
git push --force origin main
I'm so sorry for this disaster.
`;

    const runner = createCassRunnerStub({
      searchOutput: searchResults,
      exportOutput: sessionContent
    });

    const config = createTestConfig();

    const candidates = await scanForTraumas(config, 30, runner);

    // Should find multiple dangerous patterns
    expect(candidates.length).toBeGreaterThanOrEqual(3);

    const evidences = candidates.map(c => c.evidence);
    expect(evidences.some(e => e.includes("rm -rf"))).toBe(true);
    expect(evidences.some(e => e.includes("DROP DATABASE"))).toBe(true);
    expect(evidences.some(e => e.includes("--force"))).toBe(true);
  });
});

// =============================================================================
// Edge Cases
// =============================================================================
describe("Edge Cases", () => {
  it("handles concurrent saves with locking", async () => {
    await withTempCassHome(async (env) => {
      const traumas: TraumaEntry[] = Array.from({ length: 5 }, (_, i) => ({
        id: `concurrent-${i}`,
        severity: "CRITICAL" as const,
        pattern: `pattern-${i}`,
        scope: "global" as const,
        status: "active" as const,
        trigger_event: {
          session_path: `/sessions/s${i}.jsonl`,
          timestamp: new Date().toISOString()
        },
        created_at: new Date().toISOString()
      }));

      // Save all concurrently
      await Promise.all(traumas.map(t => saveTrauma(t)));

      const loaded = await loadTraumas();
      expect(loaded.length).toBe(5);

      // All IDs should be present
      const ids = loaded.map(t => t.id).sort();
      expect(ids).toEqual(["concurrent-0", "concurrent-1", "concurrent-2", "concurrent-3", "concurrent-4"]);
    });
  });

  it("handles special characters in pattern", async () => {
    await withTempCassHome(async (env) => {
      const trauma: TraumaEntry = {
        id: "special-chars",
        severity: "CRITICAL",
        pattern: "rm\\s+-rf\\s+/\\w+",
        scope: "global",
        status: "active",
        trigger_event: {
          session_path: "/sessions/test.jsonl",
          timestamp: new Date().toISOString()
        },
        created_at: new Date().toISOString()
      };

      await saveTrauma(trauma);

      const loaded = await loadTraumas();
      expect(loaded[0].pattern).toBe("rm\\s+-rf\\s+/\\w+");

      // Should still match correctly
      const match = findMatchingTrauma("rm -rf /home", loaded);
      expect(match).not.toBeNull();
    });
  });

  it("preserves non-JSON lines in file during update", async () => {
    await withTempCassHome(async (env) => {
      const trauma: TraumaEntry = {
        id: "preserve-test",
        severity: "CRITICAL",
        pattern: "test",
        scope: "global",
        status: "active",
        trigger_event: {
          session_path: "/sessions/test.jsonl",
          timestamp: new Date().toISOString()
        },
        created_at: new Date().toISOString()
      };

      // Write file with a comment line (defensive - file shouldn't have this but be safe)
      const content = "# This is a comment\n" + JSON.stringify(trauma) + "\n";
      await writeFile(join(env.cassMemoryDir, "traumas.jsonl"), content);

      await setTraumaStatusById("preserve-test", "healed");

      const updatedContent = await readFile(join(env.cassMemoryDir, "traumas.jsonl"), "utf-8");
      expect(updatedContent).toContain("# This is a comment");
      expect(updatedContent).toContain('"healed"');
    });
  });

  it("handles Windows line endings", async () => {
    await withTempCassHome(async (env) => {
      const trauma: TraumaEntry = {
        id: "windows-test",
        severity: "CRITICAL",
        pattern: "test",
        scope: "global",
        status: "active",
        trigger_event: {
          session_path: "/sessions/test.jsonl",
          timestamp: new Date().toISOString()
        },
        created_at: new Date().toISOString()
      };

      // Write with Windows line endings
      const content = JSON.stringify(trauma) + "\r\n";
      await writeFile(join(env.cassMemoryDir, "traumas.jsonl"), content);

      const loaded = await loadTraumas();
      expect(loaded.length).toBe(1);
      expect(loaded[0].id).toBe("windows-test");
    });
  });

  it("handles unicode in trauma pattern and messages", async () => {
    await withTempCassHome(async (env) => {
      const trauma: TraumaEntry = {
        id: "unicode-test",
        severity: "CRITICAL",
        pattern: "删除.*数据库",
        scope: "global",
        status: "active",
        trigger_event: {
          session_path: "/sessions/test.jsonl",
          timestamp: new Date().toISOString(),
          human_message: "永远不要这样做！🔥"
        },
        created_at: new Date().toISOString()
      };

      await saveTrauma(trauma);

      const loaded = await loadTraumas();
      expect(loaded[0].pattern).toBe("删除.*数据库");
      expect(loaded[0].trigger_event.human_message).toBe("永远不要这样做！🔥");

      // Pattern should still work
      const match = findMatchingTrauma("删除所有数据库", loaded);
      expect(match).not.toBeNull();
    });
  });
});
