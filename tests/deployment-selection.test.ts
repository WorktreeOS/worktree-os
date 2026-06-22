import { describe, expect, test } from "bun:test";
import { buildDeploymentSelection } from "../apps/web/src/lib/deployment-selection";

describe("buildDeploymentSelection", () => {
  test("returns empty payload when no generated options are available", () => {
    const out = buildDeploymentSelection({
      hasGenerated: false,
      selectMode: "all",
      selectedTarget: "",
      selectedServices: new Set(),
      argumentNames: [],
      argumentValues: {},
    });
    expect(out).toEqual({});
  });

  test("submits selected target alongside runtime arguments", () => {
    const out = buildDeploymentSelection({
      hasGenerated: true,
      selectMode: "target",
      selectedTarget: "lk-zup",
      selectedServices: new Set(),
      argumentNames: ["API_URL"],
      argumentValues: { API_URL: "https://empl-stage.test-wa.ru" },
    });
    expect(out).toEqual({
      target: "lk-zup",
      arguments: { API_URL: "https://empl-stage.test-wa.ru" },
    });
  });

  test("submits selected services alongside runtime arguments", () => {
    const out = buildDeploymentSelection({
      hasGenerated: true,
      selectMode: "custom",
      selectedTarget: "",
      selectedServices: new Set(["api", "web"]),
      argumentNames: ["API_URL"],
      argumentValues: { API_URL: "https://empl-stage.test-wa.ru" },
    });
    expect(out.services).toEqual(["api", "web"]);
    expect(out.arguments).toEqual({
      API_URL: "https://empl-stage.test-wa.ru",
    });
  });

  test("omits blank runtime argument values", () => {
    const out = buildDeploymentSelection({
      hasGenerated: true,
      selectMode: "all",
      selectedTarget: "",
      selectedServices: new Set(),
      argumentNames: ["API_URL", "FEATURE_FLAG"],
      argumentValues: { API_URL: "https://empl-stage.test-wa.ru", FEATURE_FLAG: "" },
    });
    expect(out.arguments).toEqual({
      API_URL: "https://empl-stage.test-wa.ru",
    });
  });

  test("omits arguments field entirely when every value is blank", () => {
    const out = buildDeploymentSelection({
      hasGenerated: true,
      selectMode: "all",
      selectedTarget: "",
      selectedServices: new Set(),
      argumentNames: ["API_URL"],
      argumentValues: { API_URL: "" },
    });
    expect(out.arguments).toBeUndefined();
  });

  test("preserves selectMode=all (no target/services) with arguments", () => {
    const out = buildDeploymentSelection({
      hasGenerated: true,
      selectMode: "all",
      selectedTarget: "",
      selectedServices: new Set(),
      argumentNames: ["API_URL"],
      argumentValues: { API_URL: "https://empl-stage.test-wa.ru" },
    });
    expect(out.target).toBeUndefined();
    expect(out.services).toBeUndefined();
    expect(out.arguments).toEqual({
      API_URL: "https://empl-stage.test-wa.ru",
    });
  });
});
