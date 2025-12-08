import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(__dirname, "..", "fixtures");

function loadText(relPath: string): string {
  return readFileSync(resolve(fixturesDir, relPath), "utf-8");
}

export function loadYamlFixture<T = unknown>(relPath: string): T {
  return yaml.parse(loadText(relPath)) as T;
}

export function loadJsonFixture<T = unknown>(relPath: string): T {
  return JSON.parse(loadText(relPath)) as T;
}

export const fixturePaths = {
  playbookEmpty: resolve(fixturesDir, "playbook-empty.yaml"),
  playbookSample: resolve(fixturesDir, "playbook-sample.yaml"),
  configDefault: resolve(fixturesDir, "config-default.json"),
  diarySuccess: resolve(fixturesDir, "diary-success.json"),
  diaryFailure: resolve(fixturesDir, "diary-failure.json"),
};
