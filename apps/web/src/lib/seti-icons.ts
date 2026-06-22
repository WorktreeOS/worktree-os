import theme from "@/assets/seti/vs-seti-icon-theme.json";

/**
 * Resolved Seti UI icon for a single file. The font character is a single
 * private-use codepoint from `seti.woff`; the two colors come from the upstream
 * theme's dark (default) and light variants so the same icon can blend in with
 * either app theme.
 */
export interface SetiIcon {
  char: string;
  colorDark: string;
  colorLight: string;
}

type IconRefs = Record<string, string>;
type ThemeJson = {
  iconDefinitions: Record<
    string,
    { fontCharacter?: string; fontColor?: string }
  >;
  file: string;
  fileExtensions: IconRefs;
  fileNames: IconRefs;
  languageIds: IconRefs;
  light?: {
    file?: string;
    fileExtensions?: IconRefs;
    fileNames?: IconRefs;
    languageIds?: IconRefs;
  };
};

const T = theme as ThemeJson;

const iconDefs = T.iconDefinitions;
const darkRefs = {
  file: T.file,
  fileNames: T.fileNames,
  fileExtensions: T.fileExtensions,
  languageIds: T.languageIds,
};
const lightRefs = {
  file: T.light?.file ?? T.file,
  fileNames: T.light?.fileNames ?? T.fileNames,
  fileExtensions: T.light?.fileExtensions ?? T.fileExtensions,
  languageIds: T.light?.languageIds ?? T.languageIds,
};

/**
 * Common file-extension to VS Code language id mapping. VS Code itself derives
 * this from each language extension's contributions (`*.ts` → `typescript`,
 * etc.). The Seti theme only ships icon mappings keyed by language id for
 * everyday extensions, so without this table `foo.ts` / `foo.py` / `foo.go`
 * would all fall back to the generic file icon.
 *
 * Only extensions that aren't already in `theme.fileExtensions` need to be
 * here; the table is overridden by the theme's own extension map at lookup
 * time.
 */
const EXT_TO_LANG: Record<string, string> = {
  // typescript / javascript family
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "typescriptreact",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascriptreact",

  // scripting languages
  py: "python",
  pyi: "python",
  pyw: "python",
  pyx: "python",
  rb: "ruby",
  rbw: "ruby",
  rbi: "ruby",
  ru: "ruby",
  gemspec: "ruby",

  // systems languages
  go: "go",
  rs: "rust",
  c: "c",
  h: "c",
  cpp: "cpp",
  cxx: "cpp",
  cc: "cpp",
  "c++": "cpp",
  hpp: "cpp",
  hxx: "cpp",
  hh: "cpp",
  "h++": "cpp",
  ipp: "cpp",
  cs: "csharp",
  csx: "csharp",
  fs: "fsharp",
  fsi: "fsharp",
  fsx: "fsharp",
  fsscript: "fsharp",
  swift: "swift",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",

  // web / data
  php: "php",
  phtml: "php",
  phar: "php",
  sql: "sql",
  mysql: "sql",
  pgsql: "sql",
  xml: "xml",
  xsd: "xml",
  xsl: "xml",
  xslt: "xml",
  plist: "xml",
  csproj: "xml",
  vbproj: "xml",
  fsproj: "xml",
  yml: "yaml",
  yaml: "yaml",
  json: "json",
  geojson: "json",
  webmanifest: "json",
  jsonl: "jsonl",
  jsonc: "jsonc",
  md: "markdown",
  markdown: "markdown",
  mdown: "markdown",
  mkd: "markdown",
  mkdn: "markdown",
  mdwn: "markdown",
  html: "html",
  htm: "html",
  shtml: "html",
  xhtml: "html",
  css: "css",
  less: "less",
  scss: "scss",
  styl: "stylus",

  // shell
  sh: "shellscript",
  bash: "shellscript",
  zsh: "shellscript",
  fish: "shellscript",
  ksh: "shellscript",
  csh: "shellscript",
  ps1: "powershell",
  psm1: "powershell",
  psd1: "powershell",

  // misc
  m: "objective-c",
  mm: "objective-cpp",
  lua: "lua",
  dart: "dart",
  jl: "julia",
  clj: "clojure",
  cljs: "clojure",
  cljc: "clojure",
  coffee: "coffeescript",
  bat: "bat",
  cmd: "bat",
  groovy: "groovy",
  hbs: "handlebars",
  handlebars: "handlebars",
  pug: "jade",
  razor: "razor",
  cshtml: "razor",
  tex: "latex",
  ltx: "latex",
  sty: "latex",
  bib: "latex",
  properties: "properties",
  conf: "properties",
  env: "dotenv",
};

