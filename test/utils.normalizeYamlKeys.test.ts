import { describe, expect, test } from "bun:test";
import { camelToSnakeKeys, normalizeYamlKeys } from "../src/utils.js";

describe("normalizeYamlKeys", () => {
  test("converts snake_case keys to camelCase deeply", () => {
    const input = {
      api_key: "x",
      llm_config: {
        max_tokens: 100,
        model_name: "gpt",
      },
      playbook_paths: [
        { repo_path: "/repo/.cass/playbook.yaml" },
        { global_path: "~/.cass-memory/playbook.yaml" },
      ],
    };

    const result = normalizeYamlKeys<any>(input as any);

    expect(result as any).toEqual({
      apiKey: "x",
      llmConfig: {
        maxTokens: 100,
        modelName: "gpt",
      },
      playbookPaths: [
        { repoPath: "/repo/.cass/playbook.yaml" },
        { globalPath: "~/.cass-memory/playbook.yaml" },
      ],
    });
  });

  test("leaves arrays of primitives untouched", () => {
    const result = normalizeYamlKeys<any>({ tags_list: ["a", "b_c"] } as any);
    expect(result as any).toEqual({ tagsList: ["a", "b_c"] });
  });
});

describe("camelToSnakeKeys (inverse)", () => {
  test("converts camelCase keys to snake_case deeply", () => {
    const input = {
      apiKey: "x",
      llmConfig: {
        maxTokens: 100,
        modelName: "gpt",
      },
      playbookPaths: [
        { repoPath: "/repo/.cass/playbook.yaml" },
        { globalPath: "~/.cass-memory/playbook.yaml" },
      ],
    };

    const result = camelToSnakeKeys<any>(input as any);

    expect(result as any).toEqual({
      api_key: "x",
      llm_config: {
        max_tokens: 100,
        model_name: "gpt",
      },
      playbook_paths: [
        { repo_path: "/repo/.cass/playbook.yaml" },
        { global_path: "~/.cass-memory/playbook.yaml" },
      ],
    });
  });

  test("handles arrays and primitives", () => {
    const result = camelToSnakeKeys<any>({ tagsList: ["a", "b_c"], flag: true } as any);
    expect(result as any).toEqual({ tags_list: ["a", "b_c"], flag: true });
  });
});
