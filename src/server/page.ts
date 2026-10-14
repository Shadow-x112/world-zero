// A small status page served at "/": enough to check on the world from a phone.
// (The 3D viewer is step 7; this is the caretaker's window.)

import { SPEEDS } from "../core/constants.ts";

export const STATUS_PAGE = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>World Zero</title>
<style>
  :root { --bg:#0e1013; --panel:#161a1f; --line:#262c33; --text:#e6e8ea; --dim:#8b949e; --accent:#d9a441; --ok:#5fb37a; --bad:#d9634a; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 980px; margin: 0 auto; padding: 20px 16px 48px; }
  h1 { font-size: 20px; letter-spacing: .04em; margin: 0 0 2px; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .08em; color: var(--dim); margin: 0 0 10px; font-weight: 600; }
  .sub { color: var(--dim); margin: 0 0 18px; }
  .panel { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; margin-bottom: 14px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 10px 16px; }
  .stat b { display:block; font-size: 18px; font-weight: 600; }
  .stat span { color: var(--dim); font-size: 12px; }
  .row { display:flex; flex-wrap:wrap; gap:8px; align-items:center; }
  button, select, input { background:#1e242b; color:var(--text); border:1px solid var(--line); border-radius:7px; padding:7px 12px; font:inherit; }
  button { cursor:pointer; } button:hover { border-color: var(--accent); }
  input { min-width: 0; flex: 1; }
  #chron { max-height: 360px; overflow-y: auto; margin:0; padding:0; list-style:none; }
  #chron li { padding: 5px 0; border-bottom: 1px solid var(--line); }
  #chron li:last-child { border-bottom: 0; }
  .when { color: var(--dim); font-size: 12px; display:block; }
  table { width:100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align:left; padding: 5px 6px; border-bottom: 1px solid var(--line); white-space: nowrap; }
  th { color: var(--dim); font-weight: 600; }
  .scroll { overflow-x: auto; }
  .dot { display:inline-block; width:8px; height:8px; border-radius:50%; background:var(--dim); margin-right:6px; }
  .live .dot { background: var(--ok); } .dead .dot { background: var(--bad); }
  #login { max-width: 420px; }
  .hidden { display:none; }
  .msg { color: var(--dim); font-size: 13px; margin-top: 8px; }
</style>
</head>
<body>
<main>
  <h1>World Zero</h1>
  <p class="sub" id="sub">Connecting…</p>

  <section class="panel hidden" id="login">
    <h2>Creator key</h2>
    <form class="row" id="loginForm">
      <input id="key" type="password" autocomplete="current-password" placeholder="Paste your creator key" aria-label="Creator key">
      <button type="submit">Enter</button>
    </form>
    <p class="msg" id="loginMsg">Only the creator can change the world. The key is in the server's settings (CREATOR_KEY).</p>
  </section>

  <div id="app">
    <section class="panel">
      <div class="row" style="justify-content:space-between; margin-bottom:10px">
        <h2 style="margin:0"><span id="conn" class="dead"><span class="dot"></span><span id="connText">offline</span></span></h2>
        <button id="creatorBtn">Creator</button>
        <div class="row hidden" id="controls">
          <button data-act="pause">Pause</button>
          <button data-act="resume">Resume</button>
          <select id="speed" aria-label="Speed">${SPEEDS.filter((s) => s > 0).map((s) => `<option value="${s}">${s}x</option>`).join("")}</select>
          <button data-act="save">Save</button>
          <button data-act="backup">Backup</button>
          <button id="download">Download save</button>
          <button id="logout">Lock</button>
        </div>
      </div>
      <div class="grid" id="stats"></div>
      <p class="msg" id="ctlMsg"></p>
    </section>

    <section class="panel">
      <h2>Chronicle</h2>
      <ul id="chron"></ul>
    </section>

    <section class="panel">
      <h2>The living</h2>
      <div class="scroll"><table id="ais"><thead><tr><th>Who</th><th>Doing</th><th>Age</th><th>Health</th><th>Energy</th><th>Rest</th><th>Feels</th><th>Nature</th></tr></thead><tbody></tbody></table></div>
    </section>
  </div>
</main>
<script>
(() => {
  const $ = (id) => document.getElementById(id);
  let key = "";
  try { key = localStorage.getItem("wz-key") || ""; } catch {}
  let es = null, lastChron = 0, timer = null;

  const pct = (v) => Math.round(v * 100) + "%";
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;" }[c]));

  async function api(path, opts = {}) {
    const headers = { ...(opts.headers || {}) };
    if (key) headers.Authorization = "Bearer " + key;
    return fetch(path, { ...opts, headers });
  }

  function lock(msg) {
    key = ""; try { localStorage.removeItem("wz-key"); } catch {}
    $("controls").classList.add("hidden"); $("creatorBtn").classList.remove("hidden");
    $("ctlMsg").textContent = msg || "";
    connect();
  }

  /** Checks the key against a creator-only door before showing the controls. */
  async function unlock() {
    const res = await api("/api/materials").catch(() => null);
    if (!res || res.status === 401) { key = ""; $("loginMsg").textContent = "That key was not accepted."; return; }
    try { localStorage.setItem("wz-key", key); } catch {}
    $("login").classList.add("hidden"); $("controls").classList.remove("hidden"); $("creatorBtn").classList.add("hidden");
    $("ctlMsg").textContent = "";
    connect();
  }

  async function start() {
    await refresh(); timer = setInterval(refresh, 10000);
    loadChronicle(); connect();
    if (key) unlock();
  }

  function stat(label, value) { return '<div class="stat"><b>' + esc(value) + '</b><span>' + esc(label) + '</span></div>'; }

  async function refresh() {
    const res = await api("/api/status");
    if (res.status === 503) { $("sub").textContent = "Waiting for a world to be brought here."; return; }
    if (!res.ok) return;
    const s = await res.json();
    $("sub").textContent = (s.name ? s.name + " · " : "") + "Generation " + s.generation + (s.seed !== undefined ? " · seed " + s.seed : "");
    $("speed").value = String(s.speed || 1);
    $("stats").innerHTML = [
      stat("date", s.date), stat("speed", s.paused ? "paused" : s.speed + "x"),
      stat("alive", s.alive + " (" + s.asleep + " asleep)"), stat("born / died", s.born + " / " + s.dead),
      stat("built", s.walls + " walls, " + s.roofs + " roofs"), stat("fires", s.fires),
      stat("ticks per second", s.ticksPerSecond.toFixed(1) + (s.lagging ? " lagging" : "")),
      stat("light", pct(s.light)),
    ].join("");
    const ais = await (await api("/api/ais")).json();
    $("ais").querySelector("tbody").innerHTML = ais.ais.map((a) =>
      "<tr><td>" + esc(a.label) + "</td><td>" + esc(a.doing) + "</td><td>" + Math.floor(a.ageDays) + "d</td><td>" + pct(a.health) +
      "</td><td>" + pct(a.needs.energy) + "</td><td>" + pct(a.needs.rest) + "</td><td>" + esc(a.feelings.join(", ")) +
      "</td><td>" + esc(a.nature.join(", ")) + "</td></tr>").join("");
  }

  function addChron(entries) {
    const list = $("chron");
    for (const e of entries) {
      if (e.id <= lastChron) continue;
      lastChron = e.id;
      const li = document.createElement("li");
      li.innerHTML = '<span class="when">' + esc(e.when) + '</span>' + esc(e.text);
      list.prepend(li);
    }
  }

  async function loadChronicle() {
    const res = await api("/api/chronicle?limit=60"); if (!res.ok) return;
    addChron((await res.json()).entries);
  }

  function connect() {
    if (es) es.close();
    es = new EventSource("/api/stream" + (key ? "?key=" + encodeURIComponent(key) : ""));
    es.onopen = () => { $("conn").className = "live"; $("connText").textContent = "live"; };
    es.onerror = () => { $("conn").className = "dead"; $("connText").textContent = "reconnecting (the world may be full of watchers)"; };
    es.addEventListener("changes", (ev) => { const c = JSON.parse(ev.data); if (c.chronicle.length) addChron(c.chronicle); });
    es.addEventListener("snapshot", () => {});
  }

  async function control(body) {
    const res = await api("/api/control", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const out = await res.json();
    $("ctlMsg").textContent = res.ok ? (out.backup ? "Backup written." : body.action === "save" ? "Saved." : "Done.") : out.error;
    refresh();
  }

  document.querySelectorAll("[data-act]").forEach((b) => b.addEventListener("click", () => control({ action: b.dataset.act })));
  $("speed").addEventListener("change", (e) => control({ action: "speed", speed: Number(e.target.value) }));
  $("logout").addEventListener("click", () => lock("Locked."));
  $("creatorBtn").addEventListener("click", () => { $("login").classList.toggle("hidden"); $("key").focus(); });
  $("download").addEventListener("click", async () => {
    $("ctlMsg").textContent = "Preparing the save…";
    const res = await api("/api/admin/save"); if (!res.ok) { $("ctlMsg").textContent = "Could not download."; return; }
    const name = (res.headers.get("Content-Disposition") || "").match(/filename="([^"]+)"/)?.[1] || "world.json.gz";
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement("a"); a.href = url; a.download = name; a.click(); URL.revokeObjectURL(url);
    $("ctlMsg").textContent = "Downloaded " + name + ".";
  });
  $("loginForm").addEventListener("submit", (e) => { e.preventDefault(); key = $("key").value.trim(); $("key").value = ""; unlock(); });

  start();
})();
</script>
</body>
</html>`;
