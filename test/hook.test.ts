/**
 * Tests for `cm hook` -- SessionEnd auto-reflection.
 */
import { describe, expect, it } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  decideSessionEnd,
  HOOK_ACTIVE_ENV,
  hookCommand,
  removeSessionEndHook,
  SESSION_END_HOOK_ARGS,
  upsertSessionEndHook,
} from "../src/commands/hook.js";
import { resolveCliSubprocessCwd, slugifyProjectDir } from "../src/subprocess-tag.js";
import { withTempCassHome } from "./helpers/temp.js";

const CMD = `cm ${SESSION_END_HOOK_ARGS}`;

function captureConsole() {
  const logs: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args: any[]) => logs.push(args.map(String).join(" "));
  console.error = () => {};
  return {
    logs,
    restore: () => {
      console.log = originalLog;
      console.error = originalError;
    },
  };
}

async function inDir<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const original = process.cwd();
  process.chdir(dir);
  try {
    return await fn();
  } finally {
    process.chdir(original);
  }
}

describe("upsertSessionEndHook / removeSessionEndHook", () => {
  it("adds the hook to empty settings", () => {
    const settings: Record<string, any> = {};
    expect(upsertSessionEndHook(settings, CMD)).toBe(false);
    expect(settings.hooks.SessionEnd).toEqual([{ hooks: [{ type: "command", command: CMD }] }]);
  });

  it("is idempotent and preserves other hooks", () => {
    const other = { hooks: [{ type: "command", command: "notify-send done" }] };
    const settings: Record<string, any> = {
      model: "x",
      hooks: { SessionEnd: [other], PreToolUse: [{ matcher: "Bash", hooks: [] }] },
    };
    upsertSessionEndHook(settings, CMD);
    expect(upsertSessionEndHook(settings, `/abs/cm ${SESSION_END_HOOK_ARGS}`)).toBe(true);
    expect(settings.hooks.SessionEnd).toHaveLength(2);
    expect(settings.hooks.SessionEnd[0]).toEqual(other);
    expect(settings.hooks.SessionEnd[1].hooks[0].command).toBe(`/abs/cm ${SESSION_END_HOOK_ARGS}`);
    expect(settings.hooks.PreToolUse).toHaveLength(1);
    expect(settings.model).toBe("x");
  });

  it("removes only cm's entry and cleans up empty containers", () => {
    const other = { hooks: [{ type: "command", command: "notify-send done" }] };
    const settings: Record<string, any> = { hooks: { SessionEnd: [other] } };
    upsertSessionEndHook(settings, CMD);
    expect(removeSessionEndHook(settings)).toBe(true);
    expect(settings.hooks.SessionEnd).toEqual([other]);
    const onlyCm: Record<string, any> = {};
    upsertSessionEndHook(onlyCm, CMD);
    expect(removeSessionEndHook(onlyCm)).toBe(true);
    expect(onlyCm).toEqual({});
    expect(removeSessionEndHook({})).toBe(false);
  });
});

describe("decideSessionEnd", () => {
  it("reflects an existing transcript", async () => {
    await withTempCassHome(async (env) => {
      const t = path.join(env.home, "s.jsonl");
      await writeFile(t, "{}\n");
      const d = await decideSessionEnd({ transcript_path: t, cwd: env.home }, { env: {} });
      expect(d.action).toBe("reflect");
      expect(d.transcriptPath).toBe(t);
      expect(d.cwd).toBe(env.home);
    });
  });

  it("skips inside a background reflect (loop guard)", async () => {
    const d = await decideSessionEnd(
      { transcript_path: "/tmp/x.jsonl" },
      { env: { [HOOK_ACTIVE_ENV]: "1" } },
    );
    expect(d.action).toBe("skip");
  });

  it("skips cm's own LLM subprocess transcripts", async () => {
    await withTempCassHome(async (env) => {
      const slug = slugifyProjectDir(resolveCliSubprocessCwd()!);
      const dir = path.join(env.home, ".claude", "projects", slug);
      await mkdir(dir, { recursive: true });
      const t = path.join(dir, "s.jsonl");
      await writeFile(t, "{}\n");
      const d = await decideSessionEnd({ transcript_path: t }, { env: {} });
      expect(d.action).toBe("skip");
      expect(d.reason).toContain("subprocess");
    });
  });

  it("skips missing or absent transcripts", async () => {
    expect((await decideSessionEnd({}, { env: {} })).action).toBe("skip");
    expect((await decideSessionEnd({ transcript_path: 42 }, { env: {} })).action).toBe("skip");
    expect(
      (await decideSessionEnd({ transcript_path: "/nonexistent/s.jsonl" }, { env: {} })).action,
    ).toBe("skip");
  });
});

