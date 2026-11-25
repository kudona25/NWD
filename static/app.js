/* NWD frontend: live topology map, events, settings. */
"use strict";

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// t() and srv() come from i18n.js (loaded first); `ts` here so it does not shadow t()
const fmtTime = (ts) => (ts ? new Date(ts * 1000).toLocaleString(LOCALE(), { hour12: false }) : "-");
// set inside an exported .html file: show that frozen copy read-only, no server
const SNAP = window.NWD_SNAPSHOT || null;
const hhmm = (ts) => (ts ? new Date(ts * 1000).toLocaleTimeString(LOCALE(), { hour: "2-digit", minute: "2-digit", hour12: false }) : "-");

async function api(method, url, body) {
  const r = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(srv(data.detail) || r.statusText);
  return data;
}

// action = {label, fn}: adds a button (e.g. Undo) and keeps the toast up longer
function toast(msg, bad = false, action = null) {
  const el = $("#toast");
  el.textContent = msg;
  if (action) {
    const b = document.createElement("button");
    b.className = "btn";
    b.textContent = action.label;
    b.onclick = () => { el.classList.add("hidden"); action.fn(); };
    el.append(" ", b);
  }
  el.className = "toast" + (bad ? " bad" : "");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add("hidden"), action ? 10000 : 3000);
}

/* ============================================================ tabs */
function showTab(name) {
  $$(".tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  $$(".tab-body").forEach((s) => s.classList.toggle("active", s.id === "tab-" + name));
  if (name === "events") { unseen = 0; renderBadge(); }
  if (name === "settings") loadSettings();
  if (name === "map" && network) network.redraw();
}
$$(".tab").forEach((b) => (b.onclick = () => { history.replaceState(null, "", "#" + b.dataset.tab); showTab(b.dataset.tab); }));
document.addEventListener("click", (e) => {
  const g = e.target.closest("[data-goto]");
  if (g) { e.preventDefault(); showTab(g.dataset.goto); }
});

/* ============================================================ map */
const statusName = (s) => (["up", "unreachable", "boundary", "suspect", "down"].includes(s) ? t("st." + s) : s);
const MEDIA_TH = { UTP: "UTP", MM: "Fiber MM", SM: "Fiber SM", DAC: "DAC", Unknown: "Unknown" };
const mediaColor = (m) => css({ UTP: "--utp", MM: "--mm", SM: "--sm", DAC: "--dac" }[m] || "--gray");

const LAYOUT = {
  levelH: 170, nodeW: 190, nodeH: 70, apW: 120, apRowH: 62, apCols: 6, apTop: 110,
  leafCols: 4, leafColW: 215, leafRowH: 95, // switches with nothing below them wrap into a grid
  gap: 50, groupGapX: 150, groupGapY: 170, groupPad: 26,
};
let groups = []; // [{key, name, members: [device keys], box}] — one per branch under the seed
let gridLinks = new Set(); // Link ids parent→AP / parent→end switch inside a grid: drawn straight, never bent

let topo = { devices: [], cables: [], seed: "" };
let nodes = new vis.DataSet();
let edges = new vis.DataSet();
let network = null;
let selected = null; // {type:'device'|'link', id}
let firstFit = true;
let needRoute = false; // re-check Link bends on the next frame

function nodeStyle(d) {
  const s = d.status;
  const border = { up: css("--up"), suspect: css("--suspect"), down: css("--down") }[s] || css("--gray");
  const bg = { up: "#12261a", suspect: "#2d2410", down: "#3d1418" }[s] || "#1c2128";
  const isSeed = d.hop === 0;
  if (d.kind === "ap") {
    return {
      shape: "box", margin: { top: 5, bottom: 5, left: 8, right: 8 },
      color: { background: bg, border, highlight: { background: bg, border: css("--accent") }, hover: { background: bg, border: css("--accent") } },
      borderWidth: 1.5, shapeProperties: { borderRadius: 14 },
      font: { color: css("--text"), size: 11, face: css("--font"), multi: false },
      label: "📶 " + d.name,
      widthConstraint: { maximum: LAYOUT.apW - 10 },
    };
  }
  return {
    shape: "box", margin: { top: 8, bottom: 8, left: 12, right: 12 },
    color: { background: bg, border, highlight: { background: bg, border: css("--accent") }, hover: { background: bg, border: css("--accent") } },
    borderWidth: isSeed ? 3.5 : 2, shapeProperties: { borderRadius: 6, borderDashes: s === "boundary" ? [4, 3] : false },
    font: { color: css("--text"), size: 13, face: css("--font"), multi: "html", bold: { color: "#fff", size: 14 }, ital: { color: css("--partial"), size: 11 } },
    label: `<b>${esc(d.name)}</b>\n${esc(d.ip || "")}${d.platform ? "\n" + esc(shortPlatform(d.platform)) : ""}${d.proto === "telnet" ? "\n<i>⚠ TELNET</i>" : ""}`,
  };
}
const shortPlatform = (p) => p.replace(/^cisco\s+/i, "").replace(/^Cisco\s+/i, "").slice(0, 28);

/* ---------- grouped layout
   Seed on top. Every switch directly under the seed that has something below it starts a Group
   (its whole subtree), drawn in its own box; Groups are packed into rows instead of one long line.
   Inside a subtree: APs in a grid under their switch, switches with nothing below them in a grid,
   switches with their own children side by side. Sets `groups`; returns {key: {x, y}}. */
function autoLayout(devices) {
  const L = LAYOUT;
  const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true });
  const byKey = Object.fromEntries(devices.map((d) => [d.key, d]));
  const rawKids = {};
  const roots = [];
  for (const d of devices) {
    if (d.parent && byKey[d.parent] && d.parent !== d.key) (rawKids[d.parent] ||= []).push(d);
    else roots.push(d);
  }
  // each device exactly once, even if parent links loop
  const tree = {};
  const seen = new Set();
  const build = (d) => {
    seen.add(d.key);
    tree[d.key] = (rawKids[d.key] || []).filter((k) => !seen.has(k.key)).sort(byName);
    tree[d.key].forEach((k) => seen.add(k.key));
    tree[d.key].forEach(build);
  };
  roots.sort((a, b) => (a.hop ?? 99) - (b.hop ?? 99) || byName(a, b)).forEach(build);
  for (const d of devices) if (!seen.has(d.key)) { roots.push(d); build(d); }

  const plan = {};
  function measure(d, c = tree[d.key]) {
    const aps = c.filter((x) => x.kind === "ap");
    const sws = c.filter((x) => x.kind !== "ap");
    const leafs = sws.filter((x) => !tree[x.key].length);
    const subs = sws.filter((x) => tree[x.key].length);
    subs.forEach((s) => measure(s));
    const apCols = Math.min(aps.length, L.apCols);
    const apW = apCols * L.apW, apH = Math.ceil(aps.length / L.apCols) * L.apRowH;
    // few end switches: one row; many: a roughly 3:2 grid, at most leafCols+2 wide
    const leafCols = leafs.length <= L.leafCols ? leafs.length : Math.min(L.leafCols + 2, Math.ceil(Math.sqrt(leafs.length) * 1.5));
    const leafW = leafCols * L.leafColW, leafH = Math.ceil(leafs.length / Math.max(1, leafCols)) * L.leafRowH;
    // the end-switch grid goes in the middle, right under its parent; branches split left / right by width
    const subW = subs.reduce((a, s) => a + plan[s.key].w, 0);
    let split = 0;
    for (let acc = 0; split < subs.length && acc + plan[subs[split].key].w / 2 <= subW / 2; split++) acc += plan[subs[split].key].w;
    const order = [...subs.slice(0, split), ...(leafs.length ? ["grid"] : []), ...subs.slice(split)];
    const blocks = order.map((o) => (o === "grid" ? leafW : plan[o.key].w));
    const rowW = blocks.reduce((a, b) => a + b, 0) + L.gap * Math.max(0, blocks.length - 1);
    const childTop = aps.length ? Math.max(L.levelH, L.apTop + apH + 40) : L.levelH;
    const rowH = Math.max(leafs.length ? leafH : 0, ...subs.map((s) => plan[s.key].h));
    return (plan[d.key] = {
      aps, leafs, subs, order, apCols, apW, leafCols, leafW, rowW, childTop,
      w: Math.max(L.nodeW, apW, rowW),
      h: blocks.length ? childTop + rowH : aps.length ? L.apTop + apH : L.nodeH,
    });
  }
  const pos = {};
  function place(d, left, top) {
    const p = plan[d.key];
    pos[d.key] = { x: left + p.w / 2, y: top };
    const linkId = (k) => [d.key, k].sort().join("§");
    const ax = left + (p.w - p.apW) / 2;
    p.aps.forEach((a, i) => {
      pos[a.key] = { x: ax + (i % p.apCols) * L.apW + L.apW / 2, y: top + L.apTop + Math.floor(i / p.apCols) * L.apRowH };
      gridLinks.add(linkId(a.key));
    });
    let x = left + (p.w - p.rowW) / 2;
    const y = top + p.childTop;
    for (const o of p.order) {
      if (o === "grid") {
        p.leafs.forEach((s, i) => {
          pos[s.key] = { x: x + (i % p.leafCols) * L.leafColW + L.leafColW / 2, y: y + Math.floor(i / p.leafCols) * L.leafRowH };
          gridLinks.add(linkId(s.key));
        });
        x += p.leafW + L.gap;
      } else { place(o, x, y); x += plan[o.key].w + L.gap; }
    }
  }
  gridLinks = new Set();

  // seed + its lone switches / APs at the top; every branch below the seed is a Group
  const seed = roots[0] && roots[0].hop === 0 ? roots[0] : null;
  let groupRoots = roots.filter((r) => r !== seed);
  let y = 0;
  if (seed) {
    groupRoots = [...tree[seed.key].filter((k) => tree[k.key].length), ...groupRoots];
    const p = measure(seed, tree[seed.key].filter((k) => !tree[k.key].length));
    place(seed, -p.w / 2, 0);
    y = p.h + L.groupGapY;
  }
  // shorter groups first: rows of similar height pack tighter, and the biggest branch ends up at the
  // bottom where the seed's lines to the other groups don't have to cross it
  const gs = groupRoots.map((d) => ({ d, p: measure(d) })).sort((a, b) => a.p.h - b.p.h || byName(a.d, b.d));
  // pack Groups into rows about twice as wide as tall (screens are wide)
  const area = gs.reduce((a, g) => a + (g.p.w + L.groupGapX) * (g.p.h + L.groupGapY), 0);
  const limit = Math.max(Math.sqrt(area * 2), ...gs.map((g) => g.p.w));
  const rows = [];
  for (const g of gs) {
    const row = rows[rows.length - 1];
    if (row && row.w + L.groupGapX + g.p.w <= limit) { row.items.push(g); row.w += L.groupGapX + g.p.w; }
    else rows.push({ items: [g], w: g.p.w });
  }
  const members = (d) => [d.key, ...tree[d.key].flatMap(members)];
  groups = [];
  for (const row of rows) {
    let x = -row.w / 2;
    for (const g of row.items) {
      place(g.d, x, y);
      groups.push({ key: g.d.key, name: g.d.name, members: members(g.d) });
      x += g.p.w + L.groupGapX;
    }
    y += Math.max(...row.items.map((g) => g.p.h)) + L.groupGapY;
  }
  return pos;
}

