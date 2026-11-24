"""Compare a new Snapshot with the stored map and record Change Events.

Rules (see CONTEXT.md):
- Missing, and a switch that used to report it was reached this Crawl -> down now.
- Missing, but no such switch was reached -> Suspect; down after the 2nd miss.
- Down items stay on the map (red) until the user acknowledges them.
"""
import time

from . import db
from .crawler import Snapshot

MISS_LIMIT = 2


def apply(snap: Snapshot, trigger: str, started: float) -> list[dict]:
    now = time.time()
    events: list[dict] = []

    if not snap.seed_ok:
        last = db.q("SELECT ok FROM run ORDER BY id DESC LIMIT 1")
        if not last or last[0]["ok"]:
            events.append(db.add_event("seed_fail", "Seed Switch", snap.seed_error))
        db.x("INSERT INTO run (started, finished, trigger, reached, failed, ok, note) VALUES (?,?,?,?,?,0,?)",
             (started, now, trigger, 0, snap.failed, snap.seed_error))
        return events

    prev_dev = {d["key"]: d for d in db.q("SELECT * FROM device")}
    prev_cab = {c["id"]: c for c in db.q("SELECT * FROM cable")}
    first = not prev_dev

    def ev(c, kind, subject, detail=""):
        if not first:
            events.append(db.add_event(kind, subject, detail, now, c))

    def work(c):
        # ---------------- devices present
        for key, d in snap.devices.items():
            p = prev_dev.get(key)
            if p is None:
                c.execute("""INSERT INTO device (key,name,kind,platform,ip,status,note,hop,parent,miss,first_seen,last_seen,proto,serial)
                             VALUES (?,?,?,?,?,?,?,?,?,0,?,?,?,?)""",
                          (key, d["name"], d["kind"], d.get("platform", ""), d.get("ip"), d["status"],
                           d.get("note", ""), d.get("hop"), d.get("parent"), now, now, d.get("proto"),
                           d.get("serial") or None))
                ev(c, "device_new", d["name"], f'{d["kind"]} {d.get("ip") or ""} {d.get("platform", "")}'.strip())
                continue
            if p["status"] in ("suspect", "down"):
                ev(c, "device_back", d["name"], f'กลับมาแล้ว (เดิม {p["status"]})')
            elif p["status"] == "up" and d["status"] == "unreachable":
                ev(c, "login_fail", d["name"], d.get("note", ""))
            elif p["status"] == "unreachable" and d["status"] == "up":
                ev(c, "login_ok", d["name"], "ล็อกอินได้แล้ว")
            if d.get("proto") == "telnet" and p["proto"] != "telnet":
                ev(c, "telnet", d["name"], "เข้าด้วย telnet (SSH ถูกปฏิเสธหรือกำหนดไว้)")
            if d.get("serial") and p["serial"] and d["serial"] != p["serial"]:
                ev(c, "serial_changed", d["name"], f'{p["serial"]} → {d["serial"]} (เปลี่ยนตัวเครื่อง / สมาชิก stack)')
            # empty serial = show version failed or not logged in this time: keep the stored one
            c.execute("""UPDATE device SET name=?, kind=?, platform=?, ip=?, status=?, note=?, hop=?, parent=?,
                         miss=0, last_seen=?, proto=COALESCE(?, proto), serial=COALESCE(?, serial) WHERE key=?""",
                      (d["name"], d["kind"], d.get("platform") or p["platform"], d.get("ip") or p["ip"],
                       d["status"], d.get("note", ""), d.get("hop"), d.get("parent"), now, d.get("proto"),
                       d.get("serial") or None, key))

        # ---------------- cables present
        new_cables = []
        for cid, cb in snap.cables.items():
            p = prev_cab.get(cid)
            if p is None:
                c.execute("""INSERT INTO cable (id,a,a_port,b,b_port,media,status,miss,first_seen,last_seen)
                             VALUES (?,?,?,?,?,?,'up',0,?,?)""",
                          (cid, cb["a"], cb["a_port"], cb["b"], cb["b_port"], cb["media"], now, now))
                new_cables.append(cb)
                continue
            if p["status"] in ("suspect", "down"):
                ev(c, "cable_back", _cab_name(p), "สายกลับมาแล้ว")
            media = cb["media"] if cb["media"] != "Unknown" else p["media"]
            c.execute("UPDATE cable SET status='up', miss=0, media=?, last_seen=? WHERE id=?", (media, now, cid))

        # ---------------- missing cables
        gone_cables = []
        for cid, p in prev_cab.items():
            if cid in snap.cables or p["status"] == "down":
                continue
            authoritative = p["a"] in snap.reached or p["b"] in snap.reached
            miss = p["miss"] + 1
            if authoritative or miss >= MISS_LIMIT:
                c.execute("UPDATE cable SET status='down', miss=? WHERE id=?", (miss, cid))
                gone_cables.append(p)
            else:
                c.execute("UPDATE cable SET status='suspect', miss=? WHERE id=?", (miss, cid))

        # a cable that vanished and a new one between the same two devices = moved port
        for g in gone_cables:
            pair = {g["a"], g["b"]}
            moved = next((n for n in new_cables if {n["a"], n["b"]} == pair), None)
            if moved:
                new_cables.remove(moved)
                c.execute("DELETE FROM cable WHERE id=?", (g["id"],))
                ev(c, "cable_moved", f'{g["a"]} ↔ {g["b"]}', _moved_detail(g, moved))
            else:
                ev(c, "cable_down", _cab_name(g), "สายหลุด / ไม่พบใน CDP/LLDP")
        for n in new_cables:
            ev(c, "cable_new", _cab_name(n), f'media {n["media"]}')

        # ---------------- missing devices
        for key, p in prev_dev.items():
            if key in snap.devices or p["status"] == "down":
                continue
            peers = {r["a"] if r["b"] == key else r["b"]
                     for r in prev_cab.values() if key in (r["a"], r["b"])}
            authoritative = bool(peers & snap.reached)
            miss = p["miss"] + 1
            if authoritative or miss >= MISS_LIMIT:
                c.execute("UPDATE device SET status='down', miss=? WHERE key=?", (miss, key))
                ev(c, "device_down", p["name"], "หายจาก topology")
            else:
                c.execute("UPDATE device SET status='suspect', miss=? WHERE key=?", (miss, key))

        if first:
            events.append(db.add_event("initial", "Crawl แรก",
                                       f"พบ {len(snap.devices)} อุปกรณ์, {len(snap.cables)} สาย", now, c))

        c.execute("INSERT INTO run (started, finished, trigger, reached, failed, ok, note) VALUES (?,?,?,?,?,1,'')",
                  (started, now, trigger, len(snap.reached), snap.failed))

    db.tx(work)
    return events