describe("cm hook install / status / uninstall", () => {
  it("round-trips through the project settings file without touching other keys", async () => {
    await withTempCassHome(async (env) => {
      const project = path.join(env.home, "proj");
      const settingsPath = path.join(project, ".claude", "settings.json");
      await mkdir(path.dirname(settingsPath), { recursive: true });
      await writeFile(settingsPath, JSON.stringify({ permissions: { allow: ["Bash(ls)"] } }));

      await inDir(project, async () => {
        let capture = captureConsole();
        try {
          await hookCommand("install", { json: true, command: CMD });
        } finally {
          capture.restore();
        }
        const installed = JSON.parse(capture.logs.join("\n"));
        expect(installed.data.installed).toBe(true);
        expect(await readFile(installed.data.settingsPath, "utf-8")).toContain(CMD);

        capture = captureConsole();
        try {
          await hookCommand("status", { json: true });
        } finally {
          capture.restore();
        }
        expect(JSON.parse(capture.logs.join("\n")).data.autoReflect).toBe(true);

        capture = captureConsole();
        try {
          await hookCommand("uninstall", { json: true });
        } finally {
          capture.restore();
        }
        expect(JSON.parse(capture.logs.join("\n")).data.removed).toBe(true);
      });

      const after = JSON.parse(await readFile(settingsPath, "utf-8"));
      expect(after).toEqual({ permissions: { allow: ["Bash(ls)"] } });
    });
  });

  it("refuses to overwrite an unparseable settings file", async () => {
    await withTempCassHome(async (env) => {
      const project = path.join(env.home, "proj2");
      const settingsPath = path.join(project, ".claude", "settings.json");
      await mkdir(path.dirname(settingsPath), { recursive: true });
      await writeFile(settingsPath, "{ // comments are not JSON\n}");
      await inDir(project, async () => {
        const capture = captureConsole();
        try {
          await hookCommand("install", { json: true, command: CMD });
        } finally {
          capture.restore();
        }
      });
      expect(await readFile(settingsPath, "utf-8")).toBe("{ // comments are not JSON\n}");
    });
  });

  it("session-end never throws, even with nothing to do", async () => {
    await withTempCassHome(async () => {
      const capture = captureConsole();
      try {
        await hookCommand("session-end", { json: true, transcript: "/nonexistent/s.jsonl" });
      } finally {
        capture.restore();
      }
      expect(JSON.parse(capture.logs.join("\n")).data.action).toBe("skip");
    });
  });
});

describe("cm hook human output and edge cases", () => {
  function captureAll() {
    const lines: string[] = [];
    const origLog = console.log;
    const origErr = console.error;
    console.log = (...a: any[]) => lines.push(a.map(String).join(" "));
    console.error = (...a: any[]) => lines.push(a.map(String).join(" "));
    return {
      text: () => lines.join("\n"),
      restore: () => {
        console.log = origLog;
        console.error = origErr;
      },
    };
  }

  it("install, status and uninstall print what they did", async () => {
    await withTempCassHome(async (env) => {
      const project = path.join(env.home, "proj-h");
      await mkdir(project, { recursive: true });
      await inDir(project, async () => {
        const cap = captureAll();
        try {
          await hookCommand("install", { command: CMD });
          await hookCommand("install", { command: CMD }); // second time: "Updated"
          await hookCommand("status", {});
          await hookCommand("uninstall", {});
          await hookCommand("uninstall", {}); // nothing left
          await hookCommand("status", {});
        } finally {
          cap.restore();
        }
        const out = cap.text();
        expect(out).toContain("Installed SessionEnd auto-reflect hook");
        expect(out).toContain("Updated SessionEnd auto-reflect hook");
        expect(out).toMatch(/project\s+installed/);
        expect(out).toContain("Removed the auto-reflect hook");
        expect(out).toContain("No cm auto-reflect hook");
        expect(out).toContain("hook install");
      });
    });
  });

  it("--global targets the user settings file", async () => {
    await withTempCassHome(async (env) => {
      const cap = captureConsole();
      try {
        await hookCommand("install", { json: true, global: true, command: CMD });
      } finally {
        cap.restore();
      }
      const data = JSON.parse(cap.logs.join("\n")).data;
      expect(data.scope).toBe("user");
      expect(data.settingsPath).toBe(path.join(env.home, ".claude", "settings.json"));
    });
  });

  it("uninstall refuses to touch an unparseable settings file", async () => {
    await withTempCassHome(async (env) => {
      const project = path.join(env.home, "proj-bad");
      const settingsPath = path.join(project, ".claude", "settings.json");
      await mkdir(path.dirname(settingsPath), { recursive: true });
      await writeFile(settingsPath, "not json");
      await inDir(project, async () => {
        const cap = captureConsole();
        try {
          await hookCommand("uninstall", { json: true });
        } finally {
          cap.restore();
        }
      });
      expect(await readFile(settingsPath, "utf-8")).toBe("not json");
    });
  });

  it("session-end skips a nested run and logs why", async () => {
    await withTempCassHome(async (env) => {
      const t = path.join(env.home, "s.jsonl");
      await writeFile(t, "{}\n");
      const prev = process.env[HOOK_ACTIVE_ENV];
      process.env[HOOK_ACTIVE_ENV] = "1";
      try {
        await hookCommand("session-end", { transcript: t });
      } finally {
        if (prev === undefined) delete process.env[HOOK_ACTIVE_ENV];
        else process.env[HOOK_ACTIVE_ENV] = prev;
      }
      const { hookLogPath } = await import("../src/commands/hook.js");
      expect(await readFile(hookLogPath(), "utf-8")).toContain("session-end skip: nested session");
    });
  });
});

describe("selfInvocation / defaultHookCommand", () => {
  it("re-invokes this cm and ends with the hook subcommand", async () => {
    const { selfInvocation, defaultHookCommand } = await import("../src/commands/hook.js");
    const argv = selfInvocation();
    expect(argv.length).toBeGreaterThanOrEqual(1);
    expect(defaultHookCommand().endsWith(SESSION_END_HOOK_ARGS)).toBe(true);
  });
});