/* ---------- group boxes behind the devices; they follow the devices when dragged */
function drawGroups(ctx) {
  if (!groups.length) return;
  const pad = LAYOUT.groupPad;
  ctx.save();
  groups.forEach((g, i) => {
    let b = null;
    for (const k of g.members) {
      if (!nodes.get(k)) continue;
      const bb = network.getBoundingBox(k);
      b = b ? { left: Math.min(b.left, bb.left), top: Math.min(b.top, bb.top), right: Math.max(b.right, bb.right), bottom: Math.max(b.bottom, bb.bottom) } : { ...bb };
    }
    if (!b) { g.box = null; return; }
    const hue = (205 + i * 137.508) % 360;
    g.box = { x: b.left - pad, y: b.top - pad - 22, w: b.right - b.left + 2 * pad, h: b.bottom - b.top + 2 * pad + 22 };
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(g.box.x, g.box.y, g.box.w, g.box.h, 14); else ctx.rect(g.box.x, g.box.y, g.box.w, g.box.h);
    ctx.fillStyle = `hsla(${hue}, 55%, 55%, 0.07)`;
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = `hsla(${hue}, 55%, 62%, 0.45)`;
    ctx.stroke();
    ctx.font = `600 14px ${css("--font")}`;
    ctx.textBaseline = "top";
    ctx.fillStyle = `hsla(${hue}, 65%, 72%, 0.95)`;
    ctx.fillText(`${g.name} · ${g.members.length}`, g.box.x + 12, g.box.y + 8);
  });
  ctx.restore();
}
const groupAt = (pt) => groups.find((g) => g.box && pt.x >= g.box.x && pt.x <= g.box.x + g.box.w && pt.y >= g.box.y && pt.y <= g.box.y + g.box.h);

/* ---------- group cables into Links (one per device pair) */
function buildLinks(cables) {
  const links = {};
  for (const c of cables) {
    const [a, b] = [c.a, c.b].sort();
    const id = a + "§" + b;
    (links[id] ||= { id, a, b, cables: [] }).cables.push(c);
  }
  return Object.values(links);
}
const cableMedia = (c) => c.media_override || c.media || "Unknown";

