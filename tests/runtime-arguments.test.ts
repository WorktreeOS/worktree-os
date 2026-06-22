import { test, expect, describe } from "bun:test";
import {
  RuntimeArgumentError,
  validateRuntimeArguments,
} from "@worktreeos/compose/runtime-arguments";
import {
  DEFAULT_HOST_PORT_RANGE,
  type WosConfig,
} from "@worktreeos/core/config";

function configWithArgs(args: string[]): WosConfig {
  return {
    mode: "generated",
    cloneVolumes: [],
    app: { image: null, initScript: [], services: {} },
    deps: {},
    hostPorts: { ...DEFAULT_HOST_PORT_RANGE },
    cache: [],
    targets: {},
    arguments: args,
  };
}

describe("validateRuntimeArguments", () => {
  test("accepts submitted keys that are declared", () => {
    expect(() =>
      validateRuntimeArguments(configWithArgs(["API_URL"]), {
        API_URL: "https://empl-stage.test-wa.ru",
      }),
    ).not.toThrow();
  });

  test("accepts undefined submitted map", () => {
    expect(() =>
      validateRuntimeArguments(configWithArgs(["API_URL"]), undefined),
    ).not.toThrow();
  });

  test("accepts empty submitted map", () => {
    expect(() =>
      validateRuntimeArguments(configWithArgs(["API_URL"]), {}),
    ).not.toThrow();
  });

  test("rejects submitted key that is not declared", () => {
    expect(() =>
      validateRuntimeArguments(configWithArgs(["API_URL"]), { OTHER: "x" }),
    ).toThrow(RuntimeArgumentError);
  });

  test("rejects when no arguments are declared but a key is submitted", () => {
    expect(() =>
      validateRuntimeArguments(configWithArgs([]), { OTHER: "x" }),
    ).toThrow(/not declared/);
  });
});
