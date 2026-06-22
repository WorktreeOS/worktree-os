import { test, expect, describe } from "bun:test";
import { resolve } from "node:path";
import { isTestOwnedComposeProcess } from "./helpers/compose-process-cleanup.ts";

describe("isTestOwnedComposeProcess", () => {
  const home = resolve("/private/tmp/wos-owned-home");

  test("ignores non-compose docker commands", () => {
    expect(isTestOwnedComposeProcess("/usr/local/bin/docker ps -q", home)).toBe(
      false,
    );
    expect(
      isTestOwnedComposeProcess("docker run --rm alpine echo hi", home),
    ).toBe(false);
  });

  test("ignores compose that does not reference the wos home path", () => {
    expect(
      isTestOwnedComposeProcess(
        "docker compose -f /somewhere_else/compose.yml up",
        home,
      ),
    ).toBe(false);
    expect(
      isTestOwnedComposeProcess("docker-compose -p otherproject logs -f", home),
    ).toBe(false);
  });

  test("matches docker compose when command includes resolved home", () => {
    const rooted = `${home}/wt/proj`;
    expect(
      isTestOwnedComposeProcess(
        `/bin/docker compose --project-directory ${rooted} up -d`,
        home,
      ),
    ).toBe(true);
  });

  test("matches docker-compose variant with path under home", () => {
    const file = resolve(home, "sessions/foo/compose.yaml");
    expect(
      isTestOwnedComposeProcess(`docker-compose -f ${file} logs --follow svc`, home),
    ).toBe(true);
  });
});
