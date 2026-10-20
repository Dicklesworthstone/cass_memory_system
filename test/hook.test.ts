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
  resolveSettingsPath,
  SESSION_END_HOOK_ARGS,
  SESSION_END_HOOK_NAME,
  SESSION_END_HOOK_STATUS,
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

async function runHookJson(
  action: Parameters<typeof hookCommand>[0],
  flags: Parameters<typeof hookCommand>[1] = {},
) {
  const capture = captureConsole();
  try {
    await hookCommand(action, { ...flags, json: true });
  } finally {
    capture.restore();
  }
  return JSON.parse(capture.logs.join("\n"));
}

describe("upsertSessionEndHook / removeSessionEndHook", () => {
  it("adds the hook to empty settings", () => {
    const settings: Record<string, any> = {};
    expect(upsertSessionEndHook(settings, CMD)).toBe(false);
    expect(settings.hooks.SessionEnd).toEqual([{
      hooks: [{ type: "command", command: CMD, statusMessage: SESSION_END_HOOK_STATUS }],
    }]);
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

  it("updates only owned commands while preserving matcher groups and sibling hooks", () => {
    const first = { type: "command", command: "notify-send before" };
    const last = { type: "command", command: "notify-send after", timeout: 20 };
    const settings: Record<string, any> = {
      hooks: {
        SessionEnd: [{
          matcher: "logout",
          sequential: true,
          hooks: [first, { type: "command", command: CMD, timeout: 30 }, last],
        }],
      },
    };
    const updated = `/new/cm ${SESSION_END_HOOK_ARGS}`;
    expect(upsertSessionEndHook(settings, updated)).toBe(true);
    expect(settings.hooks.SessionEnd).toEqual([{
      matcher: "logout",
      sequential: true,
      hooks: [first, { type: "command", command: updated, timeout: 30, statusMessage: SESSION_END_HOOK_STATUS }, last],
    }]);
    expect(removeSessionEndHook(settings)).toBe(true);
    expect(settings.hooks.SessionEnd).toEqual([{
      matcher: "logout",
      sequential: true,
      hooks: [first, last],
    }]);
    expect(removeSessionEndHook(settings)).toBe(false);
  });

  it("preserves distinct matcher scopes when updating multiple owned commands", () => {
    const settings: Record<string, any> = {
      hooks: {
        SessionEnd: [
          { matcher: "logout", hooks: [{ type: "command", command: CMD }] },
          { matcher: "clear", hooks: [{ type: "command", command: CMD, timeout: 15 }] },
        ],
      },
    };
    expect(upsertSessionEndHook(settings, CMD, "gemini")).toBe(true);
    expect(settings.hooks.SessionEnd.map((entry: any) => entry.matcher)).toEqual(["logout", "clear"]);
    expect(settings.hooks.SessionEnd[1].hooks[0]).toEqual({
      type: "command", command: CMD, timeout: 15, name: "cass-memory-reflect",
    });
    expect(removeSessionEndHook(settings)).toBe(true);
    expect(settings).toEqual({});
  });

  for (const command of [
    CMD,
    "/usr/local/bin/cass-memory hook session-end",
    "'/opt/My'\\''s tools/cm' hook session-end",
    "'/opt/My tools/bun' '/work/My project/src/cm.ts' hook session-end",
    '"/opt/My tools/cm" hook session-end',
    "'/downloads/cass-memory-linux-x64' hook session-end",
  ]) {
    it(`recognizes a legacy generated invocation: ${command}`, () => {
      const settings: Record<string, any> = {
        hooks: { SessionEnd: [{ hooks: [{ type: "command", command }] }] },
      };
      expect(removeSessionEndHook(settings)).toBe(true);
      expect(settings).toEqual({});
    });
  }

  for (const command of [
    "notify-send 'hook session-end completed'",
    "printf '%s' 'cm hook session-end'",
    "'cm hook session-end'",
    "unrelated-tool hook session-end",
    "cm hook session-end-other",
    "cm hook session-end && notify-send finished",
    "cm\nhook session-end",
    "/tools/{first,second}/cm hook session-end",
    "/tools/*/cm hook session-end",
    "/opt/company/reflect-wrapper",
    "bun '/unfinished/cm.ts hook session-end",
  ]) {
    it(`preserves unowned commands without interpreting mentioned hook text: ${command}`, () => {
      const unrelated = { type: "command", command };
      const settings: Record<string, any> = {
        hooks: { SessionEnd: [{ matcher: "exit", hooks: [unrelated] }] },
      };
      expect(removeSessionEndHook(settings)).toBe(false);
      expect(upsertSessionEndHook(settings, CMD)).toBe(false);
      expect(settings.hooks.SessionEnd[0]).toEqual({ matcher: "exit", hooks: [unrelated] });
      expect(removeSessionEndHook(settings)).toBe(true);
      expect(settings.hooks.SessionEnd).toEqual([{ matcher: "exit", hooks: [unrelated] }]);
    });
  }
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
  it("round-trips through explicit shared project settings without touching other keys", async () => {
    await withTempCassHome(async (env) => {
      const project = path.join(env.home, "proj");
      const settingsPath = path.join(project, ".claude", "settings.json");
      await mkdir(path.dirname(settingsPath), { recursive: true });
      await writeFile(settingsPath, JSON.stringify({ permissions: { allow: ["Bash(ls)"] } }));

      await inDir(project, async () => {
        let capture = captureConsole();
        try {
          await hookCommand("install", { json: true, project: true, command: CMD });
        } finally {
          capture.restore();
        }
        const installed = JSON.parse(capture.logs.join("\n"));
        expect(installed.data.installed).toBe(true);
        expect(installed.data.scope).toBe("project");
        expect(installed.data.shared).toBe(true);
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
          await hookCommand("uninstall", { json: true, project: true });
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
      const settingsPath = path.join(env.home, ".claude", "settings.json");
      await mkdir(project, { recursive: true });
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

describe("cm hook private defaults and explicit shared settings", () => {
  for (const agent of ["claude", "gemini"] as const) {
    it(`keeps ${agent} project settings unchanged when installing and uninstalling by default`, async () => {
      await withTempCassHome(async (env) => {
        const project = path.join(env.home, `project-${agent}`);
        const projectSettings = path.join(project, `.${agent}`, "settings.json");
        const userSettings = path.join(env.home, `.${agent}`, "settings.json");
        const existingProject = JSON.stringify({
          hooks: { SessionEnd: [{ hooks: [{ type: "command", command: CMD }] }] },
          permissions: { allow: ["Bash(ls)"] },
        }, null, 4);
        const existingUser = { theme: "dark", hooks: { SessionEnd: [{ hooks: [{ type: "command", command: "notify-send done" }] }] } };
        await mkdir(path.dirname(projectSettings), { recursive: true });
        await mkdir(path.dirname(userSettings), { recursive: true });
        await writeFile(projectSettings, existingProject);
        await writeFile(userSettings, JSON.stringify(existingUser));
        await inDir(project, async () => {
          const installed = await runHookJson("install", { agent, command: CMD });
          expect(installed.data.scope).toBe("user");
          expect(installed.data.shared).toBe(false);
          expect(installed.data.settingsPath).toBe(userSettings);
          expect(await readFile(projectSettings, "utf-8")).toBe(existingProject);

          const status = (await runHookJson("status")).data;
          expect(status.scopes.find((s: any) => s.agent === agent && s.scope === "user").installed).toBe(true);
          expect(status.scopes.find((s: any) => s.agent === agent && s.scope === "project")).toMatchObject({ installed: true, shared: true });

          expect((await runHookJson("uninstall", { agent })).data.removed).toBe(true);
          expect(JSON.parse(await readFile(userSettings, "utf-8"))).toEqual(existingUser);
          expect(await readFile(projectSettings, "utf-8")).toBe(existingProject);

          expect((await runHookJson("uninstall", { agent, project: true })).data.removed).toBe(true);
          expect(JSON.parse(await readFile(projectSettings, "utf-8"))).toEqual({ permissions: { allow: ["Bash(ls)"] } });
          expect(JSON.parse(await readFile(userSettings, "utf-8"))).toEqual(existingUser);
        });
      });
    });

    it(`keeps a custom ${agent} command identifiable through reinstall, status and uninstall`, async () => {
      await withTempCassHome(async (env) => {
        const settingsPath = path.join(env.home, `.${agent}`, "settings.json");
        const unrelated = {
          type: "command", command: "notify-send 'hook session-end completed'", timeout: 10,
        };
        await mkdir(path.dirname(settingsPath), { recursive: true });
        await writeFile(settingsPath, JSON.stringify({ hooks: { SessionEnd: [{ hooks: [unrelated] }] } }));
        const firstCommand = "/opt/company/reflect-wrapper";
        const nextCommand = "/opt/company/new-reflect-wrapper --background";
        const first = await runHookJson("install", { agent, command: firstCommand });
        expect(first.data.replaced).toBe(false);
        const second = await runHookJson("install", { agent, command: nextCommand });
        expect(second.data.replaced).toBe(true);

        const saved = JSON.parse(await readFile(settingsPath, "utf-8"));
        expect(saved.hooks.SessionEnd).toHaveLength(2);
        expect(saved.hooks.SessionEnd[0].hooks).toEqual([unrelated]);
        expect(saved.hooks.SessionEnd[1].hooks).toEqual([agent === "gemini"
          ? { type: "command", command: nextCommand, name: SESSION_END_HOOK_NAME }
          : { type: "command", command: nextCommand, statusMessage: SESSION_END_HOOK_STATUS }]);
        const status = (await runHookJson("status")).data;
        expect(status.scopes.find((scope: any) => scope.agent === agent && scope.scope === "user"))
          .toMatchObject({ installed: true, hookCommand: nextCommand });
        expect((await runHookJson("uninstall", { agent })).data.removed).toBe(true);
        expect(JSON.parse(await readFile(settingsPath, "utf-8"))).toEqual({ hooks: { SessionEnd: [{ hooks: [unrelated] }] } });
        expect((await runHookJson("status")).data.scopes.find((scope: any) => scope.agent === agent && scope.scope === "user").installed).toBe(false);
      });
    });
  }

  it("rejects contradictory scope flags before either settings file is changed", async () => {
    await withTempCassHome(async (env) => {
      const project = path.join(env.home, "project-conflict");
      const paths = [path.join(project, ".claude", "settings.json"), path.join(env.home, ".claude", "settings.json")];
      const before = JSON.stringify({ hooks: { SessionEnd: [{ hooks: [{ type: "command", command: CMD }] }] } });
      for (const settingsPath of paths) {
        await mkdir(path.dirname(settingsPath), { recursive: true });
        await writeFile(settingsPath, before);
      }
      await inDir(project, async () => {
        for (const action of ["install", "uninstall"] as const) {
          const result = await runHookJson(action, { project: true, global: true, command: CMD });
          expect(result.success).toBe(false);
          expect(result.error.message).toContain("--global and --project");
          for (const settingsPath of paths) expect(await readFile(settingsPath, "utf-8")).toBe(before);
        }
      });
    });
  });

  it("uses CLAUDE_CONFIG_DIR consistently for install, status and uninstall", async () => {
    await withTempCassHome(async (env) => {
      const previous = process.env.CLAUDE_CONFIG_DIR;
      process.env.CLAUDE_CONFIG_DIR = "~/custom-claude";
      try {
        const expected = path.join(env.home, "custom-claude", "settings.json");
        expect(await resolveSettingsPath("user", "claude")).toBe(expected);
        const install = await runHookJson("install", { command: CMD });
        expect(install.data.settingsPath).toBe(expected);
        const status = (await runHookJson("status")).data;
        expect(status.scopes.find((s: any) => s.agent === "claude" && s.scope === "user")).toMatchObject({ installed: true, settingsPath: expected });
        const uninstall = await runHookJson("uninstall");
        expect(uninstall.data.settingsPath).toBe(expected);
        expect(uninstall.data.removed).toBe(true);
      } finally {
        if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
        else process.env.CLAUDE_CONFIG_DIR = previous;
      }
    });
  });

  it("writes a portable command only after explicit CLI --project selection", async () => {
    await withTempCassHome(async (env) => {
      const project = path.join(env.home, "project-cli");
      await mkdir(project, { recursive: true });
      const child = Bun.spawn([
        process.execPath,
        path.join(import.meta.dir, "../src/cm.ts"),
        "hook", "install", "--project", "--json",
      ], { cwd: project, env: process.env, stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
      const result = JSON.parse(stdout).data;
      expect(result.scope).toBe("project");
      expect(result.shared).toBe(true);
      expect(result.hookCommand).toBe(CMD);
      expect(result.settingsPath).toBe(path.join(project, ".claude", "settings.json"));
    });
  });

  it("discloses shared installations and how to remove older project hooks", async () => {
    await withTempCassHome(async (env) => {
      const project = path.join(env.home, "project-disclosure");
      await mkdir(project, { recursive: true });
      await inDir(project, async () => {
        const capture = captureConsole();
        try {
          await hookCommand("install", { project: true, command: CMD });
          await hookCommand("status");
        } finally {
          capture.restore();
        }
        const output = capture.logs.join("\n");
        expect(output).toContain("committing this file enables the hook for teammates");
        expect(output).toContain("configured LLM provider");
        expect(output).toContain("hook uninstall --project");
      });
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
        expect(out).toMatch(/user\s+installed/);
        expect(out).toContain("for your user across projects");
        expect(out).toContain("configured LLM provider");
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
      const settingsPath = path.join(env.home, ".claude", "settings.json");
      await mkdir(project, { recursive: true });
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

describe("cm hook --agent gemini", () => {
  it("installs into user .gemini/settings.json with a named entry and shows in status", async () => {
    await withTempCassHome(async (env) => {
      const project = path.join(env.home, "proj-gem");
      await mkdir(project, { recursive: true });
      await inDir(project, async () => {
        let capture = captureConsole();
        try {
          await hookCommand("install", { json: true, agent: "gemini", command: CMD });
        } finally {
          capture.restore();
        }
        const data = JSON.parse(capture.logs.join("\n")).data;
        expect(data.agent).toBe("gemini");
        expect(data.scope).toBe("user");
        expect(data.shared).toBe(false);
        expect(data.settingsPath).toBe(path.join(env.home, ".gemini", "settings.json"));
        const saved = JSON.parse(await readFile(data.settingsPath, "utf-8"));
        expect(saved.hooks.SessionEnd[0].hooks[0]).toEqual({
          name: "cass-memory-reflect",
          type: "command",
          command: CMD,
        });

        capture = captureConsole();
        try {
          await hookCommand("status", { json: true });
        } finally {
          capture.restore();
        }
        const status = JSON.parse(capture.logs.join("\n")).data;
        expect(status.scopes.find((s: any) => s.agent === "gemini" && s.scope === "user").installed).toBe(true);
        expect(status.scopes.find((s: any) => s.agent === "gemini" && s.scope === "project").installed).toBe(false);
      });
    });
  });

  it("rejects an unknown agent", async () => {
    await withTempCassHome(async (env) => {
      await inDir(env.home, async () => {
        const capture = captureConsole();
        try {
          await hookCommand("install", { json: true, agent: "codex" });
        } finally {
          capture.restore();
        }
        expect(JSON.parse(capture.logs.join("\n")).success).toBe(false);
      });
    });
  });

  it("session-end skips sessions cm started as its own LLM (any agent)", async () => {
    const { CM_SUBPROCESS_ENV_VAR, CM_SUBPROCESS_ENV_VALUE } = await import("../src/subprocess-tag.js");
    const d = await decideSessionEnd(
      { transcript_path: "/home/u/.gemini/tmp/abc123/chats/session.json" },
      { env: { [CM_SUBPROCESS_ENV_VAR]: CM_SUBPROCESS_ENV_VALUE } },
    );
    expect(d.action).toBe("skip");
    expect(d.reason).toContain("subprocess");
  });
});
