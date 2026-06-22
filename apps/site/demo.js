/* =============================================================================
 * WorktreeOS — interactive emulation engine
 *
 * A scripted "afternoon" played inside a faithful WorktreeOS window: the
 * attention-grouped Sessions rail on the left, a work surface on the right that
 * cycles through the product's real states (dossier → agent terminal → permission
 * → deploy → live + exposed). Six scenes, auto-advancing, scrubbable, with a
 * reduced-motion fallback. No framework — just data + DOM.
 * ========================================================================== */
(function () {
  "use strict";

  var reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // --- project identities (mono monogram + palette slot) --------------------
  var P = {
    orbit:   { mono: "or", color: "var(--p-1)" },
    payments: { mono: "pa", color: "var(--p-4)" },
    web:      { mono: "we", color: "var(--p-5)" },
    docs:     { mono: "do", color: "var(--p-8)" },
  };
  var AGENT = {
    claude: { glyph: "sparkles", color: "var(--claude)", label: "Claude Code", model: "opus-4-8", cap: 200, mascot: true },
    codex:  { glyph: "bot",      color: "var(--codex)",  label: "Codex",       model: "gpt-5-codex", cap: 272 },
    shell:  { glyph: "terminal", color: "var(--muted)",  label: "zsh",         model: null,          cap: 0 },
  };

  // Claude Code's pixel-art mascot, rebuilt as a tiny SVG grid (P = body, E = eye).
  var MASCOT = [
    "...P....P...",
    "...P....P...",
    "..PPPPPPPP..",
    ".PPPPPPPPPP.",
    ".PPEPPPPEPP.",
    ".PPPPPPPPPP.",
    ".PPPPPPPPPP.",
    "..PPPPPPPP..",
    "..P.P..P.P..",
  ];
  function mascot(px, color) {
    var cell = 3, cols = 12, rows = MASCOT.length, w = cols * cell, h = rows * cell, r = "";
    for (var y = 0; y < rows; y++) for (var x = 0; x < cols; x++) {
      var c = MASCOT[y].charAt(x);
      if (c === "P") r += '<rect x="' + x * cell + '" y="' + y * cell + '" width="' + cell + '" height="' + cell + '"/>';
      else if (c === "E") r += '<rect x="' + x * cell + '" y="' + y * cell + '" width="' + cell + '" height="' + cell + '" fill="#5C2E1E"/>';
    }
    return '<svg class="mascot" width="' + px + '" height="' + Math.round(px * h / w)
      + '" viewBox="0 0 ' + w + " " + h + '" style="fill:' + color + '" aria-hidden="true">' + r + "</svg>";
  }

  function s(id, project, agent, title, wt, group, ctx, tokens, extra) {
    var o = {
      id: id, project: project, agent: agent, title: title, wt: wt, group: group,
      ctx: ctx, tokens: tokens, model: AGENT[agent].model, cap: AGENT[agent].cap,
    };
    if (extra) for (var k in extra) o[k] = extra[k];
    return o;
  }

  // --- terminal scripts (revealed line-by-line) -----------------------------
  var TERM_SPAWN = [
    { c: "prompt", t: "❯ claude" },
    { c: "tool", t: "● Read src/auth/session.ts" },
    { c: "dim",  t: "  3 call sites still use the legacy token guard" },
    { c: "tool", t: "● Edit src/auth/session.ts" },
    { c: "add",  t: "  + export function requireSession(req: Request) {" },
    { c: "add",  t: "  +   const token = readBearer(req)" },
    { c: "tool", t: "● Run bun test auth" },
    { c: "ok",   t: "  ✓ 12 tests passed" },
  ];
  var TERM_PARALLEL = TERM_SPAWN.concat([
    { c: "tool", t: "● Edit src/auth/cookie.ts — wire new cookie path" },
    { c: "dim",  t: "  verifying /health before I commit…" },
  ]);
  var TERM_PERMISSION = TERM_PARALLEL.concat([
    { box: true, title: "Permission required",
      cmd: "curl -s localhost:4949/health", q: "Allow once?   [y] yes    [n] no" },
  ]);

  // --- scene timeline -------------------------------------------------------
  var SCENES = [
    {
      key: "idle", label: "Quiet", title: "A quiet workspace",
      dur: 4600, crumb: { project: "orbit", branch: "refactor-auth" },
      sessions: function () {
        return [
          s("cart", "web", "shell", "zsh", "cart-redesign", "work", 0, 0, { cmd: "bun dev" }),
          s("auth", "orbit", "claude", "Refactor auth flow", "refactor-auth", "idle", 18, 64, { focus: true }),
          s("ledger", "payments", "codex", "Reconcile ledger job", "ledger-fix", "idle", 41, 120),
          s("docs", "docs", "shell", "zsh", "typo-sweep", "idle", 0, 0, { cmd: "astro dev" }),
        ];
      },
      surface: { kind: "dossier" },
    },
    {
      key: "spawn", label: "Start", title: "Start an agent",
      dur: 6600, crumb: { project: "orbit", branch: "refactor-auth" },
      sessions: function () {
        return [
          s("auth", "orbit", "claude", "Refactor auth flow", "refactor-auth", "work", 22, 71, { focus: true }),
          s("cart", "web", "shell", "zsh", "cart-redesign", "work", 0, 0, { cmd: "bun dev" }),
          s("ledger", "payments", "codex", "Reconcile ledger job", "ledger-fix", "idle", 41, 120),
          s("docs", "docs", "shell", "zsh", "typo-sweep", "idle", 0, 0, { cmd: "astro dev" }),
        ];
      },
      surface: { kind: "term", project: "orbit", wt: "refactor-auth", agent: "claude", lines: TERM_SPAWN },
    },
    {
      key: "parallel", label: "Parallel", title: "Three agents at once",
      dur: 6600, crumb: { project: "orbit", branch: "refactor-auth" },
      sessions: function () {
        return [
          s("auth", "orbit", "claude", "Refactor auth flow", "refactor-auth", "work", 34, 96, { focus: true }),
          s("ledger", "payments", "codex", "Reconcile ledger job", "ledger-fix", "work", 88, 210),
          s("redesign", "web", "claude", "Cart redesign", "cart-redesign", "work", 51, 158),
          s("cart", "web", "shell", "zsh", "cart-redesign", "work", 0, 0, { cmd: "bun dev" }),
          s("docs", "docs", "shell", "zsh", "typo-sweep", "idle", 0, 0, { cmd: "astro dev" }),
        ];
      },
      surface: { kind: "term", project: "orbit", wt: "refactor-auth", agent: "claude", lines: TERM_PARALLEL },
    },
    {
      key: "needs", label: "Needs you", title: "It pauses for you",
      dur: 7200, crumb: { project: "orbit", branch: "refactor-auth" },
      toast: { title: "Needs your approval", body: "orbit / refactor-auth wants to run a command" },
      sessions: function () {
        return [
          s("auth", "orbit", "claude", "Refactor auth flow", "refactor-auth", "wait", 41, 112,
            { focus: true, q: "permission: run", qcmd: "curl", wait: "waiting 30s" }),
          s("ledger", "payments", "codex", "Reconcile ledger job", "ledger-fix", "work", 96, 232),
          s("redesign", "web", "claude", "Cart redesign", "cart-redesign", "work", 63, 184),
          s("cart", "web", "shell", "zsh", "cart-redesign", "work", 0, 0, { cmd: "bun dev" }),
        ];
      },
      surface: { kind: "term", project: "orbit", wt: "refactor-auth", agent: "claude", lines: TERM_PERMISSION },
    },
    {
      key: "deploy", label: "Deploy", title: "Ship it — wos up",
      dur: 7400, crumb: { project: "orbit", branch: "refactor-auth" },
      sessions: function () {
        return [
          s("auth", "orbit", "claude", "Refactor auth flow", "refactor-auth", "work", 44, 121, { focus: true }),
          s("ledger", "payments", "codex", "Reconcile ledger job", "ledger-fix", "work", 99, 248),
          s("redesign", "web", "claude", "Cart redesign", "cart-redesign", "work", 70, 201),
          s("cart", "web", "shell", "zsh", "cart-redesign", "work", 0, 0, { cmd: "bun dev" }),
        ];
      },
      surface: { kind: "deploy", branch: "refactor-auth" },
    },
    {
      key: "live", label: "Live", title: "Live & exposed",
      dur: 7400, crumb: { project: "orbit", branch: "refactor-auth" },
      sessions: function () {
        return [
          s("auth", "orbit", "claude", "Refactor auth flow", "refactor-auth", "unread", 47, 129, { focus: true }),
          s("ledger", "payments", "codex", "Reconcile ledger job", "ledger-fix", "work", 104, 263),
          s("redesign", "web", "claude", "Cart redesign", "cart-redesign", "work", 74, 212),
          s("cart", "web", "shell", "zsh", "cart-redesign", "idle", 0, 0, { cmd: "bun dev" }),
          s("docs", "docs", "shell", "zsh", "typo-sweep", "idle", 0, 0, { cmd: "astro dev" }),
        ];
      },
      surface: { kind: "running", branch: "refactor-auth" },
    },
  ];

  // --- DOM refs -------------------------------------------------------------
  var railBody = document.getElementById("rail-body");
  var railFilter = document.getElementById("rail-filter");
  var surfaceEl = document.getElementById("surface");
  var toastEl = document.getElementById("toast");
  var toastTitle = document.getElementById("toast-title");
  var toastBody = document.getElementById("toast-body");
  var crumbProject = document.getElementById("wc-project");
  var crumbBranch = document.getElementById("wc-branch");
  var scopeSub = document.getElementById("scope-sub");
  var trackEl = document.getElementById("track");
  var labelsEl = document.getElementById("labels");
  var legendEl = document.getElementById("legend");
  var playBtn = document.getElementById("play");

  function icons() { if (window.lucide) window.lucide.createIcons(); }

  // --- rail rendering -------------------------------------------------------
  var GROUPS = [
    { key: "wait",   name: "Needs you" },
    { key: "unread", name: "Unread" },
    { key: "work",   name: "Working" },
    { key: "idle",   name: "Idle" },
  ];

  function pct(sess) { return sess.cap ? Math.min(100, Math.round((sess.ctx / sess.cap) * 100)) : 0; }

  function rowHTML(sess) {
    var p = P[sess.project], a = AGENT[sess.agent];
    var working = sess.group === "work";
    var unread = sess.group === "unread";
    var idle = sess.group === "idle";
    var wait = sess.group === "wait";

    var tile = '<span class="row__tile">'
      + (working ? '<svg class="tile-run" viewBox="0 0 26 26" aria-hidden="true"><rect x="1" y="1" width="24" height="24" rx="7" ry="7" pathLength="100"></rect></svg>' : "")
      + p.mono + "</span>";

    var glyph = a.mascot
      ? '<span class="row__glyph">' + mascot(15, a.color) + "</span>"
      : '<i data-lucide="' + a.glyph + '" class="row__glyph" style="color:' + a.color + '"></i>';

    // trailing affordance: wait → amber word, unread → blue dot, else age
    var trail;
    if (wait) trail = '<span class="row__age row__age--wait">' + (sess.wait || "waiting") + "</span>";
    else if (unread) trail = '<span class="row__udot" title="Unread output"></span>';
    else trail = '<span class="row__age">' + (idle ? "idle" : (working ? "now" : "")) + "</span>";

    // line 2: worktree (+ command for shells) + telemetry (agents)
    var l2 = '<span class="row__wt">' + sess.wt
      + (sess.cmd ? ' · <span class="cmd">' + sess.cmd + "</span>" : "") + "</span>";
    if (sess.cap) {
      var p100 = pct(sess), warn = p100 >= 85;
      l2 += '<span class="tele">'
        + '<span class="tele__bead"></span>'
        + '<span class="tele__meter"><span class="tele__fill' + (warn ? " tele__fill--warn" : "")
          + '" data-meter style="width:' + p100 + '%"></span></span>'
        + '<span class="tele__ctx' + (warn ? " tele__ctx--warn" : "") + '" data-ctx>' + sess.ctx + "k</span>"
        + '<span class="tele__sep">·</span>'
        + '<span class="tele__tot" data-tot>' + sess.tokens + "k</span>"
        + "</span>";
    }

    var q = wait
      ? '<span class="row__q"><i data-lucide="circle-alert"></i>' + sess.q
        + ' <span class="mono" style="margin-left:4px">' + sess.qcmd + "</span> ?</span>"
      : "";

    var cls = "row";
    if (working) cls += " row--working";
    if (unread) cls += " row--unread";
    if (idle) cls += " row--idle";
    if (wait) cls += " row--wait";
    if (sess.focus) cls += " is-focus";

    return '<div class="' + cls + '" data-id="' + sess.id + '" style="--pc:' + p.color + '">'
      + tile
      + '<div class="row__l1">' + glyph
        + '<span class="row__title">' + sess.title + "</span>" + trail + "</div>"
      + '<div class="row__l2">' + l2 + "</div>"
      + q
      + "</div>";
  }

  function renderRail(sessions) {
    // filter bar with live counts
    var counts = { all: sessions.length, wait: 0, unread: 0, work: 0, idle: 0 };
    sessions.forEach(function (x) { counts[x.group]++; });
    railFilter.innerHTML =
      '<button class="seg" aria-pressed="true">All <span class="n">' + counts.all + "</span></button>"
      + '<button class="seg">Needs you <span class="n">' + counts.wait + "</span></button>"
      + '<button class="seg">Unread <span class="n">' + counts.unread + "</span></button>"
      + '<button class="seg">Working <span class="n">' + counts.work + "</span></button>"
      + '<button class="seg seg--new" title="New session"><i data-lucide="plus"></i></button>';

    var html = "";
    GROUPS.forEach(function (g) {
      var items = sessions.filter(function (x) { return x.group === g.key; });
      if (!items.length) return;
      html += '<div class="grp grp--' + g.key + '"><span class="gd"></span>' + g.name
        + '<span class="gn">' + items.length + "</span></div>";
      items.forEach(function (it) { html += rowHTML(it); });
    });
    railBody.innerHTML = html;

    // scope subtitle: live worktrees (non-idle) across their distinct projects
    var live = counts.all - counts.idle;
    var projects = {};
    sessions.forEach(function (x) { if (x.group !== "idle") projects[x.project] = 1; });
    var nproj = Object.keys(projects).length;
    scopeSub.innerHTML = '<span class="sdot ' + (counts.wait ? "sdot--wait" : (live ? "sdot--run" : "sdot--stop"))
      + '" style="width:7px;height:7px"></span> ' + live + " live worktree" + (live === 1 ? "" : "s")
      + " · " + nproj + " project" + (nproj === 1 ? "" : "s");
  }

  // --- surface rendering ----------------------------------------------------
  function agentGlyphHTML(agent, size) {
    var a = AGENT[agent];
    return '<i data-lucide="' + a.glyph + '" class="agentglyph" style="color:' + a.color
      + ';width:' + size + 'px;height:' + size + 'px"></i>';
  }

  function renderDossier() {
    surfaceEl.innerHTML =
      '<div class="surf__head">'
        + '<span class="surf__title">' + agentGlyphHTML("claude", 16)
          + '<b>refactor-auth</b> <span class="br">orbit</span></span>'
        + '<span class="right"><span class="nowline"><span class="sdot sdot--stop"></span>'
          + '<span class="statusword">stopped</span></span></span>'
      + "</div>"
      + '<div class="surf__body"><div class="dossier">'
        + '<div class="dossier__id"><span class="dossier__tile" style="--pc:var(--p-1)">or</span>'
          + '<div><h2>refactor-auth</h2><div class="meta">orbit · branched from main · 2 files changed</div></div></div>'
        + '<div class="dossier__intent">Move auth off the legacy token guard — one <span class="ic">requireSession()</span> entry point, cookie-path aware, fully tested.</div>'
        + '<div><div class="sec-h">Branch &amp; changes</div>'
          + '<dl class="ledger">'
            + "<dt>Upstream</dt><dd>origin/main · ↑ 2 ahead</dd>"
            + "<dt>Working tree</dt><dd>2 files · +48 −12</dd>"
            + "<dt>Last commit</dt><dd>4m ago · de1f0a2</dd>"
          + "</dl>"
          + '<div style="margin-top:14px">'
            + changeRow("src/auth/session.ts", 31, 8, 4, 1)
            + changeRow("src/auth/cookie.ts", 17, 4, 3, 1)
          + "</div></div>"
        + '<div><div class="sec-h">Sessions</div>'
          + '<div class="sessrow">' + agentGlyphHTML("claude", 17)
            + '<span class="nm">Refactor auth flow</span><span class="st">· idle 3m · opus-4-8</span>'
            + '<span class="right"><button class="btn btn--sm" tabindex="-1">Attach</button></span></div></div>'
        + '<div><div class="sec-h">Runtime</div>'
          + '<div class="runline"><span class="sdot sdot--stop"></span><span class="statusword">stopped</span>'
            + '<span class="facts">· no services · last run <b>—</b></span>'
            + '<span class="right"><button class="btn btn--sm" tabindex="-1"><span style="color:var(--accent-cmd)">wos up</span> → Start in Runtime</button></span></div></div>'
        + '<div class="continue">'
          + '<button class="btn btn--sm" tabindex="-1"><i data-lucide="git-pull-request"></i> Review</button>'
          + '<button class="btn btn--sm" tabindex="-1"><i data-lucide="files"></i> Files</button>'
          + '<button class="btn btn--sm" tabindex="-1"><i data-lucide="terminal"></i> Terminal</button>'
          + '<button class="btn btn--sm" tabindex="-1"><i data-lucide="external-link"></i> Open web</button>'
        + "</div>"
      + "</div></div>";
  }

  function changeRow(path, add, del, g, r) {
    var bar = "";
    for (var i = 0; i < 5; i++) bar += '<i class="' + (i < g ? "g" : i < g + r ? "r" : "") + '"></i>';
    return '<div class="change"><span class="path">' + path + "</span>"
      + '<span class="add">+' + add + '</span><span class="del">−' + del + "</span>"
      + '<span class="bar">' + bar + "</span></div>";
  }

  function renderTerm(surf) {
    var a = AGENT[surf.agent];
    var path = "/private/var/www/dev/" + surf.project;
    function tb(name, dot) {
      return '<button class="term-head__tb" tabindex="-1" aria-hidden="true">'
        + (dot ? '<span class="gd"></span>' : "") + '<i data-lucide="' + name + '"></i></button>';
    }
    surfaceEl.innerHTML =
      '<div class="surf__head term-head">'
        + '<span class="surf__title">' + mascot(16, "var(--claude)")
          + "<b>" + a.label + '</b> <span class="br">' + path + "</span></span>"
        + '<span class="term-head__tools">'
          + tb("sparkles", true) + tb("rotate-cw") + tb("sliders-horizontal") + tb("pencil") + tb("x")
        + "</span>"
      + "</div>"
      + '<div class="surf__body is-term"><div class="termwrap">'
        + '<div class="term__splash">' + mascot(50, "#E0997F")
          + '<div class="term__splashtx">'
            + '<span><b>Claude Code</b> <span class="dim">v2.1.185</span></span>'
            + '<span class="ln2">Opus 4.8 (1M context) with xhigh effort · Claude Max</span>'
            + '<span class="dim">' + path + "</span>"
          + "</div></div>"
        + '<pre class="term" id="term"></pre>'
        + '<div class="term__foot">'
          + '<div class="term__effortrow"><span class="term__effort">xhigh · /effort</span></div>'
          + '<hr class="term__rule" />'
          + '<div class="term__input"><span class="prompt">❯</span><span class="cursor"></span></div>'
          + '<hr class="term__rule" />'
          + '<div class="term__status">Op 4.8 (1m) <span class="sepc">|</span> ' + surf.project
            + ' <span class="brc">(main)</span> <span class="sepc">|</span> 6M</div>'
          + '<div class="term__hint">▶▶ bypass permissions on (shift+tab to cycle) · ← for agents</div>'
        + "</div>"
      + "</div></div>";
    var pre = document.getElementById("term");
    return streamLines(pre, surf.lines);
  }

  function appendLine(pre, ln) {
    var node;
    if (ln.box) {
      node = document.createElement("span");
      node.className = "permbox ln";
      node.innerHTML = '<span class="ph">┌ ' + ln.title + " ───────────</span>\n"
        + "│ Run command:  <span class=\"warnc\">" + ln.cmd + "</span>\n"
        + "│ " + ln.q + "\n└──────────────────────────────";
    } else {
      node = document.createElement("span");
      node.className = "ln " + (ln.c || "");
      node.textContent = ln.t;
    }
    pre.appendChild(node);
    pre.scrollTop = pre.scrollHeight;
  }

  function streamLines(pre, lines) {
    var timers = [], i = 0;
    if (reduced) {
      lines.forEach(function (ln) { appendLine(pre, ln); });
      return function () {};
    }
    function step() {
      if (i >= lines.length) return;
      appendLine(pre, lines[i]);
      var wait = lines[i].box ? 750 : 440;
      i++;
      timers.push(setTimeout(step, wait));
    }
    step();
    return function () { timers.forEach(clearTimeout); };
  }

  function renderDeploy(surf) {
    surfaceEl.innerHTML =
      '<div class="surf__head">'
        + '<span class="surf__title">' + agentGlyphHTML("shell", 16)
          + '<b>Deploying</b> <span class="br">orbit / ' + surf.branch + "</span></span>"
        + '<span class="right">docker compose</span>'
      + "</div>"
      + '<div class="surf__body">'
        + '<span class="cmdpill"><span class="p">❯</span> wos up<span class="t" id="dtimer">0.0s</span></span>'
        + '<div class="todobanner"><span class="spin"></span> Deploying refactor-auth'
          + '<span class="n" id="dstep">step 3 of 5</span></div>'
        + '<ol class="steps" id="dsteps">'
          + stepLI(1, "Prepare worktree", "done")
          + stepLI(2, "First-run setup", "done")
          + stepLI(3, "docker compose up", "active")
          + stepLI(4, "Status", "")
          + stepLI(5, "Healthcheck", "")
        + "</ol>"
        + '<pre class="logtail" id="dlog"></pre>'
      + "</div>";
    // tick a deploy timer + stream compose log
    var t0 = performance.now();
    var timer = document.getElementById("dtimer");
    var interval = setInterval(function () {
      timer.textContent = ((performance.now() - t0) / 1000).toFixed(1) + "s";
    }, 100);
    var log = document.getElementById("dlog");
    var stepEl = document.getElementById("dstep");
    var lines = [
      { c: "dim", t: "Creating network orbit_refactor-auth_default" },
      { c: "dim", t: "Creating volume  orbit_refactor-auth_pgdata" },
      { c: "",    t: "Creating orbit_refactor-auth-web-1 ... done" },
      { c: "",    t: "Creating orbit_refactor-auth-api-1 ... done" },
      { c: "ok",  t: "Containers running — allocating host ports" },
    ];
    var cancelLog = streamLines(log, lines);
    // advance the active step toward healthcheck
    var stepTimers = [];
    if (!reduced) {
      stepTimers.push(setTimeout(function () {
        setStep("dsteps", 3, "done"); setStep("dsteps", 4, "active");
        if (stepEl) stepEl.textContent = "step 4 of 5";
      }, 3200));
      stepTimers.push(setTimeout(function () {
        setStep("dsteps", 4, "done"); setStep("dsteps", 5, "active");
        if (stepEl) stepEl.textContent = "step 5 of 5";
      }, 5200));
    }
    return function () {
      clearInterval(interval);
      cancelLog();
      stepTimers.forEach(clearTimeout);
    };
  }

  function stepLI(n, label, state) {
    var mk = state === "done"
      ? '<span class="mk"><i data-lucide="check"></i></span>'
      : state === "active"
        ? '<span class="mk"><span class="spin" style="width:13px;height:13px;border-width:2px"></span></span>'
        : '<span class="mk"></span>';
    return '<li class="' + state + '" data-step="' + n + '">'
      + '<span class="num">' + n + "</span>" + mk + "<span>" + label + "</span></li>";
  }

  function setStep(listId, n, state) {
    var li = document.querySelector("#" + listId + ' [data-step="' + n + '"]');
    if (!li) return;
    li.className = state;
    var mk = li.querySelector(".mk");
    if (state === "done") mk.innerHTML = '<i data-lucide="check"></i>';
    else if (state === "active") mk.innerHTML = '<span class="spin" style="width:13px;height:13px;border-width:2px"></span>';
    icons();
  }

  function renderRunning(surf) {
    surfaceEl.innerHTML =
      '<div class="surf__head">'
        + '<span class="surf__title">' + agentGlyphHTML("claude", 16)
          + '<b>refactor-auth</b> <span class="br">orbit</span></span>'
        + '<span class="right"><span class="nowline"><span class="sdot sdot--run"></span>'
          + '<span class="statusword">running · healthy</span></span></span>'
      + "</div>"
      + '<div class="surf__body">'
        + '<div class="sec-h">Runtime</div>'
        + '<div class="svc-list">'
          + svc("web", "3000", "http://localhost:3000", false)
          + svc("api", "8080", "http://localhost:8080", false)
          + svc("tunnel", "https", "https://refactor-auth.trycloudflare.com", true)
        + "</div>"
        + '<div class="commitbox"><span class="lbl">Auto commit message · ready to ship</span>'
          + "<pre>auth: replace legacy token guard with requireSession\n\n"
          + "Introduce a single requireSession() entry point, migrate the 3\n"
          + "remaining call sites, add cookie-path handling and tests.</pre></div>"
        + '<div class="continue" style="margin-top:18px">'
          + '<button class="btn btn--sm btn--solid" tabindex="-1"><i data-lucide="git-commit-horizontal"></i> Commit &amp; push</button>'
          + '<button class="btn btn--sm" tabindex="-1"><i data-lucide="external-link"></i> Open tunnel</button>'
          + '<button class="btn btn--sm" tabindex="-1"><span style="color:var(--accent-cmd)">wos down</span></button>'
        + "</div>"
      + "</div>";
  }

  function svc(name, port, addr, tunnel) {
    var lead = tunnel
      ? '<span class="nm"><i data-lucide="globe" style="width:15px;height:15px;color:var(--info)"></i> ' + name + "</span>"
      : '<span class="nm"><span class="sdot sdot--run"></span> ' + name + ' <span class="ic" style="font-size:11px">:' + port + "</span></span>";
    return '<div class="svc' + (tunnel ? " svc--tunnel" : "") + '">'
      + lead
      + '<span style="font-size:12px;color:var(--muted)">' + (tunnel ? "Cloudflare · HTTPS" : "published") + "</span>"
      + '<span class="addr"><a href="#install" onclick="return false">' + addr + "</a></span>"
      + "</div>";
  }

  function renderSurface(surf) {
    if (surf.kind === "dossier") { renderDossier(); return null; }
    if (surf.kind === "term") return renderTerm(surf);
    if (surf.kind === "deploy") return renderDeploy(surf);
    if (surf.kind === "running") { renderRunning(surf); return null; }
    return null;
  }

  // --- token / context tickers (only on working & focused sessions) ---------
  function startTicker(state) {
    if (reduced) return function () {};
    var iv = setInterval(function () {
      state.sessions.forEach(function (sess) {
        if (!sess.cap) return;
        if (sess.group !== "work" && !(sess.group === "wait" && sess.focus)) return;
        sess.ctx = Math.min(sess.cap, sess.ctx + Math.round(1 + Math.random() * 3));
        sess.tokens += Math.round(2 + Math.random() * 6);
        updateTele(sess);
      });
    }, 900);
    return function () { clearInterval(iv); };
  }

  function updateTele(sess) {
    var row = railBody.querySelector('[data-id="' + sess.id + '"]');
    if (!row) return;
    var p100 = pct(sess), warn = p100 >= 85;
    var meter = row.querySelector("[data-meter]");
    var ctx = row.querySelector("[data-ctx]");
    var tot = row.querySelector("[data-tot]");
    if (meter) { meter.style.width = p100 + "%"; meter.className = "tele__fill" + (warn ? " tele__fill--warn" : ""); }
    if (ctx) { ctx.textContent = sess.ctx + "k"; ctx.className = "tele__ctx" + (warn ? " tele__ctx--warn" : ""); }
    if (tot) tot.textContent = sess.tokens + "k";
  }

  // --- transport (play / pause / scrub / progress) --------------------------
  var state = {
    i: 0, playing: !reduced, raf: 0, elapsed: 0, last: 0,
    sessions: [], cancelSurface: null, cancelTicker: null, toastTimer: 0,
  };

  function buildTransport() {
    var t = "", l = "";
    SCENES.forEach(function (sc, idx) {
      t += '<button class="demo__mk" role="tab" data-scene="' + idx + '" aria-label="Scene '
        + (idx + 1) + ': ' + sc.title + '"><span class="fill"></span></button>';
      l += "<span data-lab=\"" + idx + "\">" + sc.label + "</span>";
    });
    trackEl.innerHTML = t;
    labelsEl.innerHTML = l;
    trackEl.querySelectorAll(".demo__mk").forEach(function (b) {
      b.addEventListener("click", function () { goTo(parseInt(b.dataset.scene, 10)); });
    });
  }

  function setFill(idx, frac) {
    var mk = trackEl.children[idx];
    if (mk) mk.querySelector(".fill").style.width = (frac * 100) + "%";
  }

  function paintMarkers() {
    for (var j = 0; j < SCENES.length; j++) {
      var mk = trackEl.children[j];
      mk.classList.toggle("active", j === state.i);
      mk.classList.toggle("done", j < state.i);
      if (j < state.i) setFill(j, 1);
      if (j > state.i) setFill(j, 0);
    }
    var labs = labelsEl.querySelectorAll("[data-lab]");
    labs.forEach(function (sp, j) { sp.classList.toggle("on", j === state.i); });
    legendEl.textContent = "SCENE " + (state.i + 1) + " / " + SCENES.length;
  }

  function cleanup() {
    cancelAnimationFrame(state.raf);
    if (state.cancelSurface) { state.cancelSurface(); state.cancelSurface = null; }
    if (state.cancelTicker) { state.cancelTicker(); state.cancelTicker = null; }
    if (state.toastTimer) { clearTimeout(state.toastTimer); state.toastTimer = 0; }
  }

  function goTo(idx) {
    cleanup();
    state.i = idx;
    state.elapsed = 0;
    var sc = SCENES[idx];

    // crumb
    crumbProject.textContent = sc.crumb.project;
    crumbBranch.textContent = sc.crumb.branch;

    // sessions + rail
    state.sessions = sc.sessions();
    renderRail(state.sessions);

    // surface
    state.cancelSurface = renderSurface(sc.surface);
    icons();

    // toast (KNOW)
    if (sc.toast) {
      toastTitle.textContent = sc.toast.title;
      toastBody.textContent = sc.toast.body;
      state.toastTimer = setTimeout(function () { toastEl.classList.add("show"); }, reduced ? 0 : 900);
    } else {
      toastEl.classList.remove("show");
    }

    // tickers
    state.cancelTicker = startTicker(state);

    paintMarkers();

    if (state.playing) { state.last = performance.now(); state.raf = requestAnimationFrame(tick); }
  }

  function tick(now) {
    if (!state.playing) return;
    var dt = now - state.last;
    state.last = now;
    state.elapsed += dt;
    var dur = SCENES[state.i].dur;
    setFill(state.i, Math.min(1, state.elapsed / dur));
    if (state.elapsed >= dur) { goTo((state.i + 1) % SCENES.length); return; }
    state.raf = requestAnimationFrame(tick);
  }

  function setPlaying(on) {
    state.playing = on;
    playBtn.innerHTML = on ? '<i data-lucide="pause"></i>' : '<i data-lucide="play"></i>';
    icons();
    if (on) { state.last = performance.now(); state.raf = requestAnimationFrame(tick); }
    else cancelAnimationFrame(state.raf);
  }

  playBtn.addEventListener("click", function () { setPlaying(!state.playing); });

  // --- mobile emulation (Remote control section) ----------------------------
  // The same app, attached to a Claude Code session from a phone over the tunnel.
  // The agent's finished summary types in line-by-line so the screen reads live;
  // the touch dock, composer, and tab bar are the real remote-control affordances.
  // The terminal lines mirror the static chrome already in index.html.
  var MOBILE_OUT = [
    '<span class="ok">●</span> <span class="b">Done.</span> Archived every active OpenSpec',
    "  change after verifying the real code",
    "  with subagents.",
    "",
    '  <span class="b">Summary</span>',
    "",
    '  Implemented <span class="dim">→</span> archived, specs synced:',
    '  <span class="ok">✓</span> add-codex-agent-plugin — 51/51 green',
    '  <span class="ok">✓</span> add-sidebar-session-stream — 278 tests',
    "",
    '  Not implemented <span class="dim">→</span> archived <span class="kw">--skip-specs</span>:',
    '  <span class="bad">✗</span> add-config-validate-command — 0/15',
    '  <span class="bad">✗</span> add-host-terminal-backend — 0/37',
    "",
    '  <span class="b">Checks</span>',
    '  <span class="dim">·</span> openspec list <span class="dim">→</span> no active changes',
    '  <span class="dim">·</span> validate <span class="kw">--strict</span> <span class="ok">→ 34 passed</span>',
    "",
    '<span class="star">✶</span> <span class="dim">Crunched for 5m 19s</span>',
  ];

  function setupMobile() {
    var out = document.getElementById("mphone-out");
    var phone = document.querySelector(".mphone");
    if (!out || !phone) return;
    icons();

    function paint(h) {
      var node = document.createElement("span");
      node.className = "ln";
      node.innerHTML = h || " ";
      out.appendChild(node);
      out.scrollTop = out.scrollHeight;
    }

    if (reduced) { MOBILE_OUT.forEach(paint); return; } // full output, no typing

    var timers = [];
    function clear() { timers.forEach(clearTimeout); timers = []; }
    function run() {
      clear();
      out.innerHTML = "";
      var i = 0;
      (function type() {
        if (i >= MOBILE_OUT.length) { timers.push(setTimeout(run, 6500)); return; } // settle, then loop
        paint(MOBILE_OUT[i++]);
        timers.push(setTimeout(type, 300));
      })();
    }
    run();

    // pause the loop while the phone is scrolled out of view
    if ("IntersectionObserver" in window) {
      new IntersectionObserver(function (entries) {
        entries.forEach(function (e) {
          if (e.isIntersecting) { if (!timers.length) run(); }
          else clear();
        });
      }, { threshold: 0.2 }).observe(phone);
    }
  }

  // pause when the demo scrolls out of view; resume on return (saves cycles)
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (!e.isIntersecting && state.playing) { state._auto = true; setPlaying(false); }
      else if (e.isIntersecting && state._auto) { state._auto = false; if (!reduced) setPlaying(true); }
    });
  }, { threshold: 0.15 });

  // --- boot -----------------------------------------------------------------
  // Optional deep-link: ?scene=1..6 sets the opening scene; ?autoplay=0 starts
  // paused (handy for sharing a specific frame, deep-links, and QA).
  var qs = new URLSearchParams(location.search);
  var startScene = Math.max(0, Math.min(SCENES.length - 1, (parseInt(qs.get("scene"), 10) || 1) - 1));
  if (qs.get("autoplay") === "0") state.playing = false;

  buildTransport();
  goTo(startScene);
  setupMobile();
  playBtn.innerHTML = state.playing ? '<i data-lucide="pause"></i>' : '<i data-lucide="play"></i>';
  icons();
  io.observe(document.querySelector(".demo__frame"));
})();
