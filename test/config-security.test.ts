import { describe, it, expect, mock, beforeAll, afterAll } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { loadConfig, DEFAULT_CONFIG } from "../src/config.js";

// Mock utilities
const mockExpandPath = mock((p: string) => {
    if (p.startsWith("~")) return path.join(os.tmpdir(), "cass-test", p.slice(1));
    return p;
});

// We need to mock the file system module calls inside config.ts
// But bun:test mocks are a bit limited for esm modules without module mocking.
// Instead, we will use real files in a temp directory and manipulate process.cwd()

const TEMP_DIR = path.join(os.tmpdir(), "cass-config-test-" + Date.now());
const HOME_DIR = path.join(TEMP_DIR, "home");
const REPO_DIR = path.join(TEMP_DIR, "repo");

// Mock process.env.HOME
const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_CWD = process.cwd();

describe("config security", () => {
    beforeAll(async () => {
        await fs.mkdir(HOME_DIR, { recursive: true });
        await fs.mkdir(REPO_DIR, { recursive: true });
        await fs.mkdir(path.join(HOME_DIR, ".cass-memory"), { recursive: true });
        
        process.env.HOME = HOME_DIR;
        process.chdir(REPO_DIR);
        
        // Setup git repo simulation
        await fs.mkdir(path.join(REPO_DIR, ".git"), { recursive: true });
        await fs.mkdir(path.join(REPO_DIR, ".cass"), { recursive: true });
    });

    afterAll(async () => {
        process.env.HOME = ORIGINAL_HOME;
        process.chdir(ORIGINAL_CWD);
        await fs.rm(TEMP_DIR, { recursive: true, force: true });
    });

    it("prevents repo config from overriding cassPath", async () => {
        // 1. Create global config
        const globalConfig = {
            cassPath: "/usr/bin/safe-cass",
            model: "global-model"
        };
        await fs.writeFile(
            path.join(HOME_DIR, ".cass-memory", "config.json"), 
            JSON.stringify(globalConfig)
        );

        // 2. Create malicious repo config
        const maliciousConfig = {
            cassPath: "/tmp/malicious-script.sh",
            model: "repo-model"
        };
        await fs.writeFile(
            path.join(REPO_DIR, ".cass", "config.yaml"), 
            "cassPath: /tmp/malicious-script.sh\nmodel: repo-model"
        );

        // 3. Load config
        // Note: We need to stub expandPath logic or rely on the real one using our faked HOME
        // The real expandPath uses os.homedir() which usually reads $HOME, but let's check
        // src/utils.ts uses os.homedir(). In Bun, modifying process.env.HOME might not affect os.homedir() depending on OS.
        // However, let's assume it works or modify the test expectation if it fails.
        
        // We also need to mock `execAsync("git rev-parse...")` to return our REPO_DIR
        // Since we can't easily mock internal exec calls in integration test, 
        // we rely on the fact that we created .git directory and are in it.
        // But `src/config.ts` calls `git rev-parse --show-toplevel`.
        // If git is not installed or we are not in a real git repo, it fails.
        // We are in a fake .git dir, but `git` command checks for real repo.
        // We'll initialize a real git repo in the temp dir.
        
        const { execSync } = await import("node:child_process");
        try {
            execSync("git init", { cwd: REPO_DIR });
        } catch (e) {
            console.warn("Git init failed, skipping git parts of test: " + e);
        }

        const config = await loadConfig();

        // 4. Assertions
        // cassPath should be from global (safe) or default, NOT repo
        expect(config.cassPath).toBe("/usr/bin/safe-cass");
        // model should be from repo (allowed override)
        expect(config.model).toBe("repo-model");
    });

    it("prevents repo config from overriding playbookPath and diaryDir", async () => {
        // No global config written; defaults should remain in effect for sensitive paths
        const maliciousConfig = [
            "playbookPath: /tmp/malicious-playbook.yaml",
            "diaryDir: /tmp/malicious-diary",
            "provider: openai"
        ].join("\n");
        await fs.writeFile(
            path.join(REPO_DIR, ".cass", "config.yaml"),
            maliciousConfig
        );

        const { execSync } = await import("node:child_process");
        try {
            execSync("git init", { cwd: REPO_DIR, stdio: "ignore" });
        } catch { /* ignore git init failure */ }

        const config = await loadConfig();
        expect(config.playbookPath).toBe(DEFAULT_CONFIG.playbookPath);
        expect(config.diaryDir).toBe(DEFAULT_CONFIG.diaryDir);
        // allowed override still applies
        expect(config.provider).toBe("openai");
    });
});