function edgeStyle(link) {
  const n = link.cables.length;
  const down = link.cables.filter((c) => c.status === "down").length;
  const sus = link.cables.filter((c) => c.status === "suspect").length;
  const up = n - down - sus;
  const counts = {};
  link.cables.forEach((c) => (counts[cableMedia(c)] = (counts[cableMedia(c)] || 0) + 1));
  const kinds = Object.keys(counts);
  const mixed = kinds.length > 1; // no single colour is honest here; the panel lists each cable's type
  const media = kinds[0];
  let color = mixed ? css("--text") : mediaColor(media);
  let dashes = mixed ? [2, 5] : media === "Unknown";
  if (down === n) color = css("--down");
  else if (down > 0) color = css("--partial");
  else if (sus > 0) dashes = [6, 6];
  const label = n > 1 ? (up === n ? `×${n}` : `×${up}/${n}`) + (mixed ? " · " + t("mixed") : "") : "";
  return {
    color: { color, highlight: css("--accent"), hover: css("--accent") },
    width: 2 + (n - 1) * 2, dashes,
    label, font: { color: "#fff", size: 12, strokeWidth: 4, strokeColor: css("--bg"), background: css("--bg"), face: css("--font") },
    smooth: false,
  };
}

function render(newTopo) {
  topo = newTopo;
  $("#empty").classList.toggle("hidden", topo.devices.length > 0);
  const auto = autoLayout(topo.devices);
  const nodeItems = topo.devices.map((d) => {
    const p = d.pos_x != null ? { x: d.pos_x, y: d.pos_y } : auto[d.key] || { x: 0, y: 0 };
    return { id: d.key, ...nodeStyle(d), x: p.x, y: p.y };
  });
  const linkItems = buildLinks(topo.cables).map((l) => ({ id: l.id, from: l.a, to: l.b, ...edgeStyle(l) }));

  const nodeIds = new Set(nodeItems.map((n) => n.id));
  nodes.remove(nodes.getIds().filter((id) => !nodeIds.has(id)));
  nodes.update(nodeItems);
  const edgeIds = new Set(linkItems.map((e) => e.id));
  edges.remove(edges.getIds().filter((id) => !edgeIds.has(id)));
  edges.update(linkItems.filter((e) => nodeIds.has(e.from) && nodeIds.has(e.to)));

  if (!network) initNetwork();
  needRoute = true;
  if (firstFit && topo.devices.length) { network.fit({ animation: false }); firstFit = false; }
  if (selected) showPanel(selected.type, selected.id, true);
}

function initNetwork() {
  network = new vis.Network($("#map"), { nodes, edges }, {
    physics: false,
    interaction: { hover: true, multiselect: true, tooltipDelay: 300 },
    nodes: { shadow: false },
    edges: { selectionWidth: 1.5, hoverWidth: 0.5 },
  });
  network.on("click", (p) => {
    if (p.nodes.length) showPanel("device", p.nodes[0]);
    else if (p.edges.length) showPanel("link", p.edges[0]);
    else hidePanel();
  });
  network.on("dragEnd", async (p) => {
    if (!p.nodes.length) return;
    const ps = network.getPositions(p.nodes);
    const body = p.nodes.map((k) => ({ key: k, x: ps[k].x, y: ps[k].y }));
    body.forEach((b) => { const d = topo.devices.find((x) => x.key === b.key); if (d) { d.pos_x = b.x; d.pos_y = b.y; } });
    needRoute = true;
    network.redraw();
    if (SNAP) return; // dragging in an exported file is fine, there is nowhere to save it
    try { await api("POST", "/api/positions", body); } catch (e) { toast(e.message, true); }
  });
  network.on("beforeDrawing", drawGroups);
  network.on("doubleClick", (p) => {
    if (p.nodes.length) return; // a line crossing the box still counts as the box: lines are thin and double-click does nothing else there
    const g = groupAt(p.pointer.canvas);
    if (!g) return;
    const keys = g.members.filter((k) => nodes.get(k));
    network.selectNodes(keys, false);
    hidePanel();
    toast(t("sel.group", { name: g.name, n: keys.length }));
  });
  network.on("afterDrawing", (ctx) => {
    // node boxes are only sized once drawn, so routing waits for a frame
    if (needRoute) { needRoute = false; routeEdges(); }
    drawPortLabels(ctx);
  });
}

/* ---------- Shift + drag on an empty part of the map: box-select (Ctrl+Shift adds to the selection).
   Dragging any selected device then moves them all (vis-network drags the whole selection). */
const selBox = document.createElement("div");
selBox.className = "sel-box hidden";
$("#tab-map").appendChild(selBox);
let boxStart = null;
const mapXY = (e) => { const r = $("#map").getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
$("#map").addEventListener("pointerdown", (e) => {
  if (!e.shiftKey || e.button !== 0 || !network) return;
  const p = mapXY(e);
  if (network.getNodeAt(p) !== undefined) return; // Shift on a device: normal behaviour
  e.preventDefault();
  e.stopPropagation(); // keep vis-network from panning the view
  boxStart = { ...p, add: e.ctrlKey || e.metaKey };
  Object.assign(selBox.style, { left: p.x + "px", top: p.y + "px", width: "0px", height: "0px" });
  selBox.classList.remove("hidden");
}, true);
window.addEventListener("pointermove", (e) => {
  if (!boxStart) return;
  const p = mapXY(e);
  Object.assign(selBox.style, {
    left: Math.min(p.x, boxStart.x) + "px", top: Math.min(p.y, boxStart.y) + "px",
    width: Math.abs(p.x - boxStart.x) + "px", height: Math.abs(p.y - boxStart.y) + "px",
  });
});
window.addEventListener("pointerup", (e) => {
  if (!boxStart) return;
  const s = boxStart, p = mapXY(e);
  boxStart = null;
  selBox.classList.add("hidden");
  if (Math.abs(p.x - s.x) < 4 && Math.abs(p.y - s.y) < 4) return;
  const a = network.DOMtoCanvas({ x: Math.min(p.x, s.x), y: Math.min(p.y, s.y) });
  const b = network.DOMtoCanvas({ x: Math.max(p.x, s.x), y: Math.max(p.y, s.y) });
  const pos = network.getPositions();
  const hit = Object.keys(pos).filter((k) => pos[k].x >= a.x && pos[k].x <= b.x && pos[k].y >= a.y && pos[k].y <= b.y);
  const keys = s.add ? [...new Set([...network.getSelectedNodes(), ...hit])] : hit;
  network.selectNodes(keys, false);
  hidePanel();
  if (keys.length) toast(t("sel.box", { n: keys.length }));
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && network && !e.target.closest("input, textarea, select")) { network.unselectAll(); hidePanel(); }
});

/* ---------- bend a Link around any device box its straight line would cross */
const BENDS = [0.2, 0.35, 0.5].flatMap((roundness) => ["curvedCW", "curvedCCW"].map((type) => ({ enabled: true, type, roundness })));

