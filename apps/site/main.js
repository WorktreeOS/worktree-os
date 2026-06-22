/* =============================================================================
 * WorktreeOS site — page chrome: theme, sticky nav, scroll reveals, copy.
 * Pure vanilla, no dependencies beyond the lucide CDN used in index.html.
 * ========================================================================== */
(function () {
  "use strict";

  // --- theme (persisted, defaults to system on first visit) -----------------
  var root = document.documentElement;
  var stored = null;
  try { stored = localStorage.getItem("wos.site.theme"); } catch (e) {}
  if (stored) root.setAttribute("data-theme", stored);
  else if (window.matchMedia("(prefers-color-scheme: dark)").matches) root.setAttribute("data-theme", "dark");

  var themeBtn = document.getElementById("theme");
  function syncThemeIcon() {
    var dark = root.getAttribute("data-theme") === "dark";
    themeBtn.innerHTML = dark ? '<i data-lucide="sun"></i>' : '<i data-lucide="moon"></i>';
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", dark ? "#161614" : "#FBFBFA");
    if (window.lucide) window.lucide.createIcons();
  }
  themeBtn.addEventListener("click", function () {
    var dark = root.getAttribute("data-theme") === "dark";
    var next = dark ? "light" : "dark";
    root.setAttribute("data-theme", next);
    try { localStorage.setItem("wos.site.theme", next); } catch (e) {}
    syncThemeIcon();
  });

  // --- sticky nav hairline once scrolled ------------------------------------
  var nav = document.getElementById("nav");
  function onScroll() { nav.setAttribute("data-stuck", window.scrollY > 8 ? "true" : "false"); }
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  // --- scroll reveal --------------------------------------------------------
  var reveals = document.querySelectorAll(".reveal-up");
  if ("IntersectionObserver" in window) {
    var ro = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) { e.target.classList.add("in"); ro.unobserve(e.target); }
      });
    }, { threshold: 0.12, rootMargin: "0px 0px -8% 0px" });
    reveals.forEach(function (el) { ro.observe(el); });
  } else {
    reveals.forEach(function (el) { el.classList.add("in"); });
  }

  // --- install: OS toggle + copy --------------------------------------------
  var INSTALL = {
    unix: { prompt: "$", cmd: "curl -fsSL https://raw.githubusercontent.com/WorktreeOS/worktree-os/main/install.sh | sh" },
    win:  { prompt: "PS>", cmd: "irm https://raw.githubusercontent.com/WorktreeOS/worktree-os/main/install.ps1 | iex" },
  };
  var tabUnix = document.getElementById("os-unix");
  var tabWin = document.getElementById("os-win");
  var codeEl = document.getElementById("install-code");
  var promptEl = document.getElementById("install-prompt");
  var copyBtn = document.getElementById("copy");
  var currentOS = "unix";

  function selectOS(os) {
    currentOS = os;
    codeEl.textContent = INSTALL[os].cmd;
    promptEl.textContent = INSTALL[os].prompt;
    tabUnix.setAttribute("aria-selected", os === "unix" ? "true" : "false");
    tabWin.setAttribute("aria-selected", os === "win" ? "true" : "false");
  }

  if (tabUnix && tabWin && codeEl) {
    // default to the visitor's platform
    var ua = (navigator.userAgent || "") + " " + (navigator.platform || "");
    if (/Win/i.test(ua)) selectOS("win"); else selectOS("unix");
    tabUnix.addEventListener("click", function () { selectOS("unix"); });
    tabWin.addEventListener("click", function () { selectOS("win"); });
  }

  if (copyBtn) {
    copyBtn.addEventListener("click", function () {
      var cmd = INSTALL[currentOS].cmd;
      var done = function () {
        copyBtn.innerHTML = '<i data-lucide="check"></i> Copied';
        if (window.lucide) window.lucide.createIcons();
        setTimeout(function () {
          copyBtn.innerHTML = '<i data-lucide="copy"></i> Copy';
          if (window.lucide) window.lucide.createIcons();
        }, 1600);
      };
      if (navigator.clipboard) navigator.clipboard.writeText(cmd).then(done, done);
      else done();
    });
  }

  // initial icon paint for nav/theme (demo.js paints its own)
  syncThemeIcon();
  if (window.lucide) window.lucide.createIcons();
})();
