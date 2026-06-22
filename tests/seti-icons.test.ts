import { test, expect, describe } from "bun:test";
import { getSetiFileIcon } from "../apps/web/src/lib/seti-icons";
import setiTheme from "../apps/web/src/assets/seti/vs-seti-icon-theme.json";

/**
 * Helper that resolves the glyph for `path` and returns the icon definition
 * name (the underscore-prefixed keys in the theme) that produced it. Useful
 * for asserting that the *right* icon was picked, not just that some icon was
 * returned.
 */
type IconDef = { fontCharacter?: string; fontColor?: string };
function iconNameFor(path: string): string | null {
  const icon = getSetiFileIcon(path);
  if (!icon) return null;
  const defs = setiTheme.iconDefinitions as Record<string, IconDef>;
  for (const [name, def] of Object.entries(defs)) {
    if (name.endsWith("_light")) continue;
    const charCode = def.fontCharacter
      ? String.fromCodePoint(parseInt(def.fontCharacter.slice(1), 16))
      : null;
    if (charCode === icon.char && def.fontColor === icon.colorDark) {
      return name;
    }
  }
  return null;
}

describe("getSetiFileIcon basic resolution", () => {
  test("returns a private-use codepoint plus dark + light colors", () => {
    const icon = getSetiFileIcon("apps/web/src/main.tsx");
    expect(icon).not.toBeNull();
    const code = icon!.char.codePointAt(0)!;
    expect(code).toBeGreaterThanOrEqual(0xe000);
    expect(code).toBeLessThanOrEqual(0xf8ff);
    expect(icon!.colorDark).toMatch(/^#[0-9a-f]{6}$/i);
    expect(icon!.colorLight).toMatch(/^#[0-9a-f]{6}$/i);
  });

  test("returns null for an empty or trailing-slash path", () => {
    expect(getSetiFileIcon("")).toBeNull();
    expect(getSetiFileIcon("dir/")).toBeNull();
  });

  test("handles windows-style separators", () => {
    const a = getSetiFileIcon("repo\\package.json");
    const b = getSetiFileIcon("repo/package.json");
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a!.char).toBe(b!.char);
  });
});

describe("filename match (theme.fileNames)", () => {
  test("matches by full filename before falling back to extension", () => {
    expect(iconNameFor("repo/tsconfig.json")).toBe("_tsconfig");
    expect(iconNameFor("repo/yarn.lock")).toBe("_yarn");
    expect(iconNameFor("repo/readme.md")).toBe("_info");
    expect(iconNameFor("repo/bower.json")).toBe("_bower");
  });

  test("filename match is case-insensitive", () => {
    expect(iconNameFor("README.md")).toBe("_info");
    expect(iconNameFor("TSCONFIG.JSON")).toBe("_tsconfig");
  });

  test("vite.config.ts resolves to the vite icon, not generic typescript", () => {
    const vite = iconNameFor("vite.config.ts");
    const ts = iconNameFor("server.ts");
    expect(vite).toBe("_vite");
    expect(ts).toBe("_typescript");
    expect(vite).not.toBe(ts);
  });
});

describe("extension chain (theme.fileExtensions)", () => {
  test("longer extension chain wins over single extension", () => {
    // Both test.ts and spec.ts get the orange `_typescript_1` variant so the
    // test files stand out from sources. Plain *.ts stays on the blue icon.
    expect(iconNameFor("auth.test.ts")).toBe("_typescript_1");
    expect(iconNameFor("auth.spec.ts")).toBe("_typescript_1");
    expect(iconNameFor("auth.ts")).toBe("_typescript");
  });

  test("known multi-char extensions (svelte, vue, prisma)", () => {
    expect(iconNameFor("App.svelte")).toBe("_svelte");
    expect(iconNameFor("App.vue")).toBe("_vue");
    expect(iconNameFor("schema.prisma")).toBe("_prisma");
  });
});

describe("language-id fallback (the gap I just fixed)", () => {
  test.each([
    ["main.ts", "_typescript"],
    ["main.mts", "_typescript"],
    ["main.cts", "_typescript"],
    ["App.tsx", "_react"],
    ["main.js", "_javascript"],
    ["main.mjs", "_javascript"],
    ["main.cjs", "_javascript"],
    ["App.jsx", "_react"],
    ["main.py", "_python"],
    ["main.go", "_go2"],
    ["main.rs", "_rust"],
    ["main.rb", "_ruby"],
    ["main.java", "_java"],
    ["main.kt", "_kotlin"],
    ["main.swift", "_swift"],
    ["main.c", "_c"],
    // theme.fileExtensions has dedicated header-file icons (`_c_1` / `_cpp_1`)
    // that win over our language-id fallback for `*.h` / `*.hpp`.
    ["main.h", "_c_1"],
    ["main.hpp", "_cpp_1"],
    ["main.cpp", "_cpp"],
    ["main.cs", "_c-sharp"],
    ["main.php", "_php"],
    ["query.sql", "_db"],
    ["config.xml", "_xml"],
    ["config.yml", "_yml"],
    ["config.yaml", "_yml"],
    ["data.json", "_json"],
    ["data.jsonc", "_json"],
    ["doc.md", "_markdown"],
    ["index.html", "_html_3"],
    ["styles.css", "_css"],
    ["styles.less", "_less"],
    ["styles.scss", "_sass"],
    ["script.sh", "_shell"],
    ["script.bash", "_shell"],
    ["script.ps1", "_powershell"],
    ["app.lua", "_lua"],
    ["app.dart", "_dart"],
  ])("%s -> %s", (path, expected) => {
    expect(iconNameFor(path)).toBe(expected);
  });
});

describe("extension-less filenames (NAME_TO_LANG)", () => {
  test.each([
    ["Dockerfile", "_docker"],
    ["dockerfile", "_docker"],
    ["Makefile", "_makefile"],
    ["makefile", "_makefile"],
    ["Gemfile", "_ruby"],
    ["Rakefile", "_ruby"],
    [".gitignore", "_git"],
    [".dockerignore", "_git"],
  ])("%s -> %s", (path, expected) => {
    expect(iconNameFor(path)).toBe(expected);
  });
});

describe("default + theme variants", () => {
  test("falls back to the default icon for unknown extensions", () => {
    const unknown = getSetiFileIcon("weird.zzz-does-not-exist");
    const noExt = getSetiFileIcon("no-extension-at-all");
    expect(unknown).not.toBeNull();
    expect(noExt).not.toBeNull();
    expect(unknown!.char).toBe(noExt!.char);
  });

  test("light variant exists for typescript and differs in color", () => {
    const icon = getSetiFileIcon("main.ts");
    expect(icon).not.toBeNull();
    expect(icon!.colorDark.toLowerCase()).not.toBe(
      icon!.colorLight.toLowerCase(),
    );
  });
});