// Point on the Link as drawn (curve included), t=0 at its `from` end.
function edgePoint(id, t) {
  const e = network.body.edges[id]; // vis-network internal; pinned vendored version
  if (e && e.edgeType && e.edgeType.getPoint) return e.edgeType.getPoint(t);
  const { from, to } = edges.get(id);
  const p = network.getPositions([from, to]);
  return { x: p[from].x + (p[to].x - p[from].x) * t, y: p[from].y + (p[to].y - p[from].y) * t };
}
function crossings(id, boxes) {
  const { from, to } = edges.get(id);
  let n = 0;
  for (let i = 1; i < 40; i++) {
    const p = edgePoint(id, i / 40);
    for (const [k, b] of boxes) {
      if (k !== from && k !== to && p.x > b.left && p.x < b.right && p.y > b.top && p.y < b.bottom) n++;
    }
  }
  return n;
}
function routeEdges() {
  const boxes = nodes.getIds().map((k) => [k, network.getBoundingBox(k)]);
  for (const id of edges.getIds()) {
    if (edges.get(id).smooth !== false) edges.update({ id, smooth: false });
    if (gridLinks.has(id) || !crossings(id, boxes)) continue;
    let best = { smooth: false, n: Infinity };
    for (const smooth of BENDS) {
      edges.update({ id, smooth });
      const n = crossings(id, boxes);
      if (n < best.n) best = { smooth, n };
      if (!n) break;
    }
    edges.update({ id, smooth: best.smooth });
  }
}

/* ---------- port names near each end of every Link */
// Point on the drawn Link just outside `key`'s box, `gap` px further along; null past the middle.
function pastBox(id, key, gap) {
  const bb = network.getBoundingBox(key);
  const fromEnd = edges.get(id).from === key;
  const at = (t) => edgePoint(id, fromEnd ? t : 1 - t);
  const inside = (p) => p.x >= bb.left && p.x <= bb.right && p.y >= bb.top && p.y <= bb.bottom;
  let prev = at(0), walked = -1;
  for (let i = 1; i <= 100; i++) {
    const p = at(i / 200);
    if (walked < 0) { if (!inside(p)) walked = 0; }
    else if ((walked += Math.hypot(p.x - prev.x, p.y - prev.y)) >= gap) return p;
    prev = p;
  }
  return null;
}
function drawPortLabels(ctx) {
  if (network.getScale() < 0.45) return; // too far out to read
  const pos = network.getPositions();
  const kind = Object.fromEntries(topo.devices.map((d) => [d.key, d.kind]));
  ctx.save();
  ctx.font = `11px ${css("--font")}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const label = (pt, ports) => ports.forEach((txt, i) => {
    const y = pt.y + (i - (ports.length - 1) / 2) * 13;
    const w = ctx.measureText(txt).width + 6;
    ctx.fillStyle = "rgba(13,17,23,.9)";
    ctx.fillRect(pt.x - w / 2, y - 7, w, 14);
    ctx.fillStyle = "#c9d1d9";
    ctx.fillText(txt, pt.x, y);
  });
  const placed = [];
  const rectAt = (pt, ports) => {
    const w = Math.max(...ports.map((t) => ctx.measureText(t).width)) + 6, h = ports.length * 13 + 2;
    return { x1: pt.x - w / 2, x2: pt.x + w / 2, y1: pt.y - h / 2, y2: pt.y + h / 2 };
  };
  const clash = (r) => placed.some((q) => r.x1 < q.x2 && r.x2 > q.x1 && r.y1 < q.y2 && r.y2 > q.y1);
  // slide further along the Link until the label clears the ones already drawn
  const put = (id, key, gap, ports) => {
    let pt = null;
    for (let g = gap; g <= gap + 120; g += 12) {
      const p = pastBox(id, key, g);
      if (!p) break;
      pt = p;
      if (!clash(rectAt(p, ports))) break;
    }
    if (!pt) return;
    placed.push(rectAt(pt, ports));
    label(pt, ports);
  };
  for (const l of buildLinks(topo.cables)) {
    if (!pos[l.a] || !pos[l.b] || !edges.get(l.id)) continue;
    const portsOf = (key) => l.cables.map((c) => (c.a === key ? c.a_port : c.b_port));
    const apSide = kind[l.a] === "ap" ? l.a : kind[l.b] === "ap" ? l.b : null;
    if (apSide) {
      // switch port shown next to the AP (switch side is crowded); AP's own port (Gi0/eth0) is noise
      put(l.id, apSide, 9, portsOf(apSide === l.a ? l.b : l.a));
      continue;
    }
    put(l.id, l.a, 16 + 6 * l.cables.length, portsOf(l.a));
    put(l.id, l.b, 16 + 6 * l.cables.length, portsOf(l.b));
  }
  ctx.restore();
}

/* ---------- side panel */
function hidePanel() { selected = null; $("#panel").classList.add("hidden"); }
$("#panelClose").onclick = () => { hidePanel(); network && network.unselectAll(); };

function mediaTag(m) { return `<span class="media-tag" style="background:${mediaColor(m)}">${esc(MEDIA_TH[m] || m)}</span>`; }
function pill(s) { return `<span class="pill ${s}">${esc(statusName(s))}</span>`; }

function showPanel(type, id, refresh = false) {
  selected = { type, id };
  const body = $("#panelBody");
  if (type === "device") {
    const d = topo.devices.find((x) => x.key === id);
    if (!d) return hidePanel();
    const mine = topo.cables.filter((c) => c.a === id || c.b === id).map((c) => {
      const local = c.a === id ? c.a_port : c.b_port;
      const peer = c.a === id ? c.b : c.a;
      const peerPort = c.a === id ? c.b_port : c.a_port;
      const pn = (topo.devices.find((x) => x.key === peer) || { name: peer }).name;
      return { local, peer, pn, peerPort, c };
    }).sort((x, y) => x.local.localeCompare(y.local, undefined, { numeric: true }));
    body.innerHTML = `
      <h3>${d.kind === "ap" ? "📶 " : ""}${esc(d.name)}</h3>
      <div class="sub">${d.kind === "ap" ? "Access Point" : "Switch"}${d.hop === 0 ? " · Seed Switch" : ""}</div>
      <dl class="kv">
        <dt>${t("p.status")}</dt><dd>${pill(d.status)}${d.note ? `<br><small>${esc(srv(d.note))}</small>` : ""}</dd>
        <dt>IP</dt><dd>${esc(d.ip || "-")}</dd>
        ${d.kind !== "ap" && d.proto ? `<dt>${t("p.via")}</dt><dd>${d.proto === "telnet" ? '<span class="tn">TELNET</span> ' + esc(t("p.telnetWarn")) : "SSH"}</dd>` : ""}
        <dt>${t("p.model")}</dt><dd>${esc(d.platform || "-")}</dd>
        ${d.kind !== "ap" ? `<dt>Serial No.</dt><dd>${d.serial ? (d.serial.split(", ").length > 1
          ? d.serial.split(", ").map((s, i) => `<small>#${i + 1}</small> <span class="sn">${esc(s)}</span>`).join("<br>")
          : `<span class="sn">${esc(d.serial)}</span>`) : "-"}</dd>` : ""}
        <dt>Hop</dt><dd>${d.hop ?? "-"}</dd>
        <dt>${t("p.parent")}</dt><dd>${d.parent ? `<span class="peer" data-dev="${esc(d.parent)}">${esc(d.parent)}</span>` : "-"}</dd>
        <dt>${t("p.lastSeen")}</dt><dd>${fmtTime(d.last_seen)}</dd>
      </dl>
      ${d.ip && !SNAP ? `<button class="btn primary" id="termDev" title="${esc(t("p.term.title"))}">
        ⌨ ${esc(t("p.open", { p: d.proto === "telnet" ? "Telnet" : "SSH" }))}</button> ` : ""}
      ${SNAP ? "" : d.status === "down" ? `<button class="btn danger" id="ackDev">${esc(t("p.ack"))}</button>`
        : `<button class="btn danger" id="delDev" title="${esc(t("p.del.title"))}">${esc(t("p.del"))}</button>`}
      <h4>${esc(t("p.cables", { n: mine.length }))}</h4>
      <table class="cables">${mine.map((m) => `
        <tr><td><b>${esc(m.local)}</b></td><td>→</td>
        <td><span class="peer" data-dev="${esc(m.peer)}">${esc(m.pn)}</span> ${esc(m.peerPort)}</td>
        <td>${mediaTag(cableMedia(m.c))}</td><td>${m.c.status !== "up" ? pill(m.c.status) : ""}</td></tr>`).join("")}
      </table>`;
    const ack = $("#ackDev");
    if (ack) ack.onclick = async () => {
      try { await api("POST", "/api/devices/ack", { key: id }); hidePanel(); } catch (e) { toast(e.message, true); }
    };
    const term = $("#termDev");
    if (term) term.onclick = async () => {
      try {
        const r = await api("POST", "/api/devices/terminal", { key: id });
        toast(t("toast.term", { p: r.proto.toUpperCase(), ip: d.ip, user: r.username ? t("toast.term.as", { u: r.username }) : "" }));
      } catch (e) { toast(e.message, true); }
    };
    const del = $("#delDev");
    if (del) del.onclick = async () => {
      // several selected (Ctrl+click) → delete them all
      const keys = network.getSelectedNodes().includes(id) ? network.getSelectedNodes() : [id];
      if (!confirmInline("#delDev", keys.length > 1 ? t("confirm.delMany", { n: keys.length }) : t("confirm.del"))) return;
      try { const r = await api("DELETE", "/api/devices", { keys }); hidePanel(); toast(t("toast.deleted", { n: r.deleted })); }
      catch (e) { toast(e.message, true); }
    };
  } else {
    const l = buildLinks(topo.cables).find((x) => x.id === id);
    if (!l) return hidePanel();
    const name = (k) => (topo.devices.find((x) => x.key === k) || { name: k }).name;
    l.cables.sort((x, y) => x.a_port.localeCompare(y.a_port, undefined, { numeric: true }));
    body.innerHTML = `
      <h3>${esc(name(l.a))} ↔ ${esc(name(l.b))}</h3>
      <div class="sub">${esc(t("l.count", { n: l.cables.length }))}</div>
      <table class="cables">
        <tr><td><small>${esc(name(l.a))}</small></td><td></td><td><small>${esc(name(l.b))}</small></td><td><small>${esc(t("l.media"))}</small></td><td></td></tr>
        ${l.cables.map((c) => `
        <tr>
          <td><b>${esc(c.a_port)}</b></td><td>↔</td><td><b>${esc(c.b_port)}</b></td>
          <td>${SNAP ? mediaTag(cableMedia(c)) + (c.media_override ? ` <small>(${esc(t("l.manual"))})</small>` : "") : `<select data-cable="${esc(c.id)}" title="${esc(c.media_override ? t("l.manualTitle", { m: c.media }) : t("l.detected"))}">
            <option value="">${esc(t("l.auto", { m: MEDIA_TH[c.media] || c.media }))}</option>
            ${Object.keys(MEDIA_TH).map((m) => `<option value="${m}" ${c.media_override === m ? "selected" : ""}>${MEDIA_TH[m]}</option>`).join("")}
          </select>`}</td>
          <td>${c.status !== "up" ? pill(c.status) : ""}
              ${c.status === "down" && !SNAP ? `<button class="btn danger" data-ack="${esc(c.id)}" style="padding:1px 6px;font-size:11px">${esc(t("l.ack"))}</button>` : ""}</td>
        </tr>`).join("")}
      </table>
      <p class="hint">${esc(t("l.hint"))}</p>`;
    $$("select[data-cable]", body).forEach((s) => (s.onchange = async () => {
      try { await api("POST", "/api/cables/media", { id: s.dataset.cable, media: s.value || null }); toast(t("toast.mediaSaved")); }
      catch (e) { toast(e.message, true); }
    }));
    $$("[data-ack]", body).forEach((b) => (b.onclick = async () => {
      try { await api("POST", "/api/cables/ack", { id: b.dataset.ack }); } catch (e) { toast(e.message, true); }
    }));
  }
  $$(".peer", body).forEach((p) => (p.onclick = () => focusDevice(p.dataset.dev)));
  $("#panel").classList.remove("hidden");
}

