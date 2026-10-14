// The viewer's interface: pick an AI and follow it, read about it, read the world's
// history as it happens, and jump to where things happened.

import * as THREE from "three";
import { accentCss } from "./figures.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const pct = (v) => `${Math.round(v * 100)}%`;
/** "Year 1, Peak day 9, 16:46 (day)" without the "(day)". */
const plainWhen = (w) => String(w).replace(/\s*\((day|night)\)$/, "");
const ease = (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);

/** Who an entry is about: ids in its data, then "#12" in its text. */
const ID_KEYS = ["agentId", "a", "b", "taker", "victim", "child", "mother", "father", "teacher", "learner", "toward"];
function idsOf(entry) {
  const out = [];
  const d = entry.data || {};
  for (const k of ID_KEYS) if (typeof d[k] === "number") out.push(d[k]);
  if (Array.isArray(d.ids) && d.ids.length <= 4) for (const id of d.ids) if (typeof id === "number") out.push(id);
  for (const m of String(entry.text).matchAll(/#(\d+)/g)) out.push(Number(m[1]));
  return [...new Set(out)];
}

export class Ui {
  constructor({ camera, controls, walkers, terrain, api, canvas }) {
    Object.assign(this, { camera, controls, walkers, terrain, api, canvas });
    this.selected = null;
    this.following = false;
    this.flight = null;
    this.lastChron = 0;
    this.people = [];
    this.toastQueue = [];
    this.toastBusy = false;
    this.inspTimer = null;
    this.tags = new Map();
    this.tmp = new THREE.Vector3();
    this.bindPicking();
    this.bindPanels();
    this.bindKeys();
    // On phones the chronicle starts tucked away so the world gets the screen.
    this.narrow = matchMedia("(max-width: 760px)");
    if (this.narrow.matches) this.showSide(false);
    window.addEventListener("resize", () => this.applyViewShift());
  }

  /**
   * On a phone the inspector covers the lower half of the screen, so the picture is
   * shifted up: what the camera looks at (the followed AI) sits in the visible part.
   */
  applyViewShift() {
    const w = window.innerWidth, h = window.innerHeight;
    if (this.narrow.matches && this.selected !== null) this.camera.setViewOffset(w, h, 0, Math.round(h * 0.24), w, h);
    else this.camera.clearViewOffset();
    this.camera.updateProjectionMatrix();
  }

  // ---------- Picking and following ----------

  bindPicking() {
    let down = null;
    this.canvas.addEventListener("pointerdown", (e) => {
      down = { x: e.clientX, y: e.clientY, t: performance.now(), button: e.button, moved: false };
    });
    this.canvas.addEventListener("pointermove", (e) => {
      if (!down) return;
      if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6) {
        down.moved = true;
        // Dragging the ground (not turning) means "take me elsewhere": stop following.
        if (down.button === 0 && this.following) this.following = false;
      }
    });
    this.canvas.addEventListener("pointerup", (e) => {
      if (!down) return;
      const click = !down.moved && performance.now() - down.t < 600 && down.button === 0;
      down = null;
      if (!click) return;
      const id = this.pick(e.clientX, e.clientY);
      if (id !== null) this.select(id);
    });
  }

  /** The figure nearest a point on screen (within a finger's width), or null. */
  pick(px, py) {
    const rect = this.canvas.getBoundingClientRect();
    const touch = matchMedia("(pointer: coarse)").matches;
    let best = null;
    let bestD = touch ? 36 : 26;
    for (const w of this.walkers.list.values()) {
      if (w.dx === undefined) continue;
      for (const h of [0.3, 0.9, 1.4]) {
        this.tmp.set(w.dx, w.gy + h * (w.k ? 0.66 : 1), w.dy).project(this.camera);
        if (this.tmp.z > 1) continue;
        const sx = rect.left + (this.tmp.x * 0.5 + 0.5) * rect.width;
        const sy = rect.top + (-this.tmp.y * 0.5 + 0.5) * rect.height;
        const d = Math.hypot(sx - px, sy - py);
        if (d < bestD) {
          bestD = d;
          best = w.id;
        }
      }
    }
    return best;
  }

  select(id, { follow = true } = {}) {
    this.selected = id;
    this.following = follow;
    const p = this.walkers.position(id);
    if (p) this.flyTo(p.x, p.y, { close: true });
    $("inspector").classList.remove("hidden");
    this.applyViewShift();
    this.renderPeople();
    this.loadInspector(true);
    clearInterval(this.inspTimer);
    this.inspTimer = setInterval(() => this.loadInspector(false), 2500);
  }

  deselect() {
    this.selected = null;
    this.following = false;
    clearInterval(this.inspTimer);
    $("inspector").classList.add("hidden");
    this.applyViewShift();
    this.renderPeople();
  }

  cycle(step) {
    const ids = [...this.walkers.list.keys()].sort((a, b) => a - b);
    if (!ids.length) return;
    const i = this.selected === null ? -1 : ids.indexOf(this.selected);
    this.select(ids[(i + step + ids.length) % ids.length]);
  }

  /** Glides the camera over a point (keeping the current angle). */
  flyTo(x, z, { close = false } = {}) {
    const t = this.controls.target;
    const off = this.camera.position.clone().sub(t);
    if (close) off.setLength(Math.min(off.length(), 26));
    const gy = this.terrain.groundY(x, z);
    this.flight = {
      t0: performance.now(),
      dur: 1100,
      fromT: t.clone(),
      toT: new THREE.Vector3(x, gy, z),
      fromP: this.camera.position.clone(),
      toP: new THREE.Vector3(x, gy, z).add(off),
    };
  }

  /** Per frame: flights, following, and name tags. Returns true while it steers the camera. */
  update(now) {
    let steering = false;
    if (this.flight) {
      const f = this.flight;
      const k = Math.min(1, (now - f.t0) / f.dur);
      // A followed AI keeps moving during the flight: aim at where it is now.
      if (this.following && this.selected !== null) {
        const p = this.walkers.position(this.selected);
        if (p) {
          const dx = p.x - f.toT.x, dz = p.y - f.toT.z;
          f.toT.x += dx; f.toT.z += dz; f.toP.x += dx; f.toP.z += dz;
        }
      }
      const e = ease(k);
      this.controls.target.lerpVectors(f.fromT, f.toT, e);
      this.camera.position.lerpVectors(f.fromP, f.toP, e);
      if (k >= 1) this.flight = null;
      steering = true;
    } else if (this.following && this.selected !== null) {
      const p = this.walkers.position(this.selected);
      if (p) {
        const t = this.controls.target;
        const dx = (p.x - t.x) * 0.12;
        const dz = (p.y - t.z) * 0.12;
        const dy = (p.ground + 0.8 - t.y) * 0.08;
        t.x += dx; t.y += dy; t.z += dz;
        this.camera.position.x += dx; this.camera.position.y += dy; this.camera.position.z += dz;
        steering = true;
      }
    }
    this.updateTags();
    return steering;
  }

  // ---------- Name tags over figures ----------

  updateTags() {
    const want = new Map();
    const dist = this.camera.position.distanceTo(this.controls.target);
    const sel = this.selected;
    const mate = sel !== null ? this.walkers.mates.get(sel) : undefined;
    if (sel !== null) want.set(sel, "sel");
    if (mate !== undefined) want.set(mate, "mate");
    // Close in, everyone near the focus is named.
    if (dist < 34) {
      for (const w of this.walkers.list.values()) {
        if (want.size >= 40) break;
        if (w.dx === undefined || want.has(w.id)) continue;
        if (Math.hypot(w.dx - this.controls.target.x, w.dy - this.controls.target.z) < dist * 1.2) want.set(w.id, "");
      }
    }
    const rect = this.canvas.getBoundingClientRect();
    for (const [id, el] of this.tags) {
      if (!want.has(id)) {
        el.remove();
        this.tags.delete(id);
      }
    }
    for (const [id, kind] of want) {
      const w = this.walkers.list.get(id);
      if (!w || w.dx === undefined) continue;
      let el = this.tags.get(id);
      if (!el) {
        el = document.createElement("div");
        el.textContent = `#${String(id).padStart(2, "0")}`;
        $("labels").appendChild(el);
        this.tags.set(id, el);
      }
      el.className = `tag ${kind}`;
      const lying = w.a === "sleep";
      this.tmp.set(w.dx, w.gy + (lying ? 0.7 : 1.85) * (w.k ? 0.66 : 1) * (this.walkers.zoom ?? 1), w.dy).project(this.camera);
      if (this.tmp.z > 1 || Math.abs(this.tmp.x) > 1.1 || Math.abs(this.tmp.y) > 1.1) {
        el.style.display = "none";
        continue;
      }
      el.style.display = "";
      el.style.left = `${(this.tmp.x * 0.5 + 0.5) * rect.width}px`;
      el.style.top = `${(-this.tmp.y * 0.5 + 0.5) * rect.height}px`;
    }
  }

  // ---------- Inspector ----------

  async loadInspector(first) {
    const id = this.selected;
    if (id === null) return;
    let a;
    try {
      a = await this.api.ai(id);
    } catch (err) {
      if (err.status === 404) a = { alive: false, id, unknown: true };
      else return;
    }
    if (this.selected !== id) return; // chose someone else meanwhile
    this.renderInspector(a, first);
  }

  renderInspector(a, first) {
    const name = `#${String(a.id).padStart(2, "0")}`;
    $("inspName").textContent = name;
    const body = $("inspBody");
    if (!a.alive) {
      this.following = false;
      $("inspSub").textContent = "no longer living";
      body.innerHTML = a.unknown
        ? `<p class="gone">No one by this name has lived here.</p>`
        : `<p class="gone">Died of ${esc(a.cause)} at ${Math.floor(a.ageDays)} days.</p>`;
      return;
    }
    $("inspSub").textContent = `${a.grown ? "adult" : "child"} · ${Math.floor(a.ageDays)} days old${this.following ? "" : " · not following"}`;
    const bar = (label, v) => {
      const cls = v < 0.15 ? "crit" : v < 0.35 ? "low" : "";
      return `<span>${label}</span><span class="bar"><i class="${cls}" style="width:${pct(Math.max(0, Math.min(1, v)))}"></i></span><span class="num">${pct(v)}</span>`;
    };
    const chips = (list, empty) => (list.length ? list.map((w) => `<span class="chip">${esc(w)}</span>`).join("") : `<span class="chip none">${empty}</span>`);
    const mate = a.mate !== null ? `<span class="link" data-ai="${a.mate}">#${String(a.mate).padStart(2, "0")}</span>` : `<span class="chip none">none</span>`;
    const open = body.querySelector("details")?.open ?? false;
    body.innerHTML = `
      <h3>Now</h3>
      <div class="doing" style="color:${accentCss(a.a)}"><span class="ring"></span><span style="color:var(--ink)">${esc(a.doing)}</span>${a.c ? ' <span style="color:var(--dim)">· carrying something</span>' : ""}</div>
      ${this.following ? "" : `<p style="margin:8px 0 0"><span class="link" data-follow="1">follow again</span></p>`}
      <h3>Body</h3>
      <div class="bars">
        ${bar("health", a.health)}
        ${bar("energy", a.needs.energy)}
        ${bar("rest", a.needs.rest)}
        ${bar("company", a.needs.social)}
        ${bar("curiosity", a.needs.curiosity)}
      </div>
      <h3>Feels</h3><div class="chips">${chips(a.feelings, "even-keeled")}</div>
      <h3>Nature</h3><div class="chips">${chips(a.nature, "not yet settled")}</div>
      <h3>Skills</h3><div class="chips">${chips(a.skills, "none yet")}</div>
      <h3>Mate</h3><div>${mate}</div>
      <details ${open ? "open" : ""}><summary>Full record</summary><pre class="record">${esc(a.detail)}</pre></details>
    `;
    body.querySelectorAll("[data-ai]").forEach((el) => el.addEventListener("click", () => this.select(Number(el.dataset.ai))));
    body.querySelector("[data-follow]")?.addEventListener("click", () => this.select(a.id));
    if (first) body.scrollTop = 0;
  }

  // ---------- Chronicle ----------

  async loadChronicle() {
    try {
      const r = await this.api.chronicle(0, 80);
      this.addChronicle(r.entries, false);
    } catch {}
  }

  /** New entries (oldest first). Live ones are announced. */
  addChronicle(entries, live) {
    const list = $("chronList");
    for (const e of entries) {
      if (e.id <= this.lastChron) continue;
      this.lastChron = e.id;
      const li = document.createElement("li");
      li.tabIndex = 0;
      li.innerHTML = `<span class="when">${esc(plainWhen(e.when))}</span>${esc(e.text)}`;
      if (live) li.classList.add("fresh");
      const go = () => this.focusEntry(e);
      li.addEventListener("click", go);
      li.addEventListener("keydown", (ev) => ev.key === "Enter" && go());
      list.prepend(li);
      if (live) this.toast(e);
    }
    while (list.children.length > 300) list.lastChild.remove();
  }

  /** Takes the camera to what an entry is about. */
  focusEntry(e) {
    const d = e.data || {};
    const ids = idsOf(e).filter((id) => this.walkers.list.has(id));
    if (ids.length) {
      this.select(ids[0]);
      return;
    }
    if (typeof d.x === "number" && typeof d.y === "number") {
      this.following = false;
      this.flyTo(d.x, d.y, { close: true });
    }
  }

  toast(e) {
    this.toastQueue.push(e);
    if (this.toastQueue.length > 4) this.toastQueue.shift();
    if (!this.toastBusy) this.nextToast();
  }

  nextToast() {
    const e = this.toastQueue.shift();
    const el = $("toast");
    if (!e) {
      this.toastBusy = false;
      return;
    }
    this.toastBusy = true;
    el.innerHTML = `<span class="when">${esc(plainWhen(e.when))}</span>${esc(e.text)}`;
    el.classList.add("show");
    setTimeout(() => {
      el.classList.remove("show");
      setTimeout(() => this.nextToast(), 600);
    }, 6000);
  }

  // ---------- People ----------

  setPeople(ais) {
    this.people = ais.slice().sort((a, b) => a.id - b.id);
    this.renderPeople();
  }

  renderPeople() {
    const list = $("peopleList");
    if (list.classList.contains("hidden") && list.children.length) {
      // Keep the selection mark current without rebuilding a hidden list.
      for (const li of list.children) li.classList.toggle("selected", Number(li.dataset.id) === this.selected);
      return;
    }
    list.innerHTML = "";
    for (const a of this.people) {
      const li = document.createElement("li");
      li.tabIndex = 0;
      li.dataset.id = a.id;
      li.className = `people-row${a.grown ? "" : " child"}${a.id === this.selected ? " selected" : ""}`;
      li.innerHTML = `<b>#${String(a.id).padStart(2, "0")}</b><span>${esc(a.doing)}${a.grown ? "" : " · child"}</span>`;
      const go = () => this.select(a.id);
      li.addEventListener("click", go);
      li.addEventListener("keydown", (ev) => ev.key === "Enter" && go());
      list.appendChild(li);
    }
  }

  // ---------- Panels and keys ----------

  bindPanels() {
    const tab = (which) => {
      const chron = which === "chron";
      $("tabChron").setAttribute("aria-selected", String(chron));
      $("tabPeople").setAttribute("aria-selected", String(!chron));
      $("chronList").classList.toggle("hidden", !chron);
      $("peopleList").classList.toggle("hidden", chron);
      if (!chron) this.renderPeople();
    };
    $("tabChron").addEventListener("click", () => tab("chron"));
    $("tabPeople").addEventListener("click", () => tab("people"));
    $("sideClose").addEventListener("click", () => this.showSide(false));
    $("sideOpen").addEventListener("click", () => this.showSide(true));
    $("inspClose").addEventListener("click", () => this.deselect());
    $("prevAi").addEventListener("click", () => this.cycle(-1));
    $("nextAi").addEventListener("click", () => this.cycle(1));
  }

  showSide(on) {
    $("side").classList.toggle("hidden", !on);
    $("sideOpen").classList.toggle("hidden", on);
  }

  bindKeys() {
    window.addEventListener("keydown", (e) => {
      if (e.target instanceof HTMLInputElement) return;
      const k = e.key.toLowerCase();
      if (k === "escape") this.deselect();
      else if (k === "c") this.showSide($("side").classList.contains("hidden"));
      else if (k === "[") this.cycle(-1);
      else if (k === "]") this.cycle(1);
      else if (["w", "a", "s", "d", "arrowup", "arrowdown", "arrowleft", "arrowright"].includes(k)) this.following = false;
    });
  }
}
