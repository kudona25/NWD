/* NWD frontend: live topology map, events, settings. */
"use strict";

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtTime = (t) => (t ? new Date(t * 1000).toLocaleString("th-TH", { hour12: false }) : "-");
// set inside an exported .html file: show that frozen copy read-only, no server
const SNAP = window.NWD_SNAPSHOT || null;
const hhmm = (t) => (t ? new Date(t * 1000).toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit", hour12: false }) : "-");

async function api(method, url, body) {
  const r = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.detail || r.statusText);
  return data;
}

function toast(msg, bad = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast" + (bad ? " bad" : "");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add("hidden"), 3000);
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
const STATUS_TH = { up: "ปกติ", unreachable: "เข้าไม่ได้", boundary: "นอกขอบเขต", suspect: "Suspect", down: "หายไป" };
const MEDIA_TH = { UTP: "UTP", MM: "Fiber MM", SM: "Fiber SM", DAC: "DAC", Unknown: "Unknown" };
const mediaColor = (m) => css({ UTP: "--utp", MM: "--mm", SM: "--sm", DAC: "--dac" }[m] || "--gray");

const LAYOUT = { levelH: 170, nodeW: 190, apW: 120, apRowH: 62, apCols: 6, apTop: 110 };

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

/* ---------- tree layout: seed on top, switch children in next row, APs in a grid under their switch */
function autoLayout(devices) {
  const byKey = Object.fromEntries(devices.map((d) => [d.key, d]));
  const kids = {};
  const roots = [];
  for (const d of devices) {
    if (d.parent && byKey[d.parent] && d.parent !== d.key) (kids[d.parent] ||= []).push(d);
    else roots.push(d);
  }
  for (const k in kids) kids[k].sort((a, b) => a.name.localeCompare(b.name));
  roots.sort((a, b) => (a.hop ?? 99) - (b.hop ?? 99) || a.name.localeCompare(b.name));

  const pos = {};
  const seen = new Set();
  const apBlockW = (n) => Math.min(n, LAYOUT.apCols) * LAYOUT.apW;

  function width(d) {
    if (seen.has(d.key)) return 0;
    seen.add(d.key);
    const c = kids[d.key] || [];
    const aps = c.filter((x) => x.kind === "ap");
    const sws = c.filter((x) => x.kind !== "ap");
    let w = 0;
    if (aps.length) w += apBlockW(aps.length);
    for (const s of sws) w += width(s);
    d._w = Math.max(LAYOUT.nodeW, w);
    return d._w;
  }
  function place(d, left, depth) {
    pos[d.key] = { x: left + d._w / 2, y: depth * LAYOUT.levelH };
    const c = kids[d.key] || [];
    const aps = c.filter((x) => x.kind === "ap");
    const sws = c.filter((x) => x.kind !== "ap" && x._w !== undefined);
    let used = (aps.length ? apBlockW(aps.length) : 0) + sws.reduce((a, s) => a + s._w, 0);
    let x = left + (d._w - used) / 2;
    if (aps.length) {
      const cols = Math.min(aps.length, LAYOUT.apCols);
      aps.forEach((a, i) => {
        pos[a.key] = {
          x: x + (i % cols) * LAYOUT.apW + LAYOUT.apW / 2,
          y: depth * LAYOUT.levelH + LAYOUT.apTop + Math.floor(i / cols) * LAYOUT.apRowH,
        };
      });
      x += apBlockW(aps.length);
    }
    for (const s of sws) { place(s, x, depth + 1); x += s._w; }
  }
  // seed tree first, then orphans (e.g. a switch whose parent was acknowledged away)
  let left = 0;
  for (const r of roots) {
    const w = width(r);
    if (!w) continue;
    place(r, left, r.hop === 0 ? 0 : Math.max(1, r.hop ?? 1));
    left += w + 60;
  }
  for (const d of devices) delete d._w;
  return pos;
}

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
  const label = n > 1 ? (up === n ? `×${n}` : `×${up}/${n}`) + (mixed ? " · ผสม" : "") : "";
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
  network.on("afterDrawing", (ctx) => {
    // node boxes are only sized once drawn, so routing waits for a frame
    if (needRoute) { needRoute = false; routeEdges(); }
    drawPortLabels(ctx);
  });
}

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
    if (!crossings(id, boxes)) continue;
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
function pill(s) { return `<span class="pill ${s}">${esc(STATUS_TH[s] || s)}</span>`; }

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
        <dt>สถานะ</dt><dd>${pill(d.status)}${d.note ? `<br><small>${esc(d.note)}</small>` : ""}</dd>
        <dt>IP</dt><dd>${esc(d.ip || "-")}</dd>
        ${d.kind !== "ap" && d.proto ? `<dt>เข้าด้วย</dt><dd>${d.proto === "telnet" ? '<span class="tn">TELNET</span> ไม่เข้ารหัส — ควรเปิด SSH' : "SSH"}</dd>` : ""}
        <dt>รุ่น</dt><dd>${esc(d.platform || "-")}</dd>
        ${d.kind !== "ap" ? `<dt>Serial No.</dt><dd>${d.serial ? (d.serial.split(", ").length > 1
          ? d.serial.split(", ").map((s, i) => `<small>#${i + 1}</small> <span class="sn">${esc(s)}</span>`).join("<br>")
          : `<span class="sn">${esc(d.serial)}</span>`) : "-"}</dd>` : ""}
        <dt>Hop</dt><dd>${d.hop ?? "-"}</dd>
        <dt>ต่อจาก</dt><dd>${d.parent ? `<span class="peer" data-dev="${esc(d.parent)}">${esc(d.parent)}</span>` : "-"}</dd>
        <dt>เห็นล่าสุด</dt><dd>${fmtTime(d.last_seen)}</dd>
      </dl>
      ${d.ip && !SNAP ? `<button class="btn primary" id="termDev" title="เปิดแท็บใหม่ใน Windows Terminal · พิมพ์รหัสผ่านเอง">
        ⌨ เปิด ${d.proto === "telnet" ? "Telnet" : "SSH"}</button> ` : ""}
      ${SNAP ? "" : d.status === "down" ? `<button class="btn danger" id="ackDev">รับทราบ · ลบออกจากแผนที่</button>`
        : `<button class="btn danger" id="delDev" title="ถ้ายังต่ออยู่และอยู่ในขอบเขต crawl จะกลับมาในรอบถัดไป">ลบออกจากแผนที่</button>`}
      <h4>สายที่ต่ออยู่ (${mine.length})</h4>
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
        toast(`เปิด ${r.proto.toUpperCase()} ไป ${d.ip}${r.username ? " ด้วย " + r.username : ""} แล้ว — ดูที่ Windows Terminal`);
      } catch (e) { toast(e.message, true); }
    };
    const del = $("#delDev");
    if (del) del.onclick = async () => {
      // several selected (Ctrl+click) → delete them all
      const keys = network.getSelectedNodes().includes(id) ? network.getSelectedNodes() : [id];
      if (!confirmInline("#delDev", keys.length > 1 ? `ยืนยัน: ลบ ${keys.length} อุปกรณ์?` : "ยืนยัน: กดอีกครั้งเพื่อลบ")) return;
      try { const r = await api("DELETE", "/api/devices", { keys }); hidePanel(); toast(`ลบแล้ว ${r.deleted} อุปกรณ์`); }
      catch (e) { toast(e.message, true); }
    };
  } else {
    const l = buildLinks(topo.cables).find((x) => x.id === id);
    if (!l) return hidePanel();
    const name = (k) => (topo.devices.find((x) => x.key === k) || { name: k }).name;
    l.cables.sort((x, y) => x.a_port.localeCompare(y.a_port, undefined, { numeric: true }));
    body.innerHTML = `
      <h3>${esc(name(l.a))} ↔ ${esc(name(l.b))}</h3>
      <div class="sub">${l.cables.length} สาย</div>
      <table class="cables">
        <tr><td><small>${esc(name(l.a))}</small></td><td></td><td><small>${esc(name(l.b))}</small></td><td><small>ประเภทสาย</small></td><td></td></tr>
        ${l.cables.map((c) => `
        <tr>
          <td><b>${esc(c.a_port)}</b></td><td>↔</td><td><b>${esc(c.b_port)}</b></td>
          <td>${SNAP ? mediaTag(cableMedia(c)) + (c.media_override ? " <small>(แก้เอง)</small>" : "") : `<select data-cable="${esc(c.id)}" title="${c.media_override ? "แก้เอง (ระบบตรวจได้: " + esc(c.media) + ")" : "ตรวจจาก transceiver"}">
            <option value="">อัตโนมัติ (${esc(MEDIA_TH[c.media] || c.media)})</option>
            ${Object.keys(MEDIA_TH).map((m) => `<option value="${m}" ${c.media_override === m ? "selected" : ""}>${MEDIA_TH[m]}</option>`).join("")}
          </select>`}</td>
          <td>${c.status !== "up" ? pill(c.status) : ""}
              ${c.status === "down" && !SNAP ? `<button class="btn danger" data-ack="${esc(c.id)}" style="padding:1px 6px;font-size:11px">รับทราบ</button>` : ""}</td>
        </tr>`).join("")}
      </table>
      <p class="hint">ประเภทสายตรวจจากชนิด SFP/พอร์ตที่ switch รายงาน — เลือกเองได้ถ้าไม่ตรง</p>`;
    $$("select[data-cable]", body).forEach((s) => (s.onchange = async () => {
      try { await api("POST", "/api/cables/media", { id: s.dataset.cable, media: s.value || null }); toast("บันทึกประเภทสายแล้ว"); }
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
  d ? focusDevice(d.key) : toast("ไม่พบอุปกรณ์", true);
});
$("#btnFit").onclick = () => network && network.fit({ animation: { duration: 400 } });
$("#btnLayout").onclick = async () => {
  if (!confirmInline("#btnLayout", "ยืนยัน: ล้างตำแหน่งที่ลากไว้?")) return;
  try { await api("DELETE", "/api/positions"); firstFit = true; } catch (e) { toast(e.message, true); }
};
$("#btnClearMap").onclick = async () => {
  if (!confirmInline("#btnClearMap", "ยืนยัน: กดอีกครั้งเพื่อล้างแผนที่ทั้งหมด")) return;
  try {
    const r = await api("DELETE", "/api/topology" + ($("#clearEvents").checked ? "?events=true" : ""));
    hidePanel(); firstFit = true; unseen = 0; renderBadge();
    await loadEvents();
    toast(`ล้างแผนที่แล้ว (${r.deleted} อุปกรณ์)`);
  } catch (e) { toast(e.message, true); }
};

/* ---------- Export PDF: whole map as an image + device / cable tables, printed from a hidden frame */
async function exportPdf() {
  if (!network || !topo.devices.length) return toast("ยังไม่มีข้อมูลแผนที่", true);
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
  const now = new Date().toLocaleString("th-TH", { hour12: false });

  const html = `<!DOCTYPE html><html lang="th"><head><meta charset="utf-8"><title>NWD Topology ${esc(topo.seed)} ${esc(now)}</title>
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
<div class="meta">Seed Switch: ${esc(topo.seed || "-")} · ${sw} switch · ${devs.length - sw} AP · ${cabs.length} สาย · พิมพ์เมื่อ ${esc(now)}</div>
<img class="map" src="${img}">
<h2 class="break">อุปกรณ์ (${devs.length})</h2>
<table><thead><tr><th>ชื่อ</th><th>ประเภท</th><th>IP</th><th>รุ่น</th><th>Serial No.</th><th>สถานะ</th><th>เข้าด้วย</th><th>Hop</th><th>ต่อจาก</th><th>เห็นล่าสุด</th></tr></thead><tbody>
${devs.map((d) => `<tr><td><b>${esc(d.name)}</b>${d.hop === 0 ? " (Seed)" : ""}</td><td>${d.kind === "ap" ? "AP" : "Switch"}</td>
<td>${esc(d.ip || "-")}</td><td>${esc(d.platform || "-")}</td><td>${(d.serial || "-").split(", ").map(esc).join("<br>")}</td><td class="s-${d.status}">${esc(STATUS_TH[d.status] || d.status)}${d.note ? `<br><small>${esc(d.note)}</small>` : ""}</td>
<td>${d.kind === "ap" ? "" : esc((d.proto || "").toUpperCase())}</td><td>${d.hop ?? "-"}</td><td>${esc(d.parent ? name(d.parent) : "-")}</td><td>${fmtTime(d.last_seen)}</td></tr>`).join("")}
</tbody></table>
<h2>สาย (${cabs.length})</h2>
<table><thead><tr><th>อุปกรณ์ A</th><th>พอร์ต A</th><th>อุปกรณ์ B</th><th>พอร์ต B</th><th>ประเภทสาย</th><th>สถานะ</th></tr></thead><tbody>
${cabs.map((c) => `<tr><td>${esc(name(c.a))}</td><td>${esc(c.a_port)}</td><td>${esc(name(c.b))}</td><td>${esc(c.b_port)}</td>
<td>${esc(MEDIA_TH[cableMedia(c)] || cableMedia(c))}${c.media_override ? " (แก้เอง)" : ""}</td><td class="s-${c.status}">${esc(STATUS_TH[c.status] || c.status)}</td></tr>`).join("")}
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
$("#btnPdf").onclick = () => exportPdf().catch((e) => toast("Export ไม่สำเร็จ: " + e.message, true));