def _moved_detail(old, new) -> str:
    """'SW-WAREHOUSE: Gi0/3 → Gi0/5' for each side whose port changed."""
    port = lambda c, dev: c["a_port"] if c["a"] == dev else c["b_port"]
    parts = [f'{dev}: {port(old, dev)} → {port(new, dev)}'
             for dev in (old["a"], old["b"]) if port(old, dev) != port(new, dev)]
    return ", ".join(parts)


def _cab_name(c) -> str:
    return f'{c["a"]} {c["a_port"]} ↔ {c["b"]} {c["b_port"]}'


def acknowledge_device(key: str) -> bool:
    rows = db.q("SELECT name FROM device WHERE key=? AND status='down'", (key,))
    if not rows:
        return False

    def work(c):
        c.execute("DELETE FROM cable WHERE a=? OR b=?", (key, key))
        c.execute("DELETE FROM device WHERE key=?", (key,))
        db.add_event("ack", rows[0]["name"], "รับทราบและลบออกจากแผนที่", c=c)
    db.tx(work)
    return True


def delete_devices(keys: list[str]) -> int:
    """Remove Devices (any status) and their Cables. A Device still connected comes back on the next Crawl."""
    if not keys:
        return 0
    marks = ",".join("?" * len(keys))
    rows = db.q(f"SELECT key, name FROM device WHERE key IN ({marks})", tuple(keys))

    def work(c):
        for r in rows:
            c.execute("DELETE FROM cable WHERE a=? OR b=?", (r["key"], r["key"]))
            c.execute("DELETE FROM device WHERE key=?", (r["key"],))
            db.add_event("removed", r["name"], "ลบออกจากแผนที่โดยผู้ใช้", c=c)
    db.tx(work)
    return len(rows)


def clear_map(clear_events: bool = False) -> int:
    """Empty the map (e.g. before moving to another site). The next Crawl counts as the first one."""
    n = db.q("SELECT COUNT(*) AS n FROM device")[0]["n"]

    def work(c):
        c.execute("DELETE FROM cable")
        c.execute("DELETE FROM device")
        if clear_events:
            c.execute("DELETE FROM event")
        db.add_event("cleared", "แผนที่", f"ล้างแผนที่ ({n} อุปกรณ์)", c=c)
    db.tx(work)
    return n


def acknowledge_cable(cid: str) -> bool:
    rows = db.q("SELECT * FROM cable WHERE id=? AND status='down'", (cid,))
    if not rows:
        return False

    def work(c):
        c.execute("DELETE FROM cable WHERE id=?", (cid,))
        db.add_event("ack", _cab_name(rows[0]), "รับทราบและลบออกจากแผนที่", c=c)
    db.tx(work)
    return True


def topology() -> dict:
    return {
        "devices": db.q("SELECT key,name,kind,platform,ip,status,note,hop,parent,pos_x,pos_y,last_seen,proto,serial FROM device"),
        "cables": db.q("SELECT id,a,a_port,b,b_port,media,media_override,status,last_seen FROM cable"),
        "seed": db.get_settings()["seed_ip"],
    }