function focusDevice(key) {
  if (!nodes.get(key)) return;
  network.selectNodes([key]);
  network.focus(key, { scale: Math.max(network.getScale(), 0.9), animation: { duration: 400 } });
  showPanel("device", key);
}

$("#search").addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  const q = e.target.value.trim().toLowerCase();
  if (!q) return;
  const d = topo.devices.find((x) => x.name.toLowerCase().includes(q) || (x.ip || "").includes(q));
  d ? focusDevice(d.key) : toast(t("toast.notFound"), true);
});
$("#btnFit").onclick = () => network && network.fit({ animation: { duration: 400 } });
// one click (a two-click confirm was easy to miss); Undo puts the dragged positions back
$("#btnLayout").onclick = async () => {
  const saved = topo.devices.filter((d) => d.pos_x != null).map((d) => ({ key: d.key, x: d.pos_x, y: d.pos_y }));
  try {
    await api("DELETE", "/api/positions");
    firstFit = true;
    toast(t("toast.relayout", { n: saved.length }), false, !saved.length ? null : {
      label: t("btn.undo"),
      fn: async () => {
        try { await api("POST", "/api/positions?push=1", saved); }
        catch (e) { toast(e.message, true); }
      },
    });
  } catch (e) { toast(e.message, true); }
};
$("#btnClearMap").onclick = async () => {
  if (!confirmInline("#btnClearMap", t("confirm.clear"))) return;
  try {
    const r = await api("DELETE", "/api/topology" + ($("#clearEvents").checked ? "?events=true" : ""));
    hidePanel(); firstFit = true; unseen = 0; renderBadge();
    await loadEvents();
    toast(t("toast.cleared", { n: r.deleted }));
  } catch (e) { toast(e.message, true); }
};

