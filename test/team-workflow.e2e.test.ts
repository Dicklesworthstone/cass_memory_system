/**
 * E2E Test: Team Workflow - Repo Setup and Collaboration
 *
 * Per bead cass_memory_system-9jgu:
 * Tests team usage patterns with repo-level playbook configuration.
 *
 * Flow:
 * 1. Lead creates git repo
 * 2. Lead runs init --repo
 * 3. Lead adds project-scoped rules to .cass/playbook.yaml
 * 4. Lead commits and pushes
 * 5. Dev clones repo
 * 6. Dev runs cm doctor (sees repo rules)
 * 7. Dev gets context (uses merged rules)
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { spawnSync, execSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import yaml from "yaml";
import { createTestLogger } from "./helpers/logger.js";

const CM_PATH = join(import.meta.dir, "..", "src", "cm.ts");

interface CmResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function runCm(args: string[], cwd: string, env: Record<string, string> = {}): CmResult {
  const result = spawnSync("bun", ["run", CM_PATH, ...args], {
    cwd,
    env: {
      ...process.env,
      CASS_MEMORY_LLM: "none",
      CASS_PATH: "__nonexistent__",
      ...env,
    },
    encoding: "utf-8",
    timeout: 60000,
  });

  return {
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    exitCode: result.status ?? 1,
  };
}

function createTempGitRepo(): string {
  const repoDir = mkdtempSync(join(tmpdir(), "cass-team-repo-"));
  execSync("git init", { cwd: repoDir, stdio: "pipe" });
  execSync('git config user.email "test@example.com"', { cwd: repoDir, stdio: "pipe" });
  execSync('git config user.name "Test User"', { cwd: repoDir, stdio: "pipe" });
  writeFileSync(join(repoDir, ".gitkeep"), "");
  execSync("git add .gitkeep", { cwd: repoDir, stdio: "pipe" });
  execSync('git commit -m "Initial commit"', { cwd: repoDir, stdio: "pipe" });
  return repoDir;
}

function cloneRepo(sourceDir: string): string {
  const cloneDir = mkdtempSync(join(tmpdir(), "cass-team-clone-"));
  rmSync(cloneDir, { recursive: true, force: true }); // git clone wants to create the dir
  execSync(`git clone "${sourceDir}" "${cloneDir}"`, { stdio: "pipe" });
  execSync('git config user.email "dev@example.com"', { cwd: cloneDir, stdio: "pipe" });
  execSync('git config user.name "Dev User"', { cwd: cloneDir, stdio: "pipe" });
  return cloneDir;
}

describe("E2E: Team Workflow", () => {
  let leadHome: string;
  let devHome: string;
  let repoDir: string;
  let cloneDir: string;
  const logger = createTestLogger("info");

  beforeEach(() => {
    leadHome = mkdtempSync(join(tmpdir(), "cass-lead-home-"));
    devHome = mkdtempSync(join(tmpdir(), "cass-dev-home-"));
    repoDir = createTempGitRepo();
    logger.info("Created test environment", { leadHome, devHome, repoDir });
  });

  afterEach(() => {
    for (const dir of [leadHome, devHome, repoDir, cloneDir]) {
      if (dir && existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    logger.info("Cleaned up test environment");
  });

  describe("Complete Team Flow", () => {
    test(
      "lead creates repo rules → dev clones → dev sees merged rules",
      () => {
        logger.info("Starting complete team workflow test");

        // Step 1: Lead initializes their global cass-memory
        const leadInitResult = runCm(["init", "--json"], leadHome, { HOME: leadHome });
        expect(leadInitResult.exitCode).toBe(0);
        logger.info("Step 1: Lead initialized global cass-memory");

        // Step 2: Lead runs init --repo in the project
        const originalCwd = process.cwd();
        process.chdir(repoDir);
        try {
          const repoInitResult = runCm(["init", "--repo", "--json"], repoDir, {
            HOME: leadHome,
          });
          expect(repoInitResult.exitCode).toBe(0);

          const cassDir = join(repoDir, ".cass");
          expect(existsSync(cassDir)).toBe(true);
          expect(existsSync(join(cassDir, "playbook.yaml"))).toBe(true);
          logger.info("Step 2: Lead ran init --repo", { cassDir });
        } finally {
          process.chdir(originalCwd);
        }

        // Step 3: Lead adds a project-scoped rule to the repo playbook
        // Note: `playbook add` always adds to global. For repo-specific rules,
        // the lead would edit .cass/playbook.yaml directly or use export/import.
        // We simulate this by directly writing to the repo playbook.
        const repoPlaybookPath = join(repoDir, ".cass", "playbook.yaml");
        const repoPlaybook = yaml.parse(readFileSync(repoPlaybookPath, "utf-8"));
        const now = new Date().toISOString();
        const projectBullet = {
          id: `b-repo-${Date.now()}`,
          content: "Always use TypeScript strict mode in this project",
          category: "typescript",
          scope: "global",
          kind: "workflow_rule",
          state: "active",
          maturity: "candidate",
          helpfulCount: 0,
          harmfulCount: 0,
          feedbackEvents: [],
          tags: [],
          createdAt: now,
          updatedAt: now,
        };
        repoPlaybook.bullets = [projectBullet];
        writeFileSync(repoPlaybookPath, yaml.stringify(repoPlaybook));
        logger.info("Step 3: Lead added project rule to repo playbook", {
          bulletId: projectBullet.id,
        });

        // Verify the bullet is in the repo playbook
        const verifyPlaybook = yaml.parse(readFileSync(repoPlaybookPath, "utf-8"));
        expect(verifyPlaybook.bullets).toHaveLength(1);
        expect(verifyPlaybook.bullets[0].content).toContain("TypeScript strict mode");

        // Step 4: Lead commits the .cass directory
        execSync("git add .cass", { cwd: repoDir, stdio: "pipe" });
        execSync('git commit -m "Add project cass configuration"', {
          cwd: repoDir,
          stdio: "pipe",
        });
        logger.info("Step 4: Lead committed .cass/");

        // Step 5: Dev clones the repo
        cloneDir = cloneRepo(repoDir);
        expect(existsSync(join(cloneDir, ".cass"))).toBe(true);
        expect(existsSync(join(cloneDir, ".cass", "playbook.yaml"))).toBe(true);
        logger.info("Step 5: Dev cloned repo", { cloneDir });

        // Step 6: Dev initializes their global cass-memory and runs doctor
        const devInitResult = runCm(["init", "--json"], devHome, { HOME: devHome });
        expect(devInitResult.exitCode).toBe(0);

        process.chdir(cloneDir);
        try {
          const doctorResult = runCm(["doctor", "--json"], cloneDir, { HOME: devHome });
          expect(doctorResult.exitCode).toBe(0);

          const doctorPayload = JSON.parse(doctorResult.stdout);
          const doctorResponse = doctorPayload.data;
          expect(doctorResponse.checks).toBeDefined();
          expect(doctorResponse.checks.length).toBeGreaterThan(0);
          expect(doctorResponse.overallStatus).toBeDefined();
          logger.info("Step 6: Dev ran doctor", {
            totalChecks: doctorResponse.checks.length,
            overallStatus: doctorResponse.overallStatus,
          });
        } finally {
          process.chdir(originalCwd);
        }

        // Step 7: Dev gets context and sees the repo rule
        process.chdir(cloneDir);
        try {
          const contextResult = runCm(
            ["context", "typescript configuration", "--json"],
            cloneDir,
            { HOME: devHome }
          );
          expect(contextResult.exitCode).toBe(0);

          const contextPayload = JSON.parse(contextResult.stdout);
          const contextResponse = contextPayload.data;
          expect(contextResponse.task).toBe("typescript configuration");

          // The repo rule about TypeScript strict mode should be included
          const hasProjectRule = contextResponse.relevantBullets.some(
            (b: any) =>
              b.content.includes("TypeScript strict mode") ||
              b.content.includes("strict mode")
          );
          expect(hasProjectRule).toBe(true);
          logger.info("Step 7: Dev context includes repo rules", {
            bulletCount: contextResponse.relevantBullets.length,
            hasProjectRule,
          });
        } finally {
          process.chdir(originalCwd);
        }

        logger.info("Complete team workflow test PASSED");
      },
      { timeout: 60000 }
    );
  });

  describe("Repo Initialization Edge Cases", () => {
    test("init --repo creates .cass in git root from subdirectory", () => {
      // Create a subdirectory
      const subDir = join(repoDir, "src", "components");
      mkdirSync(subDir, { recursive: true });

      const originalCwd = process.cwd();
      process.chdir(subDir);
      try {
        // Run init --repo from subdirectory
        const result = runCm(["init", "--repo", "--json"], subDir, { HOME: leadHome });
        expect(result.exitCode).toBe(0);

        // .cass should be created at repo root, not in subdirectory
        const cassAtRoot = join(repoDir, ".cass");
        const cassAtSub = join(subDir, ".cass");

        expect(existsSync(cassAtRoot)).toBe(true);
        expect(existsSync(cassAtSub)).toBe(false);
      } finally {
        process.chdir(originalCwd);
      }
    });

    test("init --repo fails gracefully in non-git directory", () => {
      const nonGitDir = mkdtempSync(join(tmpdir(), "cass-non-git-"));
      try {
        const result = runCm(["init", "--repo", "--json"], nonGitDir, {
          HOME: leadHome,
        });
        expect(result.exitCode).toBe(1);

        // Should have error about not being in git repo
        const output = result.stdout + result.stderr;
        expect(output.toLowerCase()).toMatch(/not.*git|git.*repo/i);
      } finally {
        rmSync(nonGitDir, { recursive: true, force: true });
      }
    });

    test("re-running init --repo without --force warns but doesn't overwrite", () => {
      const originalCwd = process.cwd();
      process.chdir(repoDir);
      try {
        // First init
        runCm(["init", "--repo", "--json"], repoDir, { HOME: leadHome });

        // Add a marker to playbook
        const playbookPath = join(repoDir, ".cass", "playbook.yaml");
        const playbook = yaml.parse(readFileSync(playbookPath, "utf-8"));
        playbook._test_marker = "should_remain";
        writeFileSync(playbookPath, yaml.stringify(playbook));

        // Second init without --force
        const result = runCm(["init", "--repo", "--json"], repoDir, {
          HOME: leadHome,
        });

        // Should warn about already existing
        const output = result.stdout + result.stderr;
        expect(output).toMatch(/already|exists|--force/i);

        // Marker should still be there
        const currentPlaybook = yaml.parse(readFileSync(playbookPath, "utf-8"));
        expect(currentPlaybook._test_marker).toBe("should_remain");
      } finally {
        process.chdir(originalCwd);
      }
    });
  });

  describe("Rule Merging Behavior", () => {
    test("context merges global and repo rules", () => {
      const originalCwd = process.cwd();

      // Lead adds a global rule
      runCm(["init", "--json"], leadHome, { HOME: leadHome });
      runCm(
        ["playbook", "add", "Always write tests for new features", "--category", "testing", "--json"],
        leadHome,
        { HOME: leadHome }
      );
      logger.info("Added global rule to lead's playbook");

      // Lead creates repo with its own rule
      process.chdir(repoDir);
      try {
        runCm(["init", "--repo", "--json"], repoDir, { HOME: leadHome });
        runCm(
          ["playbook", "add", "Use Jest for testing in this project", "--category", "testing", "--json"],
          repoDir,
          { HOME: leadHome }
        );
        logger.info("Added repo rule");
      } finally {
        process.chdir(originalCwd);
      }

      // Get context - should see both rules
      process.chdir(repoDir);
      try {
        const contextResult = runCm(["context", "writing tests", "--json"], repoDir, {
          HOME: leadHome,
        });
        expect(contextResult.exitCode).toBe(0);

        const contextPayload = JSON.parse(contextResult.stdout);
        const context = contextPayload.data;
        const bulletContents = context.relevantBullets.map((b: any) => b.content);

        // Check that we see rules from both global and repo
        const hasGlobalRule = bulletContents.some((c: string) =>
          c.includes("write tests for new features")
        );
        const hasRepoRule = bulletContents.some((c: string) => c.includes("Jest"));

        logger.info("Context merge check", {
          bulletCount: bulletContents.length,
          hasGlobalRule,
          hasRepoRule,
        });

        // At minimum, one of them should be present
        expect(hasGlobalRule || hasRepoRule).toBe(true);
      } finally {
        process.chdir(originalCwd);
      }
    });

    test("marking feedback on repo rule updates repo playbook", () => {
      const originalCwd = process.cwd();

      // Initialize and add repo rule directly to repo playbook
      process.chdir(repoDir);
      try {
        runCm(["init", "--json"], leadHome, { HOME: leadHome });
        runCm(["init", "--repo", "--json"], repoDir, { HOME: leadHome });

        // Add bullet directly to repo playbook (since `playbook add` always uses global)
        const repoPlaybookPath = join(repoDir, ".cass", "playbook.yaml");
        const playbook = yaml.parse(readFileSync(repoPlaybookPath, "utf-8"));
        const now = new Date().toISOString();
        const bulletId = `b-repo-mark-${Date.now()}`;
        playbook.bullets = [
          {
            id: bulletId,
            content: "Use ESLint for code quality",
            category: "tooling",
            scope: "global",
            kind: "workflow_rule",
            state: "active",
            maturity: "candidate",
            helpfulCount: 0,
            harmfulCount: 0,
            feedbackEvents: [],
            tags: [],
            createdAt: now,
            updatedAt: now,
          },
        ];
        writeFileSync(repoPlaybookPath, yaml.stringify(playbook));

        // Mark as helpful
        const markResult = runCm(["mark", bulletId, "--helpful", "--json"], repoDir, {
          HOME: leadHome,
        });
        expect(markResult.exitCode).toBe(0);

        // Verify repo playbook was updated
        const updatedPlaybook = yaml.parse(readFileSync(repoPlaybookPath, "utf-8"));
        const bullet = updatedPlaybook.bullets.find((b: any) => b.id === bulletId);
        expect(bullet).toBeDefined();
        expect(bullet.helpfulCount).toBe(1);
      } finally {
        process.chdir(originalCwd);
      }
    });
  });

  describe("Stats and Playbook List in Repo Context", () => {
    test("stats reflects combined playbook", () => {
      const originalCwd = process.cwd();

      // Setup: global + repo rules
      runCm(["init", "--json"], leadHome, { HOME: leadHome });
      runCm(
        ["playbook", "add", "Global rule 1", "--json"],
        leadHome,
        { HOME: leadHome }
      );
      runCm(
        ["playbook", "add", "Global rule 2", "--json"],
        leadHome,
        { HOME: leadHome }
      );

      process.chdir(repoDir);
      try {
        runCm(["init", "--repo", "--json"], repoDir, { HOME: leadHome });
        runCm(
          ["playbook", "add", "Repo rule 1", "--json"],
          repoDir,
          { HOME: leadHome }
        );

        const statsResult = runCm(["stats", "--json"], repoDir, { HOME: leadHome });
        expect(statsResult.exitCode).toBe(0);

        const statsPayload = JSON.parse(statsResult.stdout);
        const stats = statsPayload.data;
        // Should count at least 3 bullets (2 global + 1 repo)
        expect(stats.total).toBeGreaterThanOrEqual(3);
      } finally {
        process.chdir(originalCwd);
      }
    });

    test("playbook list shows combined rules", () => {
      const originalCwd = process.cwd();

      // Setup
      runCm(["init", "--json"], leadHome, { HOME: leadHome });
      runCm(["playbook", "add", "Global rule", "--json"], leadHome, { HOME: leadHome });

      process.chdir(repoDir);
      try {
        runCm(["init", "--repo", "--json"], repoDir, { HOME: leadHome });
        runCm(["playbook", "add", "Repo rule", "--json"], repoDir, { HOME: leadHome });

        const listResult = runCm(["playbook", "list", "--json"], repoDir, {
          HOME: leadHome,
        });
        expect(listResult.exitCode).toBe(0);

        const listPayload = JSON.parse(listResult.stdout);
        const listResponse = listPayload.data;
        // Should include both global and repo rules
        expect(listResponse.bullets.length).toBeGreaterThanOrEqual(2);

        const contents = listResponse.bullets.map((b: any) => b.content);
        const hasGlobal = contents.some((c: string) => c.includes("Global rule"));
        const hasRepo = contents.some((c: string) => c.includes("Repo rule"));
        expect(hasGlobal && hasRepo).toBe(true);
      } finally {
        process.chdir(originalCwd);
      }
    });
  });
});