/* ---------- Export HTML: this same page + its scripts + a frozen copy of the data, in one file */
async function exportHtml() {
  if (!network || !topo.devices.length) return toast("ยังไม่มีข้อมูลแผนที่", true);
  const get = (u) => fetch(u).then((r) => { if (!r.ok) throw new Error(u + " " + r.status); return r.text(); });
  const [page, style, vis, js, evs] = await Promise.all([
    get("/"), get("/static/style.css"), get("/static/vendor/vis-network.min.js"), get("/static/app.js"),
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
    if (!html.includes(from)) throw new Error("ไม่พบ " + from);
    return html.replace(from, () => to); // function form: no $& surprises inside the minified code
  };
  let out = swap(page, '<link rel="stylesheet" href="/static/style.css">', `<style>\n${style}\n</style>`);
  out = swap(out, '<script src="/static/vendor/vis-network.min.js"></script>', `<script>${inline(vis)}</script>`);
  out = swap(out, '<script src="/static/app.js"></script>', `<script>window.NWD_SNAPSHOT=${data};</script>\n<script>${inline(js)}</script>`);
  out = out.replace("<title>NWD · Logical Topology</title>", () => `<title>NWD ${esc(topo.seed)} · ${esc(fmtTime(snap.exported))}</title>`);

  const d = new Date();
  const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}_${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}`;
  const name = `NWD-${(topo.seed || "map").replace(/[^\w.-]/g, "_")}-${stamp}.html`;
  const url = URL.createObjectURL(new Blob([out], { type: "text/html" }));
  Object.assign(document.createElement("a"), { href: url, download: name }).click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  toast(`บันทึก ${name} แล้ว — เปิดด้วย browser เครื่องไหนก็ได้`);
}
$("#btnHtml").onclick = () => exportHtml().catch((e) => toast("Export ไม่สำเร็จ: " + e.message, true));

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
  if (SNAP) { txt.textContent = `Snapshot ${fmtTime(SNAP.exported)} · ดูอย่างเดียว`; dot.className = "dot"; return; }
  if (!wsOpen) { txt.textContent = "ขาดการเชื่อมต่อกับ server…"; dot.className = "dot off"; return; }
  if (s.running) {
    txt.textContent = `กำลัง crawl ${s.progress[0]}/${s.progress[1]} switch`;
    dot.className = "dot busy";
  } else if (s.paused) {
    txt.textContent = "ยังไม่ scan — กด Rescan เพื่อเริ่ม";
    dot.className = "dot busy";
  } else {
    txt.textContent = `ล่าสุด ${hhmm(s.last_run)} · รอบถัดไป ${hhmm(s.next_run)}`;
    dot.className = "dot";
  }
  $("#btnRescan").disabled = !!s.running;
  const bar = $("#errorBar");
  bar.textContent = s.error || "";
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
  $("#startCount").textContent = topo.devices.length ? `· บนแผนที่ ${sw} switch, ${topo.devices.length - sw} AP` : "· แผนที่ว่าง";
}
const closeStart = () => { sessionStorage.setItem(startKey(), "1"); renderStartDialog(); };
$("#startScan").onclick = async () => {
  try { const r = await api("POST", "/api/rescan"); r.ok ? toast("เริ่ม scan แล้ว") : toast(r.msg, true); closeStart(); }
  catch (e) { toast(e.message, true); }
};
$("#startMove").onclick = async () => {
  try {
    await api("DELETE", "/api/topology" + ($("#startClearEvents").checked ? "?events=true" : ""));
    closeStart(); hidePanel(); firstFit = true; await loadEvents();
    showTab("settings"); history.replaceState(null, "", "#settings");
    setTimeout(() => { const f = $("#fSettings").seed_ip; f.focus(); f.select(); }, 300);
    toast("ล้างแผนที่แล้ว — ใส่ Seed IP / credential ของ site ใหม่ → บันทึก → กด Rescan");
  } catch (e) { toast(e.message, true); }
};
$("#startView").onclick = closeStart;
$("#btnRescan").onclick = async () => {
  try { const r = await api("POST", "/api/rescan"); toast(r.ok ? "เริ่ม crawl แล้ว" : r.msg, !r.ok); } catch (e) { toast(e.message, true); }
};

/* ============================================================ events */
const EV = {
  initial: ["Crawl แรก", "info"], device_new: ["อุปกรณ์ใหม่", "info"], device_down: ["อุปกรณ์หายไป", "bad"],
  device_back: ["อุปกรณ์กลับมา", "good"], cable_new: ["สายใหม่", "info"], cable_down: ["สายหลุด", "bad"],
  cable_back: ["สายกลับมา", "good"], cable_moved: ["ย้ายพอร์ต", "warn"], login_fail: ["ล็อกอินไม่ได้", "warn"],
  login_ok: ["ล็อกอินได้แล้ว", "good"], seed_fail: ["Seed เข้าไม่ได้", "bad"], gap: ["ระบบไม่ได้ทำงาน", "warn"],
  ack: ["รับทราบ", "info"], telnet: ["เข้าด้วย Telnet", "warn"],
  removed: ["ลบโดยผู้ใช้", "info"], cleared: ["ล้างแผนที่", "warn"], serial_changed: ["Serial เปลี่ยน", "warn"],
};
let events = [];
let unseen = 0;
function evRow(e, isNew) {
  const [label, cls] = EV[e.kind] || [e.kind, "info"];
  return `<tr class="${isNew ? "ev-new" : ""}"><td>${fmtTime(e.ts)}</td><td><span class="ev-kind ev-${cls}">${esc(label)}</span></td>
    <td>${esc(e.subject)}</td><td>${esc(e.detail)}</td></tr>`;
}
function renderEvents(newCount = 0) {
  const f = $("#evFilter").value.trim().toLowerCase();
  const list = f ? events.filter((e) => JSON.stringify(e).toLowerCase().includes(f) || (EV[e.kind]?.[0] || "").includes(f)) : events;
  $("#evRows").innerHTML = list.slice(0, 500).map((e, i) => evRow(e, i < newCount)).join("") ||
    `<tr><td colspan="4" class="hint">ยังไม่มีเหตุการณ์</td></tr>`;
}
function renderBadge() { const b = $("#evBadge"); b.textContent = unseen; b.classList.toggle("hidden", !unseen); }
$("#evFilter").oninput = () => renderEvents();
async function loadEvents() { events = await api("GET", "/api/events"); renderEvents(); }

/* ============================================================ settings */
async function loadSettings() {
  const s = await api("GET", "/api/settings");
  const f = $("#fSettings");
  f.seed_ip.value = s.seed_ip; f.interval_min.value = s.interval_min; f.max_hops.value = s.max_hops;
  f.workers.value = s.workers; f.timeout_sec.value = s.timeout_sec; f.allowed_subnets.value = s.allowed_subnets.join("\n"); f.username.value = s.username;
  f.password.value = ""; f.enable.value = ""; f.clear_enable.checked = false; f.telnet_fallback.checked = s.telnet_fallback;
  f.password.placeholder = s.has_password ? "•••••• (บันทึกไว้แล้ว)" : "ยังไม่ได้ตั้ง";
  f.enable.placeholder = s.has_enable ? "•••••• (บันทึกไว้แล้ว)" : "ไม่มี (ไม่บังคับ)";
  renderOverrides(await api("GET", "/api/overrides"));
}
$("#fSettings").onsubmit = async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    await api("PUT", "/api/settings", {
      seed_ip: f.seed_ip.value.trim(), interval_min: +f.interval_min.value, max_hops: +f.max_hops.value,
      workers: +f.workers.value, timeout_sec: +f.timeout_sec.value, allowed_subnets: f.allowed_subnets.value.split(/\s*\n\s*/).filter(Boolean),
      username: f.username.value, password: f.password.value, enable: f.enable.value, clear_enable: f.clear_enable.checked,
      telnet_fallback: f.telnet_fallback.checked,
    });
    toast("บันทึกแล้ว — กด Rescan เพื่อ crawl ทันที");
    loadSettings();
  } catch (err) { toast(err.message, true); }
};
$("#btnPackage").onclick = async () => {
  const b = $("#btnPackage");
  const label = b.textContent;
  b.disabled = true;
  b.textContent = "กำลังสร้าง… (ครั้งแรกอาจนาน 1–2 นาที)";
  try {
    const r = await fetch("/api/package");
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
    const name = (r.headers.get("Content-Disposition") || "").match(/filename="?([^";]+)"?/)?.[1] || "NWD.zip";
    const url = URL.createObjectURL(await r.blob());
    Object.assign(document.createElement("a"), { href: url, download: name }).click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    if (r.headers.get("X-NWD-Runtime") === "1") toast(`ดาวน์โหลด ${name} แล้ว — แตก zip แล้วกด start.bat ได้เลย`);
    else toast(`${decodeURIComponent(r.headers.get("X-NWD-Warning") || "")} — zip นี้ไม่มี Python เครื่องปลายทางต้องติดตั้ง Python และต่อเน็ตเอง`, true);
  } catch (e) { toast("ดาวน์โหลดไม่สำเร็จ: " + e.message, true); }
  finally { b.disabled = false; b.textContent = label; }
};

function renderOverrides(list) {
  $("#ovRows").innerHTML = list.map((o) => `<tr><td>${esc(o.ip)}</td>
    <td>${o.protocol === "telnet" ? '<span class="tn">TELNET</span>' : "SSH"}</td><td>${esc(o.username)}</td>
    <td>${o.has_password ? "••••••" : "-"}</td><td>${o.has_enable ? "••••••" : "-"}</td>
    <td><button class="btn danger" data-delov="${esc(o.ip)}" style="padding:2px 8px">ลบ</button></td></tr>`).join("") ||
    `<tr><td colspan="6" class="hint">ยังไม่มี — ทุก switch ใช้ Default Credential</td></tr>`;
  $$("[data-delov]").forEach((b) => (b.onclick = async () => {
    try { renderOverrides(await api("DELETE", "/api/overrides", { ip: b.dataset.delov })); } catch (e) { toast(e.message, true); }
  }));
}
$("#fOverride").onsubmit = async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    renderOverrides(await api("PUT", "/api/overrides", { ip: f.ip.value, protocol: f.protocol.value, username: f.username.value, password: f.password.value, enable: f.enable.value }));
    f.reset(); toast("บันทึก override แล้ว");
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
      const bad = msg.data.filter((e) => (EV[e.kind] || [])[1] === "bad");
      if (bad.length) toast(`⚠ ${EV[bad[0].kind][0]}: ${bad[0].subject}${bad.length > 1 ? ` และอีก ${bad.length - 1}` : ""}`, true);
    }
  };
}
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