/* ---------- Export PDF: whole map as an image + device / cable tables, printed from a hidden frame */
async function exportPdf() {
  if (!network || !topo.devices.length) return toast(t("toast.noMap"), true);
  const btn = $("#btnPdf");
  btn.disabled = true;
  const view = { position: network.getViewPosition(), scale: network.getScale() };
  let img;
  try {
    // draw on a large A4-landscape canvas so the image stays sharp in the PDF
    network.setSize("2800px", "1980px");
    network.fit({ animation: false });
    needRoute = true;
    network.redraw();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const src = $("#map canvas");
    const out = document.createElement("canvas");
    out.width = src.width; out.height = src.height;
    const ctx = out.getContext("2d");
    ctx.fillStyle = css("--bg");
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(src, 0, 0);
    img = out.toDataURL("image/png");
  } finally {
    network.setSize("100%", "100%");
    network.moveTo({ ...view, animation: false });
    needRoute = true;
    network.redraw();
    btn.disabled = false;
  }

  const name = (k) => (topo.devices.find((x) => x.key === k) || { name: k }).name;
  const num = (a, b) => a.localeCompare(b, undefined, { numeric: true });
  const devs = topo.devices.slice().sort((a, b) => (a.kind === "ap") - (b.kind === "ap") || (a.hop ?? 99) - (b.hop ?? 99) || num(a.name, b.name));
  const cabs = topo.cables.slice().sort((a, b) => num(name(a.a), name(b.a)) || num(a.a_port, b.a_port));
  const sw = devs.filter((d) => d.kind !== "ap").length;
  const now = new Date().toLocaleString(LOCALE(), { hour12: false });

  const html = `<!DOCTYPE html><html lang="${LANG}"><head><meta charset="utf-8"><title>NWD Topology ${esc(topo.seed)} ${esc(now)}</title>
<style>
  @page { size: A4 landscape; margin: 10mm; }
  * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { font: 11px/1.4 ${css("--font")}; color: #111; margin: 0; }
  h1 { font-size: 16px; margin: 0 0 2px; } h2 { font-size: 13px; margin: 14px 0 6px; }
  .meta { color: #555; margin-bottom: 8px; }
  .map { width: 100%; height: 175mm; object-fit: contain; display: block; border: 1px solid #ccc; background: ${css("--bg")}; }
  .break { break-before: page; }
  table { width: 100%; border-collapse: collapse; }
  th, td { border: 1px solid #ccc; padding: 3px 6px; text-align: left; vertical-align: top; }
  th { background: #eee; } tr { break-inside: avoid; } thead { display: table-header-group; }
  .s-down { color: #c62828; font-weight: 600; } .s-suspect { color: #b26a00; } .s-unreachable, .s-boundary { color: #666; }
</style></head><body>
<h1>NWD · Logical Topology</h1>
<div class="meta">Seed Switch: ${esc(topo.seed || "-")} · ${esc(t("pdf.meta", { sw, ap: devs.length - sw, c: cabs.length, now }))}</div>
<img class="map" src="${img}">
<h2 class="break">${esc(t("pdf.devices", { n: devs.length }))}</h2>
<table><thead><tr><th>${t("pdf.name")}</th><th>${t("pdf.type")}</th><th>IP</th><th>${t("p.model")}</th><th>Serial No.</th><th>${t("p.status")}</th><th>${t("p.via")}</th><th>Hop</th><th>${t("p.parent")}</th><th>${t("p.lastSeen")}</th></tr></thead><tbody>
${devs.map((d) => `<tr><td><b>${esc(d.name)}</b>${d.hop === 0 ? " (Seed)" : ""}</td><td>${d.kind === "ap" ? "AP" : "Switch"}</td>
<td>${esc(d.ip || "-")}</td><td>${esc(d.platform || "-")}</td><td>${(d.serial || "-").split(", ").map(esc).join("<br>")}</td><td class="s-${d.status}">${esc(statusName(d.status))}${d.note ? `<br><small>${esc(srv(d.note))}</small>` : ""}</td>
<td>${d.kind === "ap" ? "" : esc((d.proto || "").toUpperCase())}</td><td>${d.hop ?? "-"}</td><td>${esc(d.parent ? name(d.parent) : "-")}</td><td>${fmtTime(d.last_seen)}</td></tr>`).join("")}
</tbody></table>
<h2>${esc(t("pdf.cables", { n: cabs.length }))}</h2>
<table><thead><tr><th>${t("pdf.devA")}</th><th>${t("pdf.portA")}</th><th>${t("pdf.devB")}</th><th>${t("pdf.portB")}</th><th>${t("l.media")}</th><th>${t("p.status")}</th></tr></thead><tbody>
${cabs.map((c) => `<tr><td>${esc(name(c.a))}</td><td>${esc(c.a_port)}</td><td>${esc(name(c.b))}</td><td>${esc(c.b_port)}</td>
<td>${esc(MEDIA_TH[cableMedia(c)] || cableMedia(c))}${c.media_override ? ` (${esc(t("l.manual"))})` : ""}</td><td class="s-${c.status}">${esc(statusName(c.status))}</td></tr>`).join("")}
</tbody></table></body></html>`;

  $("#printFrame")?.remove();
  const f = document.createElement("iframe");
  f.id = "printFrame";
  f.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0";
  document.body.appendChild(f);
  f.contentDocument.open(); f.contentDocument.write(html); f.contentDocument.close();
  const go = () => { f.contentWindow.focus(); f.contentWindow.print(); };
  const im = f.contentDocument.querySelector("img");
  im.complete ? go() : (im.onload = go);
}
$("#btnPdf").onclick = () => exportPdf().catch((e) => toast(t("toast.exportFail") + e.message, true));

