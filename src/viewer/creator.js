// The creator's view (step 8a): everything hidden from watchers and from the AIs,
// shown to whoever holds the key. Nothing here changes the world; it only looks.

import * as THREE from "three";
import { api, setCreatorKey, getCreatorKey } from "./api.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const label = (id) => `#${String(id).padStart(2, "0")}`;
const pct = (v) => `${Math.round(v * 100)}%`;

export class Creator {
  constructor({ scene, walkers, ui, stream, camera, terrain, canvas }) {
    Object.assign(this, { walkers, ui, stream, camera, terrain, canvas });
    this.picking = null;
    this.ray = new THREE.Raycaster();
    this.on = false;
    this.web = new WebLines(scene);
    this.showWeb = false;
    this.data = {};
    this.timer = null;
    this.bind();
    if (getCreatorKey()) this.unlock(getCreatorKey(), true);
  }

  bind() {
    $("creatorBtn").addEventListener("click", () => {
      if (this.on) return this.ui.openTab("creator");
      $("keyDialog").classList.remove("hidden");
      $("keyInput").focus();
    });
    $("keyCancel").addEventListener("click", () => $("keyDialog").classList.add("hidden"));
    $("keyForm").addEventListener("submit", (e) => {
      e.preventDefault();
      const k = $("keyInput").value.trim();
      $("keyInput").value = "";
      if (k) this.unlock(k, false);
    });
    $("creatorLock").addEventListener("click", () => this.lock());
    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        $("keyDialog").classList.add("hidden");
        this.closeDialog(false);
        this.endPick(null);
      }
    });
    // The undo countdown ticks down in place.
    setInterval(() => this.tickLog(), 1000);
    $("webToggle").addEventListener("change", (e) => {
      this.showWeb = e.target.checked;
      this.web.lines.visible = this.showWeb;
      if (this.showWeb) this.loadWeb();
    });
  }

  /** Tries the key on a creator-only door before trusting it. */
  async unlock(key, quiet) {
    setCreatorKey(key);
    try {
      await api.creator("overview");
    } catch (err) {
      setCreatorKey("");
      if (!quiet) $("keyMsg").textContent = err.status === 401 ? "That key was not accepted." : "Could not reach the world.";
      return;
    }
    this.on = true;
    document.body.classList.add("creator");
    $("keyDialog").classList.add("hidden");
    $("keyMsg").textContent = "";
    $("creatorBtn").textContent = "creator";
    $("tabCreator").classList.remove("hidden");
    this.stream?.reopen(); // a creator never waits for room
    if (!quiet) this.ui.openTab("creator");
    this.refresh();
    clearInterval(this.timer);
    this.timer = setInterval(() => this.refresh(), 30000);
  }

  lock() {
    setCreatorKey("");
    this.on = false;
    document.body.classList.remove("creator");
    clearInterval(this.timer);
    $("tabCreator").classList.add("hidden");
    $("creatorBtn").textContent = "creator ›";
    this.ui.openTab("chron");
    this.web.lines.visible = false;
    $("webToggle").checked = false;
    this.showWeb = false;
    this.stream?.reopen();
  }

  async refresh() {
    if (!this.on) return;
    try {
      const [overview, history, words, families, log, lore] = await Promise.all(["overview", "history", "words", "families", "log", "lore"].map((w) => (w === "lore" ? api.creator(w).catch(() => null) : api.creator(w))));
      Object.assign(this.data, { overview, history, words, families, log, lore });
      this.logLoadedAt = performance.now();
      this.render();
      if (this.showWeb) this.loadWeb();
    } catch (err) {
      if (err.status === 401) this.lock();
    }
  }

  async loadWeb() {
    try {
      this.data.web = await api.creator("web");
    } catch {}
  }

  update() {
    if (this.showWeb && this.data.web) this.web.update(this.data.web, this.walkers, this.ui.selected);
  }

  // ---------- The panel ----------

  render() {
    const { overview: o, history: h, words: w, families: f } = this.data;
    if (!o) return;
    const winters = o.winters
      .map((x) => `<li><span>year ${x.year}</span><b class="w-${x.kind}">${x.kind}</b><span class="dim">${x.severity.toFixed(2)}×</span></li>`)
      .join("");
    $("creatorBody").innerHTML = `
      <h3>Your acts</h3>
      ${this.renderLog()}
      <h3>Bring newcomers</h3>
      <form class="newcomers" id="newcomersForm">
        <label>how many <input type="number" id="ncCount" min="1" max="12" value="3"></label>
        <label>ages <select id="ncAges"><option value="young">young adults</option><option value="adult">adults</option><option value="mixed">mixed, with children</option></select></label>
        <label>where <select id="ncWhere"><option value="edge">the edge of the known world</option><option value="pick">a spot I choose</option></select></label>
        <button class="btn go" type="submit">Bring them…</button>
      </form>
      <h3>The world</h3>
      <div class="kv"><span>seed</span><b>${o.seed}</b><span>generation</span><b>${o.generation}</b><span>day</span><b>${o.day}</b><span>ground seen</span><b>${o.explored} chunks</b></div>
      <h3>Winters to come</h3>
      <ul class="winters">${winters}</ul>
      <h3>Over time</h3>
      <p class="dim small">${h.days.some((d) => d.partial) ? "Early days are rebuilt from the chronicle: only who lived, was born and died." : ""}</p>
      <div id="charts"></div>
      <h3>Bonds</h3>
      <label class="check"><input type="checkbox" id="webToggleMirror" ${this.showWeb ? "checked" : ""}> show the web of bonds in the world</label>
      <p class="dim small">Cyan: affection (brighter is stronger). Pink: mates. Red: a grudge, pointing from the one who holds it.</p>
      <h3>What they know</h3>
      ${this.renderLore(this.data.lore)}
      <h3>Their tongue</h3>
      ${this.renderWords(w)}
      <h3>Families</h3>
      ${this.renderFamilies(f)}
      <h3>What things truly are</h3>
      ${this.renderMaterials(o.materials)}
    `;
    $("webToggleMirror").addEventListener("change", (e) => {
      $("webToggle").checked = e.target.checked;
      $("webToggle").dispatchEvent(new Event("change"));
    });
    renderCharts($("charts"), h.days);
    this.bindLog();
    $("newcomersForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const params = { count: Number($("ncCount").value), ages: $("ncAges").value };
      if ($("ncWhere").value === "pick") {
        const at = await this.pickGround("Click the ground where the strangers should appear.");
        if (!at) return;
        Object.assign(params, at);
      }
      const entry = await this.act("newcomers", params);
      if (!entry) return;
      // Go and see them: the chronicle entry the act wrote says where they arrived.
      try {
        const r = await api.chronicle(0, 3);
        const told = r.entries.reverse().find((e) => e.data?.ids && typeof e.data.x === "number");
        if (told) {
          this.ui.following = false;
          this.ui.flyTo(told.data.x, told.data.y, { close: true });
        }
      } catch {}
    });
  }

  // ---------- Choosing a place on the ground ----------

  /** Waits for a click on the ground; resolves to a tile, or null if cancelled (Esc). */
  pickGround(prompt) {
    this.endPick(null);
    document.body.classList.add("picking");
    this.toast(`${prompt} Esc to cancel.`);
    return new Promise((resolve) => (this.picking = resolve));
  }

  endPick(result) {
    if (!this.picking) return;
    const resolve = this.picking;
    this.picking = null;
    document.body.classList.remove("picking");
    resolve(result);
  }

  /** A click while picking: which tile of ground lies under it? */
  groundClick(px, py) {
    const r = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((px - r.left) / r.width) * 2 - 1, -((py - r.top) / r.height) * 2 + 1);
    this.ray.setFromCamera(ndc, this.camera);
    const hit = this.ray.intersectObjects(this.terrain.group.children, false)[0];
    if (!hit) {
      this.toast("That is not ground anyone has seen. Click the land.", true);
      return;
    }
    // Nudge into the face that was hit, so a click on a wall's side picks the wall's tile.
    const p = hit.point.clone().addScaledVector(hit.face?.normal ?? new THREE.Vector3(), -0.01);
    this.endPick({ x: Math.round(p.x), y: Math.round(p.z) });
  }

  // ---------- The private log, with undo ----------

  renderLog() {
    const entries = this.data.log?.entries ?? [];
    if (!entries.length) return `<p class="dim small">Nothing done yet. Every act is kept here, and the last one can be undone for ten minutes.</p>`;
    return `<ul class="act-log">${entries
      .slice(0, 30)
      .map(
        (e) => `<li>
          <span class="when">${esc(e.when.replace(/\s*\((day|night)\)$/, ""))} · ${new Date(e.at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>
          <span class="${e.undone ? "undone" : ""}">${esc(e.summary)}${e.nature ? `<br><span class="dim small">told: “${esc(e.nature)}”</span>` : ""}</span>
          ${e.undoableFor > 0 && !e.undone ? `<button class="btn" data-undo="${e.id}">undo <span data-left="${e.id}"></span></button>` : ""}
        </li>`,
      )
      .join("")}</ul>`;
  }

  bindLog() {
    document.querySelectorAll("#creatorBody [data-undo]").forEach((b) => b.addEventListener("click", () => this.undo(Number(b.dataset.undo))));
    this.tickLog();
  }

  /** Counts the undo window down without asking the server every second. */
  tickLog() {
    const entries = this.data.log?.entries;
    if (!entries || !this.on) return;
    const passed = performance.now() - (this.logLoadedAt ?? 0);
    for (const e of entries) {
      const el = document.querySelector(`#creatorBody [data-left="${e.id}"]`);
      if (!el) continue;
      const left = e.undoableFor - passed;
      if (left <= 0) {
        el.closest("button")?.remove();
        continue;
      }
      const m = Math.floor(left / 60000), sec = Math.floor((left % 60000) / 1000);
      el.textContent = `${m}:${String(sec).padStart(2, "0")}`;
    }
  }

  // ---------- Doing things: preview, confirm, act ----------

  /** Shows what will happen and waits for a yes or no. Grave acts need two steps. */
  confirmDialog({ title, lines, note, grave, go }) {
    const d = $("actDialog");
    $("actTitle").textContent = title;
    $("actLines").innerHTML = lines.map((l) => `<li>${esc(l)}</li>`).join("");
    $("actNote").textContent = note ?? "";
    d.classList.toggle("grave", !!grave);
    const btn = $("actGo");
    btn.className = `btn ${grave ? "danger" : "go"}`;
    btn.textContent = grave ? "I understand" : go;
    d.classList.remove("hidden");
    btn.focus();
    return new Promise((resolve) => {
      let armed = !grave;
      this.closeDialog = (answer) => {
        d.classList.add("hidden");
        this.closeDialog = () => {};
        resolve(answer);
      };
      btn.onclick = () => {
        if (!armed) {
          armed = true;
          btn.textContent = go;
          return;
        }
        this.closeDialog(true);
      };
      $("actCancel").onclick = () => this.closeDialog(false);
    });
  }

  closeDialog() {}

  toast(text, bad = false) {
    const t = $("creatorToast");
    t.textContent = text;
    t.classList.toggle("bad", bad);
    t.classList.add("show");
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => t.classList.remove("show"), 4500);
  }

  /** Any act, the same way: preview, confirm, do, report. */
  async act(kind, params) {
    try {
      const { preview } = await api.creatorPost("act", { kind, params });
      const yes = await this.confirmDialog({
        title: preview.title,
        lines: preview.lines,
        note: `A snapshot is taken first: you can undo this for ${preview.undoMinutes} minutes.`,
        grave: preview.grave,
        go: "Do it",
      });
      if (!yes) return null;
      const { entry } = await api.creatorPost("act", { kind, params, confirm: true });
      this.toast(entry.summary);
      await this.refresh();
      return entry;
    } catch (err) {
      this.toast(err.message, true);
      return null;
    }
  }

  async undo(id) {
    try {
      const { preview } = await api.creatorPost("undo", { id });
      const lost = preview.lostMinutes >= 120 ? `${(preview.lostMinutes / 60).toFixed(1)} hours` : preview.lostMinutes < 1 ? "less than a minute" : preview.lostMinutes === 1 ? "1 minute" : `${preview.lostMinutes} minutes`;
      const yes = await this.confirmDialog({
        title: "Undo",
        lines: [`The world goes back to the moment before: ${preview.summary}`, `Everything that happened since (${lost} of world time) is undone with it.`],
        note: "Undo is one step only: after this, nothing earlier can be undone.",
        grave: true,
        go: "Undo it",
      });
      if (!yes) return;
      await api.creatorPost("undo", { id, confirm: true });
      this.toast("Undone. The world is as it was.");
      await this.refresh();
    } catch (err) {
      this.toast(err.message, true);
    }
  }

  renderLore(l) {
    if (!l) return `<p class="dim">Not recorded on this server yet.</p>`;
    if (!l.ways.length) return `<p class="dim">They know nothing yet that the world keeps count of.</p>`;
    const who = (id) => (id === null ? "known before the record" : `found by #${String(id).padStart(2, "0")}`);
    const rows = l.ways
      .slice(0, 40)
      .map((w) => {
        const fate = w.known === 0 ? `<b class="w-bitter">lost</b>` : `<b>${w.known}</b>`;
        const went = [w.passed ? `passed on ${w.passed}×` : "", w.hands > 1 ? `${w.hands} hands deep` : "", w.generations ? `${w.generations} generations` : "", w.losses ? `lost ${w.losses}×` : ""].filter(Boolean).join(" · ");
        return `<li><span class="concept" title="${esc(w.name)}">${esc(w.name)}</span>${fate}<span class="dim">${who(w.foundBy)}${went ? ` · ${went}` : ""}</span></li>`;
      })
      .join("");
    return `<p class="dim small">Every way the world remembers, the most widely known first: how many know it now, who found it, how far it has gone.</p><ul class="words">${rows}</ul>`;
  }

  renderWords(w) {
    if (!w.concepts.length) return `<p class="dim">No words yet. The world is still silent.</p>`;
    const head = w.worldName
      ? `<p>The world is called <b class="hl">${esc(w.worldName)}</b>.</p>`
      : `<p class="dim small">The world has no name yet (${pct(w.worldNameShare)} agree on one; it takes 60%).</p>`;
    const rows = w.concepts
      .slice()
      .sort((a, b) => b.share - a.share)
      .map((c) => {
        const [top, ...rivals] = c.words;
        return `<li><span class="concept" title="${esc(c.label)}">${esc(c.label)}</span><b>${esc(top?.w ?? "—")}</b><span class="dim">${pct(c.share)}${rivals.length ? ` · also ${rivals.slice(0, 3).map((r) => esc(r.w)).join(", ")}` : ""}</span></li>`;
      })
      .join("");
    return `${head}<ul class="words">${rows}</ul>`;
  }

  renderFamilies(f) {
    const people = new Map(f.people.map((p) => [p.id, p]));
    const children = new Map();
    for (const p of f.people) {
      if (!p.parents) continue;
      for (const parent of p.parents) {
        if (!children.has(parent)) children.set(parent, []);
        children.get(parent).push(p.id);
      }
    }
    if (children.size === 0) return `<p class="dim">No children have been born yet. Every family is still one generation deep.</p>`;
    const seen = new Set();
    const node = (id, depth) => {
      const p = people.get(id);
      const kids = (children.get(id) ?? []).filter((k, i, a) => a.indexOf(k) === i);
      const status = p?.alive ? "" : p?.cause ? ` <span class="dim">· died of ${esc(p.cause)}</span>` : ` <span class="dim">· gone</span>`;
      if (seen.has(id) || depth > 12) return `<li><span class="link" data-ai="${id}">${label(id)}</span> <span class="dim">(above)</span></li>`;
      seen.add(id);
      return `<li><span class="${p?.alive ? "link" : "dead"}" ${p?.alive ? `data-ai="${id}"` : ""}>${label(id)}</span>${status}${kids.length ? `<ul>${kids.map((k) => node(k, depth + 1)).join("")}</ul>` : ""}</li>`;
    };
    // Roots: parents with no known parents of their own.
    const roots = [...children.keys()].filter((id) => !people.get(id)?.parents).sort((a, b) => a - b);
    const html = `<ul class="tree">${roots.map((r) => node(r, 0)).join("")}</ul>`;
    setTimeout(() => {
      document.querySelectorAll("#creatorBody .tree [data-ai]").forEach((el) => el.addEventListener("click", () => this.ui.select(Number(el.dataset.ai))));
    });
    return html;
  }

  renderMaterials(ms) {
    const props = ["hardness", "sharpness", "flexibility", "mass", "energy", "nourishment", "growth", "reactivity"];
    const head = props.map((p) => `<th title="${p}">${p.slice(0, 4)}</th>`).join("");
    const rows = ms
      .map((m) => `<tr><td>${m.id}${m.custom ? "*" : ""}</td>${props.map((p) => `<td style="--v:${m.props[p]}">${m.props[p].toFixed(2)}</td>`).join("")}</tr>`)
      .join("");
    return `<div class="scroll"><table class="mats"><thead><tr><th>id</th>${head}</tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  /** Extra rows for the inspector: the numbers behind the words. */
  async hiddenFor(id) {
    if (!this.on) return "";
    let h;
    try {
      h = await api.creator(`ai/${id}`);
    } catch {
      return "";
    }
    const bar = (k, v, signed) => {
      const w = signed ? Math.abs(v) * 50 : v * 100;
      const left = signed ? (v < 0 ? 50 - w : 50) : 0;
      return `<span>${k}</span><span class="bar ${signed ? "signed" : ""}"><i style="left:${left}%;width:${w}%"></i></span><span class="num">${v.toFixed(2)}</span>`;
    };
    const list = (o, signed) => Object.entries(o).map(([k, v]) => bar(k, v, signed)).join("");
    const bonds = h.bonds.map((b) => `<li><span class="${b.alive ? "link" : "dead"}" ${b.alive ? `data-ai="${b.id}"` : ""}>${label(b.id)}</span> <span class="dim">affection ${b.affection.toFixed(2)} · trust ${b.trust.toFixed(2)}</span></li>`).join("");
    const grudges = h.grudges.length ? h.grudges.map((g) => `<li><span class="link" data-ai="${g.id}">${label(g.id)}</span> <span class="dim">${g.strength.toFixed(2)}</span></li>`).join("") : `<li class="dim">none</li>`;
    return `
      <div class="hidden-block">
        <h3>Creator</h3>
        <div class="creator-acts">
          <button class="btn" data-act="heal" data-id="${h.id}" title="Health full, poison and injuries gone">Heal</button>
          <button class="btn" data-act="calm" data-id="${h.id}" title="Fear and anger fall away; grief softens">Calm</button>
          <button class="btn" data-act="inspire" data-id="${h.id}" title="A restless wish to see new things">Inspire</button>
          <button class="btn" data-act="move" data-id="${h.id}" title="Set it down somewhere else">Move…</button>
          <button class="btn danger" data-act="remove" data-id="${h.id}" title="Take it from the world (a death)">Remove…</button>
        </div>
        <h3>Hidden · life</h3>
        <div class="kv"><span>lived</span><b>${pct(h.lifeFraction)} of its span</b><span>days left</span><b>about ${h.daysLeft}</b><span>poison</span><b>${h.toxin.toFixed(2)}</b><span>parents</span><b>${h.parents ? h.parents.map(label).join(" & ") : "none (a founder)"}</b></div>
        <h3>Hidden · nature</h3><div class="bars">${list(h.personality, true)}</div>
        <h3>Hidden · feelings</h3><div class="bars">${list(h.emotions, false)}</div>
        <h3>Hidden · skill</h3><div class="bars">${list(h.skills, false)}</div>
        <h3>Hidden · closest to</h3><ul class="plain">${bonds || `<li class="dim">no one yet</li>`}</ul>
        <h3>Hidden · grudges</h3><ul class="plain">${grudges}</ul>
      </div>`;
  }
}

/** Lines of the bond web, drawn between the figures where they stand. */
class WebLines {
  constructor(scene) {
    this.max = 6000;
    this.pos = new Float32Array(this.max * 2 * 3);
    this.col = new Float32Array(this.max * 2 * 3);
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute("color", new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    this.lines = new THREE.LineSegments(
      g,
      new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }),
    );
    this.lines.frustumCulled = false;
    this.lines.visible = false;
    this.lines.name = "bond-web";
    scene.add(this.lines);
  }

  update(web, walkers, selected) {
    let n = 0;
    const put = (a, b, ha, hb, r, gr, bl) => {
      if (n >= this.max) return;
      this.pos.set([a.dx, a.gy + ha, a.dy, b.dx, b.gy + hb, b.dy], n * 6);
      this.col.set([r, gr, bl, r, gr, bl], n * 6);
      n++;
    };
    const focus = (id) => selected === null || id === selected;
    for (const e of web.edges) {
      const a = walkers.list.get(e.a), b = walkers.list.get(e.b);
      if (!a || !b || a.dx === undefined || b.dx === undefined) continue;
      const mated = a && walkers.mates.get(e.a) === e.b;
      const k = (focus(e.a) || focus(e.b) ? 1 : 0.2) * (0.25 + 0.75 * Math.max(0, (e.affection - 0.3) / 0.7));
      if (mated) put(a, b, 1.6, 1.6, 1.6 * k, 0.5 * k, 1.2 * k);
      else put(a, b, 1.6, 1.6, 0.2 * k, 0.9 * k, 1.3 * k);
    }
    for (const g of web.grudges) {
      const a = walkers.list.get(g.from), b = walkers.list.get(g.to);
      if (!a || !b || a.dx === undefined || b.dx === undefined) continue;
      const k = (focus(g.from) || focus(g.to) ? 1 : 0.25) * (0.4 + g.strength);
      // Brighter at the end that holds the grudge.
      if (n >= this.max) break;
      this.pos.set([a.dx, a.gy + 1.2, a.dy, b.dx, b.gy + 1.2, b.dy], n * 6);
      this.col.set([2.0 * k, 0.2 * k, 0.25 * k, 0.5 * k, 0.05 * k, 0.06 * k], n * 6);
      n++;
    }
    const geo = this.lines.geometry;
    geo.setDrawRange(0, n * 2);
    geo.attributes.position.needsUpdate = true;
    geo.attributes.color.needsUpdate = true;
  }
}

// ---------- Charts: small multiples, one measure each ----------

const CHARTS = [
  { key: "alive", title: "Alive", fmt: (v) => v.toFixed(0) },
  { key: "born", title: "Born per day", fmt: (v) => v.toFixed(0), bars: true },
  { key: "died", title: "Died per day", fmt: (v) => v.toFixed(0), bars: true },
  { key: "pairs", title: "Pairs", fmt: (v) => v.toFixed(0) },
  { key: "children", title: "Children", fmt: (v) => v.toFixed(0) },
  { key: "built", title: "Blocks standing", fmt: (v) => v.toFixed(0), get: (d) => (d.walls ?? NaN) + (d.roofs ?? NaN) },
  { key: "sharedWords", title: "Shared words", fmt: (v) => v.toFixed(0) },
  { key: "energy", title: "Average energy", fmt: pct, max: 1 },
  { key: "joy", title: "Average joy", fmt: pct, max: 1 },
  { key: "fear", title: "Average fear", fmt: pct, max: 1 },
  { key: "explored", title: "Ground seen (chunks)", fmt: (v) => v.toFixed(0) },
];

function renderCharts(host, days) {
  host.innerHTML = "";
  if (days.length < 2) {
    host.innerHTML = `<p class="dim">The record begins at the next turn of the day.</p>`;
    return;
  }
  for (const c of CHARTS) {
    const pts = days.map((d) => ({ day: d.day, v: c.get ? c.get(d) : d[c.key] })).filter((p) => typeof p.v === "number" && !Number.isNaN(p.v));
    if (pts.length < 2) continue;
    host.appendChild(chart(c, pts));
  }
}

function chart(c, pts) {
  const W = 300, H = 74, pad = { l: 30, r: 8, t: 6, b: 16 };
  const x0 = pts[0].day, x1 = pts[pts.length - 1].day;
  const max = c.max ?? Math.max(1, ...pts.map((p) => p.v));
  const X = (d) => pad.l + ((d - x0) / Math.max(1, x1 - x0)) * (W - pad.l - pad.r);
  const Y = (v) => H - pad.b - (v / max) * (H - pad.t - pad.b);
  const fig = document.createElement("figure");
  fig.className = "chart";
  const last = pts[pts.length - 1];
  let marks;
  if (c.bars) {
    const bw = Math.max(1, (W - pad.l - pad.r) / pts.length - 1);
    marks = pts.filter((p) => p.v > 0).map((p) => `<rect x="${X(p.day) - bw / 2}" y="${Y(p.v)}" width="${bw}" height="${H - pad.b - Y(p.v)}" rx="1" class="mark-fill"/>`).join("");
  } else {
    marks = `<polyline class="mark-line" points="${pts.map((p) => `${X(p.day).toFixed(1)},${Y(p.v).toFixed(1)}`).join(" ")}"/>`;
  }
  fig.innerHTML = `
    <figcaption><span>${c.title}</span><b>${c.fmt(last.v)}</b></figcaption>
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${c.title} by day, now ${c.fmt(last.v)}">
      <line class="grid" x1="${pad.l}" x2="${W - pad.r}" y1="${Y(max)}" y2="${Y(max)}"/>
      <line class="axis" x1="${pad.l}" x2="${W - pad.r}" y1="${H - pad.b}" y2="${H - pad.b}"/>
      <text class="tick" x="${pad.l - 4}" y="${Y(max) + 3}" text-anchor="end">${c.fmt(max)}</text>
      <text class="tick" x="${pad.l - 4}" y="${H - pad.b + 3}" text-anchor="end">0</text>
      <text class="tick" x="${pad.l}" y="${H - 3}">day ${x0}</text>
      <text class="tick" x="${W - pad.r}" y="${H - 3}" text-anchor="end">day ${x1}</text>
      ${marks}
      <line class="cross hidden" x1="0" x2="0" y1="${pad.t}" y2="${H - pad.b}"/>
      <circle class="dot hidden" r="3"/>
      <rect class="hit" x="${pad.l}" y="0" width="${W - pad.l - pad.r}" height="${H}"/>
    </svg>
    <div class="tip hidden"></div>`;
  // Hover: a crosshair and the exact value for the nearest day.
  const svg = fig.querySelector("svg");
  const cross = svg.querySelector(".cross"), dot = svg.querySelector(".dot"), tip = fig.querySelector(".tip");
  const hit = svg.querySelector(".hit");
  const show = (ev) => {
    const r = svg.getBoundingClientRect();
    const sx = ((ev.clientX - r.left) / r.width) * W;
    const day = x0 + ((sx - pad.l) / (W - pad.l - pad.r)) * (x1 - x0);
    let best = pts[0];
    for (const p of pts) if (Math.abs(p.day - day) < Math.abs(best.day - day)) best = p;
    cross.setAttribute("x1", X(best.day));
    cross.setAttribute("x2", X(best.day));
    dot.setAttribute("cx", X(best.day));
    dot.setAttribute("cy", Y(best.v));
    cross.classList.remove("hidden");
    dot.classList.remove("hidden");
    tip.classList.remove("hidden");
    tip.textContent = `day ${best.day}: ${c.fmt(best.v)}`;
    tip.style.left = `${(X(best.day) / W) * 100}%`;
  };
  const hide = () => [cross, dot, tip].forEach((e) => e.classList.add("hidden"));
  hit.addEventListener("pointermove", show);
  hit.addEventListener("pointerdown", show);
  hit.addEventListener("pointerleave", hide);
  return fig;
}
