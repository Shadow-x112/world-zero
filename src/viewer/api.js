// Talking to the world: the ground in chunks, the clock, and the live stream.

export const CHUNK = 32;

function b64ToBytes(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Turns the server's packed chunk into typed arrays (heights are little-endian Int16). */
export function decodeChunk(c) {
  const hb = b64ToBytes(c.height);
  const height = new Int16Array(CHUNK * CHUNK);
  const dv = new DataView(hb.buffer);
  for (let i = 0; i < height.length; i++) height[i] = dv.getInt16(i * 2, true);
  const opt = (k) => (c[k] ? b64ToBytes(c[k]) : null);
  return {
    cx: c.cx,
    cy: c.cy,
    rev: c.rev,
    height,
    terrain: b64ToBytes(c.terrain),
    material: b64ToBytes(c.material),
    amount: b64ToBytes(c.amount),
    wear: b64ToBytes(c.wear),
    wall: opt("wall"),
    wallHp: opt("wallHp"),
    roof: opt("roof"),
    roofHp: opt("roofHp"),
    fire: opt("fire"),
  };
}

async function getJson(path) {
  const res = await fetch(path, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    const err = new Error(`${path}: ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

export const api = {
  status: () => getJson("/api/status"),
  palette: () => getJson("/api/palette"),
  chunkIndex: () => getJson("/api/chunks"),
  ais: () => getJson("/api/ais"),
  ai: (id) => getJson(`/api/ai/${id}`),
  chronicle: (since, limit) => getJson(`/api/chronicle?since=${since}&limit=${limit}`),

  /** Fetches chunks in batches of up to 64; calls onBatch with each decoded batch. */
  async chunks(list, onBatch) {
    for (let i = 0; i < list.length; i += 64) {
      const part = list.slice(i, i + 64);
      const q = part.map(([x, y]) => `${x},${y}`).join(";");
      let reply;
      for (let attempt = 0; ; attempt++) {
        try {
          reply = await getJson(`/api/chunkdata?c=${q}`);
          break;
        } catch (err) {
          if (attempt >= 4) throw err;
          await new Promise((r) => setTimeout(r, err.status === 429 ? 2000 * (attempt + 1) : 800 * (attempt + 1)));
        }
      }
      onBatch(reply.chunks.map(decodeChunk), reply.boot);
    }
  },
};

/**
 * Follows the live stream. Reconnects by itself (the browser does this), and tells the
 * caller about snapshots (a fresh start) and changes. If the world is full of watchers
 * the server refuses; we wait and try again.
 */
export function follow({ onSnapshot, onChanges, onState }) {
  let es = null;
  let closed = false;
  let retry = null;
  const open = () => {
    if (closed) return;
    es = new EventSource("/api/stream");
    es.onopen = () => onState?.("live");
    es.onerror = () => {
      onState?.("reconnecting");
      // A refusal (503: too many watchers) closes the stream for good; try later ourselves.
      if (es.readyState === EventSource.CLOSED) {
        clearTimeout(retry);
        retry = setTimeout(open, 30_000);
      }
    };
    es.addEventListener("snapshot", (ev) => onSnapshot(JSON.parse(ev.data)));
    es.addEventListener("changes", (ev) => onChanges(JSON.parse(ev.data)));
  };
  open();
  return () => {
    closed = true;
    clearTimeout(retry);
    es?.close();
  };
}