/**
 * Extension-less filenames mapped to a language id. Covers files VS Code
 * normally recognises by filename pattern (Dockerfile, Makefile, Gemfile,
 * Rakefile, dotfiles like `.gitignore`).
 */
const NAME_TO_LANG: Record<string, string> = {
  dockerfile: "dockerfile",
  containerfile: "dockerfile",
  makefile: "makefile",
  gnumakefile: "makefile",
  gemfile: "ruby",
  rakefile: "ruby",
  vagrantfile: "ruby",
  guardfile: "ruby",
  ".gitignore": "ignore",
  ".dockerignore": "ignore",
  ".npmignore": "ignore",
  ".editorconfig": "properties",
};

/**
 * The icon theme stores each glyph as a CSS-style escape like `"\\E099"` in
 * JSON (a literal backslash followed by hex digits). Convert that to the real
 * unicode character produced by the Seti font.
 */
function codepointFromCharSpec(spec: string | undefined): string | null {
  if (!spec) return null;
  const m = /^\\([0-9A-Fa-f]+)$/.exec(spec);
  if (!m || !m[1]) return null;
  return String.fromCodePoint(parseInt(m[1], 16));
}

/**
 * Resolution order (matches VS Code's icon-theme behavior):
 *   1. Theme's exact filename match
 *   2. Filename → language id → theme.languageIds (Dockerfile, Makefile, etc.)
 *   3. Theme's file-extension chain (longest first, so `*.test.ts` beats `*.ts`)
 *   4. Extension chain → language id → theme.languageIds (covers ts/js/py/…)
 *   5. Theme's default file icon
 */
function resolveIconName(
  basename: string,
  refs: {
    file: string;
    fileNames: IconRefs;
    fileExtensions: IconRefs;
    languageIds: IconRefs;
  },
): string {
  const lower = basename.toLowerCase();

  const byName = refs.fileNames[lower];
  if (byName) return byName;

  const langByName = NAME_TO_LANG[lower];
  if (langByName) {
    const hit = refs.languageIds[langByName];
    if (hit) return hit;
  }

  // First sweep: theme fileExtensions (longest extension chain wins).
  for (let dot = lower.indexOf("."); dot >= 0; dot = lower.indexOf(".", dot + 1)) {
    const ext = lower.slice(dot + 1);
    const hit = refs.fileExtensions[ext];
    if (hit) return hit;
  }

  // Second sweep: extension → language id → icon.
  for (let dot = lower.indexOf("."); dot >= 0; dot = lower.indexOf(".", dot + 1)) {
    const ext = lower.slice(dot + 1);
    const lang = EXT_TO_LANG[ext];
    if (lang) {
      const hit = refs.languageIds[lang];
      if (hit) return hit;
    }
  }

  return refs.file;
}

function basenameOf(filePath: string): string {
  const lastSlash = Math.max(
    filePath.lastIndexOf("/"),
    filePath.lastIndexOf("\\"),
  );
  return filePath.slice(lastSlash + 1);
}

/**
 * Resolve the Seti UI icon for a file path. Returns `null` only when the
 * default icon itself is missing from the theme — callers should fall back to
 * a generic glyph in that case.
 */
export function getSetiFileIcon(filePath: string): SetiIcon | null {
  const base = basenameOf(filePath);
  if (!base) return null;

  const darkName = resolveIconName(base, darkRefs);
  const lightName = resolveIconName(base, lightRefs);

  const darkDef = iconDefs[darkName];
  if (!darkDef) return null;
  const char = codepointFromCharSpec(darkDef.fontCharacter);
  if (!char) return null;

  // The `light` section uses already-suffixed names (e.g. `_typescript_light`).
  // If the resolver still returned a non-light name (because the light section
  // didn't override it), fall back to `<dark>_light` if that exists, else to
  // the dark color so nothing renders blank.
  const lightDef =
    iconDefs[lightName] ?? iconDefs[`${darkName}_light`] ?? darkDef;

  return {
    char,
    colorDark: darkDef.fontColor ?? "currentColor",
    colorLight: lightDef.fontColor ?? darkDef.fontColor ?? "currentColor",
  };
}