/* ---------- Export HTML: this same page + its scripts + a frozen copy of the data, in one file */
async function exportHtml() {
  if (!network || !topo.devices.length) return toast(t("toast.noMap"), true);
  const get = (u) => fetch(u).then((r) => { if (!r.ok) throw new Error(u + " " + r.status); return r.text(); });
  const [page, style, vis, i18n, js, evs] = await Promise.all([
    get("/"), get("/static/style.css"), get("/static/vendor/vis-network.min.js"), get("/static/i18n.js"), get("/static/app.js"),
    api("GET", "/api/events?limit=2000"),
  ]);
  // positions as they are on screen now, including auto-laid-out ones
  const pos = network.getPositions();
  const snap = {
    exported: Date.now() / 1000,
    topology: { ...topo, devices: topo.devices.map((d) => ({ ...d, pos_x: pos[d.key]?.x ?? d.pos_x, pos_y: pos[d.key]?.y ?? d.pos_y })) },
    events: evs,
  };
  const inline = (s) => s.replace(/<\/script/gi, "<\\/script");
  const data = JSON.stringify(snap).replace(/</g, "\\u003c");
  const swap = (html, from, to) => {
    if (!html.includes(from)) throw new Error(t("toast.missing") + from);
    return html.replace(from, () => to); // function form: no $& surprises inside the minified code
  };
  let out = swap(page, '<link rel="stylesheet" href="/static/style.css">', `<style>\n${style}\n</style>`);
  out = swap(out, '<script src="/static/vendor/vis-network.min.js"></script>', `<script>${inline(vis)}</script>`);
  out = swap(out, '<script src="/static/i18n.js"></script>', `<script>${inline(i18n)}</script>`);
  out = swap(out, '<script src="/static/app.js"></script>', `<script>window.NWD_SNAPSHOT=${data};</script>\n<script>${inline(js)}</script>`);
  out = out.replace("<title>NWD · Logical Topology</title>", () => `<title>NWD ${esc(topo.seed)} · ${esc(fmtTime(snap.exported))}</title>`);

  const d = new Date();
  const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}_${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}`;
  const name = `NWD-${(topo.seed || "map").replace(/[^\w.-]/g, "_")}-${stamp}.html`;
  const url = URL.createObjectURL(new Blob([out], { type: "text/html" }));
  Object.assign(document.createElement("a"), { href: url, download: name }).click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  toast(t("toast.htmlSaved", { f: name }));
}
$("#btnHtml").onclick = () => exportHtml().catch((e) => toast(t("toast.exportFail") + e.message, true));

// two-click confirm without browser dialogs
function confirmInline(sel, msg) {
  const b = $(sel);
  if (b.dataset.armed) { delete b.dataset.armed; b.textContent = b.dataset.orig; return true; }
  b.dataset.orig = b.textContent; b.dataset.armed = 1; b.textContent = msg;
  setTimeout(() => { if (b.dataset.armed) { delete b.dataset.armed; b.textContent = b.dataset.orig; } }, 3000);
  return false;
}

/* ============================================================ status */
let status = {};
function renderStatus() {
  const s = status;
  const txt = $("#statusText");
  const dot = $("#wsDot");
  if (SNAP) { txt.textContent = t("status.snapshot", { t: fmtTime(SNAP.exported) }); dot.className = "dot"; return; }
  if (!wsOpen) { txt.textContent = t("status.disconnected"); dot.className = "dot off"; return; }
  if (s.running) {
    txt.textContent = t("status.crawling", { a: s.progress[0], b: s.progress[1] });
    dot.className = "dot busy";
  } else if (s.paused) {
    txt.textContent = t("status.paused");
    dot.className = "dot busy";
  } else {
    txt.textContent = s.next_run ? t("status.idle", { a: whenAt(s.last_run), b: whenAt(s.next_run) })
      : t("status.idleOff", { a: whenAt(s.last_run) });
    dot.className = "dot";
  }
  $("#btnRescan").disabled = !!s.running;
  $("#verText").textContent = s.version || "-";
  const bar = $("#errorBar");
  bar.textContent = srv(s.error) || "";
  bar.classList.toggle("hidden", !s.error);
  renderStartDialog();
}

/* ---------- startup: ask before the first scan (scan same site / move to a new site / just look) */
const startKey = () => "nwd-start-" + status.started;
function renderStartDialog() {
  const show = wsOpen && status.paused && topo.seed && !sessionStorage.getItem(startKey());
  $("#startDlg").classList.toggle("hidden", !show);
  if (!show) return;
  $("#startSeed").textContent = topo.seed;
  const sw = topo.devices.filter((d) => d.kind !== "ap").length;
  $("#startCount").textContent = topo.devices.length ? t("start.count", { sw, ap: topo.devices.length - sw }) : t("start.empty");
}
const closeStart = () => { sessionStorage.setItem(startKey(), "1"); renderStartDialog(); };
$("#startScan").onclick = async () => {
  try { const r = await api("POST", "/api/rescan"); r.ok ? toast(t("toast.scanStarted")) : toast(srv(r.msg), true); closeStart(); }
  catch (e) { toast(e.message, true); }
};
$("#startMove").onclick = async () => {
  try {
    await api("DELETE", "/api/topology" + ($("#startClearEvents").checked ? "?events=true" : ""));
    closeStart(); hidePanel(); firstFit = true; await loadEvents();
    showTab("settings"); history.replaceState(null, "", "#settings");
    setTimeout(() => { const f = $("#fSettings").seed_ip; f.focus(); f.select(); }, 300);
    toast(t("toast.moved"));
  } catch (e) { toast(e.message, true); }
};
$("#startView").onclick = closeStart;
$("#btnRescan").onclick = async () => {
  try { const r = await api("POST", "/api/rescan"); toast(r.ok ? t("toast.crawlStarted") : srv(r.msg), !r.ok); } catch (e) { toast(e.message, true); }
};

/* ============================================================ events */
// kind → severity class; the label comes from i18n ("ev.k.<kind>")
const EV = {
  initial: "info", device_new: "info", device_down: "bad", device_back: "good", cable_new: "info", cable_down: "bad",
  cable_back: "good", cable_moved: "warn", login_fail: "warn", login_ok: "good", seed_fail: "bad", gap: "warn",
  ack: "info", telnet: "warn", removed: "info", cleared: "warn", serial_changed: "warn",
};
const evLabel = (k) => (k in EV ? t("ev.k." + k) : k);
let events = [];
let unseen = 0;
function evRow(e, isNew) {
  const cls = EV[e.kind] || "info";
  return `<tr class="${isNew ? "ev-new" : ""}"><td>${fmtTime(e.ts)}</td><td><span class="ev-kind ev-${cls}">${esc(evLabel(e.kind))}</span></td>
    <td>${esc(srv(e.subject))}</td><td>${esc(srv(e.detail))}</td></tr>`;
}
function renderEvents(newCount = 0) {
  const f = $("#evFilter").value.trim().toLowerCase();
  const shown = (e) => [JSON.stringify(e), evLabel(e.kind), srv(e.subject), srv(e.detail)].join(" ").toLowerCase();
  const list = f ? events.filter((e) => shown(e).includes(f)) : events;
  $("#evRows").innerHTML = list.slice(0, 500).map((e, i) => evRow(e, i < newCount)).join("") ||
    `<tr><td colspan="4" class="hint">${esc(t("ev.none"))}</td></tr>`;
}
function renderBadge() { const b = $("#evBadge"); b.textContent = unseen; b.classList.toggle("hidden", !unseen); }
$("#evFilter").oninput = () => renderEvents();
async function loadEvents() { events = await api("GET", "/api/events"); renderEvents(); }

/* ============================================================ settings */
/* rescan interval: stored as minutes (0 = off); shown as number + unit (month = 30 days) */
const INTERVAL_UNITS = [43200, 1440, 60, 1];
const INTERVAL_MAX = 12 * 43200;
function setInterval_(f, min) {
  const unit = min ? INTERVAL_UNITS.find((u) => min % u === 0) : 0;
  f.interval_unit.value = String(unit);
  f.interval_n.value = min ? min / unit : "";
  f.interval_n.disabled = !min;
}
function getInterval(f) {
  const unit = +f.interval_unit.value;
  if (!unit) return 0;
  const n = Number(f.interval_n.value);
  if (!Number.isInteger(n) || n < 1 || n * unit > INTERVAL_MAX) return null;
  return n * unit;
}
$("#fSettings").interval_unit.onchange = (e) => {
  const f = e.target.form, off = e.target.value === "0";
  f.interval_n.disabled = off;
  if (!off && !f.interval_n.value) f.interval_n.value = 1;
};
// "3 Dec 14:05" when the next run is not today, "14:05" when it is
const whenAt = (ts) => {
  if (!ts) return "-";
  const d = new Date(ts * 1000);
  return d.toDateString() === new Date().toDateString() ? hhmm(ts)
    : d.toLocaleString(LOCALE(), { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });
};

let lastSettings = null;
let lastOverrides = [];
function renderSecretPlaceholders() {
  if (!lastSettings) return;
  const f = $("#fSettings");
  f.password.placeholder = lastSettings.has_password ? t("set.pwSaved") : t("set.pwNone");
  f.enable.placeholder = lastSettings.has_enable ? t("set.pwSaved") : t("set.enNone");
}
async function loadSettings() {
  const s = await api("GET", "/api/settings");
  lastSettings = s;
  const f = $("#fSettings");
  setInterval_(f, s.interval_min);
  f.seed_ip.value = s.seed_ip; f.max_hops.value = s.max_hops;
  f.workers.value = s.workers; f.timeout_sec.value = s.timeout_sec; f.allowed_subnets.value = s.allowed_subnets.join("\n"); f.username.value = s.username;
  f.password.value = ""; f.enable.value = ""; f.clear_enable.checked = false; f.telnet_fallback.checked = s.telnet_fallback;
  renderSecretPlaceholders();
  renderOverrides(await api("GET", "/api/overrides"));
}
$("#fSettings").onsubmit = async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    const interval_min = getInterval(f);
    if (interval_min === null) { f.interval_n.focus(); return toast(t("set.interval.bad"), true); }
    await api("PUT", "/api/settings", {
      seed_ip: f.seed_ip.value.trim(), interval_min, max_hops: +f.max_hops.value,
      workers: +f.workers.value, timeout_sec: +f.timeout_sec.value, allowed_subnets: f.allowed_subnets.value.split(/\s*\n\s*/).filter(Boolean),
      username: f.username.value, password: f.password.value, enable: f.enable.value, clear_enable: f.clear_enable.checked,
      telnet_fallback: f.telnet_fallback.checked,
    });
    toast(t("toast.saved"));
    loadSettings();
  } catch (err) { toast(err.message, true); }
};
$("#btnPackage").onclick = async () => {
  const b = $("#btnPackage");
  b.disabled = true;
  b.textContent = t("pkg.building");
  try {
    const r = await fetch("/api/package");
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
    const name = (r.headers.get("Content-Disposition") || "").match(/filename="?([^";]+)"?/)?.[1] || "NWD.zip";
    const url = URL.createObjectURL(await r.blob());
    Object.assign(document.createElement("a"), { href: url, download: name }).click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    if (r.headers.get("X-NWD-Runtime") === "1") toast(t("toast.pkgOk", { f: name }));
    else toast(t("toast.pkgNoPy", { w: srv(decodeURIComponent(r.headers.get("X-NWD-Warning") || "")) }), true);
  } catch (e) { toast(t("toast.dlFail") + e.message, true); }
  finally { b.disabled = false; b.textContent = t("pkg.btn"); }
};

function renderOverrides(list) {
  lastOverrides = list;
  $("#ovRows").innerHTML = list.map((o) => `<tr><td>${esc(o.ip)}</td>
    <td>${o.protocol === "telnet" ? '<span class="tn">TELNET</span>' : "SSH"}</td><td>${esc(o.username)}</td>
    <td>${o.has_password ? "••••••" : "-"}</td><td>${o.has_enable ? "••••••" : "-"}</td>
    <td><button class="btn danger" data-delov="${esc(o.ip)}" style="padding:2px 8px">${esc(t("ov.del"))}</button></td></tr>`).join("") ||
    `<tr><td colspan="6" class="hint">${esc(t("ov.none"))}</td></tr>`;
  $$("[data-delov]").forEach((b) => (b.onclick = async () => {
    try { renderOverrides(await api("DELETE", "/api/overrides", { ip: b.dataset.delov })); } catch (e) { toast(e.message, true); }
  }));
}
$("#fOverride").onsubmit = async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    renderOverrides(await api("PUT", "/api/overrides", { ip: f.ip.value, protocol: f.protocol.value, username: f.username.value, password: f.password.value, enable: f.enable.value }));
    f.reset(); toast(t("toast.ovSaved"));
  } catch (err) { toast(err.message, true); }
};

/* ============================================================ websocket */
let wsOpen = false;
let ws = null;
function connect() {
  ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onopen = () => { wsOpen = true; renderStatus(); loadEvents(); };
  ws.onclose = () => { wsOpen = false; renderStatus(); setTimeout(connect, 2000); };
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.type === "topology") render(msg.data);
    else if (msg.type === "status") { status = msg.data; renderStatus(); }
    else if (msg.type === "events") {
      events = [...msg.data.slice().reverse(), ...events];
      renderEvents(msg.data.length);
      if (!$("#tab-events").classList.contains("active")) { unseen += msg.data.length; renderBadge(); }
      const bad = msg.data.filter((e) => EV[e.kind] === "bad");
      if (bad.length) toast(`⚠ ${evLabel(bad[0].kind)}: ${srv(bad[0].subject)}${bad.length > 1 ? t("toast.more", { n: bad.length - 1 }) : ""}`, true);
    }
  };
}

/* ============================================================ language */
$("#btnLang").onclick = () => setLang(LANG === "th" ? "en" : "th");
document.addEventListener("nwd-lang", () => {
  $$("[data-armed]").forEach((b) => delete b.dataset.armed); // a half-confirmed button would restore old-language text
  renderStatus();
  renderEvents();
  renderSecretPlaceholders();
  renderOverrides(lastOverrides);
  if (network) {
    // only labels change ("mixed"); edgeStyle resets bends, so route again
    edges.update(buildLinks(topo.cables).filter((l) => edges.get(l.id)).map((l) => ({ id: l.id, ...edgeStyle(l) })));
    needRoute = true;
    network.redraw();
  }
  if (selected) showPanel(selected.type, selected.id, true);
});
applyI18n();
if (SNAP) {
  document.body.classList.add("snapshot");
  render(SNAP.topology);
  events = SNAP.events || [];
  renderEvents();
  renderStatus();
  if (location.hash === "#events") showTab("events");
} else {
  if (["events", "settings"].includes(location.hash.slice(1))) showTab(location.hash.slice(1));
  connect();
  setInterval(() => ws && ws.readyState === 1 && ws.send("ping"), 25000);
  setInterval(renderStatus, 30000);
}
