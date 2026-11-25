"""NWD — real-time logical topology from CDP/LLDP.

Run:  python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
"""
import asyncio
import ipaddress
import logging
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import zipfile
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import quote

from starlette.background import BackgroundTask

from fastapi import Body, FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from . import crawler, db, state
from .crypto import dec, enc

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("nwd")

STATIC = Path(__file__).resolve().parent.parent / "static"
MEDIA_TYPES = {"UTP", "MM", "SM", "DAC", "Unknown"}


# ---------------------------------------------------------------- live clients

class Hub:
    def __init__(self):
        self.clients: set[WebSocket] = set()

    async def send(self, msg: dict):
        dead = []
        for ws in list(self.clients):
            try:
                await ws.send_json(msg)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.clients.discard(ws)


hub = Hub()
# paused: no Crawl after startup until the user picks "scan this site" (or Rescan) on the page,
# so reopening the app at a new site doesn't log in to the previous site's switches
status = {"running": False, "progress": [0, 0], "last_run": None, "next_run": None, "error": "",
          "paused": True, "started": time.time()}
wake = asyncio.Event()
resume = asyncio.Event()
crawl_lock = asyncio.Lock()


def cred_for(ip: str) -> dict:
    s = db.get_settings()
    o = db.q("SELECT * FROM cred_override WHERE ip=?", (ip,))
    if o:
        o = o[0]
        # a switch pinned to SSH/Telnet in its override never falls back
        return {"username": o["username"], "password": dec(o["password_enc"]), "enable": dec(o["enable_enc"]),
                "protocol": o["protocol"] or "ssh", "telnet_fallback": False}
    return {"username": s["username"], "password": dec(s["password_enc"]), "enable": dec(s["enable_enc"]),
            "protocol": "ssh", "telnet_fallback": s["telnet_fallback"]}


async def run_crawl(trigger: str):
    s = db.get_settings()
    if not s["seed_ip"] or not s["username"]:
        status["error"] = "ยังไม่ได้ตั้งค่า Seed Switch หรือ username"
        await hub.send({"type": "status", "data": status})
        return
    async with crawl_lock:
        loop = asyncio.get_running_loop()
        status.update(running=True, progress=[0, 1], error="")
        await hub.send({"type": "status", "data": status})

        def progress(done, total):
            status["progress"] = [done, total]
            asyncio.run_coroutine_threadsafe(hub.send({"type": "status", "data": status}), loop)

        started = time.time()
        try:
            snap = await asyncio.to_thread(crawler.crawl, s, cred_for, crawler.device_fetch, progress)
            events = await asyncio.to_thread(state.apply, snap, trigger, started)
            if not snap.seed_ok:
                status["error"] = f"เข้า Seed Switch ไม่ได้: {snap.seed_error}"
        except Exception as e:
            log.exception("crawl failed")
            status["error"] = f"Crawl ล้มเหลว: {e}"
            events = []
        status.update(running=False, last_run=time.time())
        await hub.send({"type": "topology", "data": state.topology()})
        if events:
            await hub.send({"type": "events", "data": events})
        await hub.send({"type": "status", "data": status})


async def scheduler():
    await resume.wait()
    while True:
        try:
            await run_crawl("schedule")
        except Exception:
            log.exception("scheduler")
        interval = db.get_settings()["interval_min"] * 60
        status["next_run"] = time.time() + interval
        await hub.send({"type": "status", "data": status})
        wake.clear()
        try:
            await asyncio.wait_for(wake.wait(), timeout=interval)
        except asyncio.TimeoutError:
            pass


def record_gap():
    """If the app was not running for a while, say so — the next diff covers that whole gap."""
    last = db.q("SELECT finished FROM run ORDER BY id DESC LIMIT 1")
    if not last:
        return
    interval = db.get_settings()["interval_min"] * 60
    gap = time.time() - last[0]["finished"]
    if gap > 2 * interval:
        fmt = lambda t: time.strftime("%Y-%m-%d %H:%M", time.localtime(t))
        db.add_event("gap", "ระบบไม่ได้ทำงาน",
                     f'{fmt(last[0]["finished"])} – {fmt(time.time())}: การเปลี่ยนแปลงรอบถัดไปอาจเกิดขึ้นช่วงไหนก็ได้ในระหว่างนี้')


@asynccontextmanager
async def lifespan(app):
    db.conn()
    record_gap()
    task = asyncio.create_task(scheduler())
    yield
    task.cancel()


app = FastAPI(title="NWD Topology", lifespan=lifespan)
app.mount("/static", StaticFiles(directory=STATIC), name="static")


@app.middleware("http")
async def no_stale_ui(request: Request, call_next):
    # Without this the browser may keep running an old app.js after an update.
    # no-cache = always revalidate (a cheap 304 when nothing changed), not "never cache".
    resp = await call_next(request)
    if request.url.path == "/" or request.url.path.startswith("/static/"):
        resp.headers["Cache-Control"] = "no-cache"
    return resp


@app.get("/")
def index():
    return FileResponse(STATIC / "index.html")


# ---------------------------------------------------------------- read

@app.get("/api/topology")
def get_topology():
    return state.topology()


@app.get("/api/events")
def get_events(limit: int = 300):
    return db.q("SELECT * FROM event ORDER BY id DESC LIMIT ?", (min(limit, 2000),))


@app.get("/api/status")
def get_status():
    return status


@app.post("/api/rescan")
async def rescan():
    if crawl_lock.locked():
        return {"ok": False, "msg": "กำลัง crawl อยู่"}
    if not db.get_settings()["seed_ip"]:
        return {"ok": False, "msg": "ยังไม่ได้ตั้งค่า Seed Switch IP"}
    if resume.is_set():
        wake.set()
    else:   # first scan since startup: start the schedule
        status["paused"] = False
        resume.set()
        await hub.send({"type": "status", "data": status})
    return {"ok": True}


# ---------------------------------------------------------------- settings

@app.get("/api/settings")
def get_settings():
    s = db.get_settings()
    return {
        "seed_ip": s["seed_ip"], "interval_min": s["interval_min"], "max_hops": s["max_hops"],
        "workers": s["workers"], "timeout_sec": s["timeout_sec"], "allowed_subnets": s["allowed_subnets"], "username": s["username"],
        "has_password": bool(s["password_enc"]), "has_enable": bool(s["enable_enc"]),
        "telnet_fallback": s["telnet_fallback"],
    }


def _check_ip(ip: str) -> str:
    try:
        return str(ipaddress.ip_address(ip.strip()))
    except ValueError:
        raise HTTPException(400, f"IP ไม่ถูกต้อง: {ip}")


@app.put("/api/settings")
def put_settings(body: dict = Body(...)):
    if "seed_ip" in body:
        db.set_setting("seed_ip", _check_ip(body["seed_ip"]) if body["seed_ip"] else "")
    for k, lo, hi in (("interval_min", 1, 1440), ("max_hops", 1, 50), ("workers", 1, 50),
                     ("timeout_sec", 10, 600)):
        if k in body:
            try:
                v = int(body[k])
            except (TypeError, ValueError):
                raise HTTPException(400, f"{k} ต้องเป็นตัวเลข")
            if not lo <= v <= hi:
                raise HTTPException(400, f"{k} ต้องอยู่ระหว่าง {lo}-{hi}")
            db.set_setting(k, v)
    if "allowed_subnets" in body:
        nets = []
        for s in body["allowed_subnets"]:
            s = s.strip()
            if not s:
                continue
            try:
                nets.append(str(ipaddress.ip_network(s, strict=False)))
            except ValueError:
                raise HTTPException(400, f"Subnet ไม่ถูกต้อง: {s}")
        db.set_setting("allowed_subnets", nets)
    if "username" in body:
        db.set_setting("username", body["username"].strip())
    # empty / missing password = keep the stored one
    if body.get("password"):
        db.set_setting("password_enc", enc(body["password"]))
    if body.get("enable"):
        db.set_setting("enable_enc", enc(body["enable"]))
    if body.get("clear_enable"):
        db.set_setting("enable_enc", "")
    if "telnet_fallback" in body:
        db.set_setting("telnet_fallback", "1" if body["telnet_fallback"] else "0")
    return get_settings()


@app.get("/api/overrides")
def get_overrides():
    return [{"ip": r["ip"], "username": r["username"], "has_password": bool(r["password_enc"]),
             "has_enable": bool(r["enable_enc"]), "protocol": r["protocol"] or "ssh"}
            for r in db.q("SELECT * FROM cred_override ORDER BY ip")]


@app.put("/api/overrides")
def put_override(body: dict = Body(...)):
    ip = _check_ip(body.get("ip", ""))
    cur = db.q("SELECT * FROM cred_override WHERE ip=?", (ip,))
    cur = cur[0] if cur else {"password_enc": "", "enable_enc": ""}
    if not cur["password_enc"] and not body.get("password"):
        raise HTTPException(400, "ต้องใส่ password")
    protocol = body.get("protocol") or "ssh"
    if protocol not in ("ssh", "telnet"):
        raise HTTPException(400, "protocol ต้องเป็น ssh หรือ telnet")
    db.x("""INSERT INTO cred_override (ip, username, password_enc, enable_enc, protocol) VALUES (?,?,?,?,?)
            ON CONFLICT(ip) DO UPDATE SET username=excluded.username, password_enc=excluded.password_enc,
            enable_enc=excluded.enable_enc, protocol=excluded.protocol""",
         (ip, body.get("username", "").strip(),
          enc(body["password"]) if body.get("password") else cur["password_enc"],
          enc(body["enable"]) if body.get("enable") else ("" if body.get("clear_enable") else cur["enable_enc"]),
          protocol))
    return get_overrides()


@app.delete("/api/overrides")
def delete_override(body: dict = Body(...)):
    db.x("DELETE FROM cred_override WHERE ip=?", (body.get("ip", ""),))
    return get_overrides()


# ---------------------------------------------------------------- map edits

async def _push_topology():
    await hub.send({"type": "topology", "data": state.topology()})


@app.post("/api/positions")
async def save_positions(body: list = Body(...)):
    for p in body:
        db.x("UPDATE device SET pos_x=?, pos_y=? WHERE key=?", (float(p["x"]), float(p["y"]), p["key"]))
    return {"ok": True}


@app.delete("/api/positions")
async def reset_positions():
    db.x("UPDATE device SET pos_x=NULL, pos_y=NULL")
    await _push_topology()
    return {"ok": True}


@app.post("/api/cables/media")
async def set_media(body: dict = Body(...)):
    m = body.get("media")
    if m is not None and m not in MEDIA_TYPES:
        raise HTTPException(400, "media ไม่ถูกต้อง")
    db.x("UPDATE cable SET media_override=? WHERE id=?", (m, body.get("id")))
    await _push_topology()
    return {"ok": True}


@app.post("/api/devices/ack")
async def ack_device(body: dict = Body(...)):
    if not state.acknowledge_device(body.get("key", "")):
        raise HTTPException(400, "รับทราบได้เฉพาะอุปกรณ์ที่สถานะ down")
    await _push_topology()
    return {"ok": True}


@app.delete("/api/devices")
async def delete_devices(body: dict = Body(...)):
    keys = body.get("keys") or ([body["key"]] if body.get("key") else [])
    if not isinstance(keys, list) or not keys:
        raise HTTPException(400, "ไม่ได้ระบุอุปกรณ์")
    n = state.delete_devices([str(k) for k in keys])
    await _push_topology()
    return {"ok": True, "deleted": n}


@app.delete("/api/topology")
async def clear_topology(events: bool = False):
    if crawl_lock.locked():
        raise HTTPException(409, "กำลัง crawl อยู่ — รอให้เสร็จก่อนแล้วค่อยล้างแผนที่")
    n = state.clear_map(clear_events=events)
    await _push_topology()
    return {"ok": True, "deleted": n}


# ---------------------------------------------------------------- portable package (zip of the program)

ROOT = STATIC.parent
RUNTIME_PY = ROOT / "runtime" / "python" / "python.exe"
# allow-list: only these go in the zip. data\ (map, credentials, secret.key), .venv and tests never do.
PACKAGE_DIRS = ["app", "static", "runtime", "tools", "docs"]
PACKAGE_FILES = ["start.bat", "README.md", "README.en.md", "LICENSE", "requirements.txt", "CONTEXT.md", ".gitignore"]
package_lock = threading.Lock()


def ensure_runtime() -> str:
    """Build runtime\\python if missing. Returns '' or a reason it could not be built."""
    if RUNTIME_PY.exists():
        return ""
    if sys.platform != "win32":
        return "สร้าง Python พกพาได้เฉพาะบน Windows"
    log.info("package: building runtime\\python")
    r = subprocess.run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
                        str(ROOT / "tools" / "make-portable.ps1")], capture_output=True, text=True, timeout=900)
    if r.returncode or not RUNTIME_PY.exists():
        log.warning("package: runtime build failed: %s", (r.stderr or r.stdout)[-500:])
        return "สร้าง Python พกพาไม่สำเร็จ (ต่อเน็ตไม่ได้?)"
    return ""


def build_package(dest: Path) -> bool:
    """Write the zip; True if it contains the portable runtime."""
    def files():
        for d in PACKAGE_DIRS:
            for p in sorted((ROOT / d).rglob("*")) if (ROOT / d).is_dir() else []:
                if p.is_file() and "__pycache__" not in p.parts and p.suffix != ".pyc":
                    yield p
        for f in PACKAGE_FILES:
            if (ROOT / f).is_file():
                yield ROOT / f

    has_rt = False
    with zipfile.ZipFile(dest, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        for p in files():
            rel = p.relative_to(ROOT)
            has_rt = has_rt or rel.parts[0] == "runtime"
            z.write(p, Path("NWD") / rel)
    return has_rt


@app.get("/api/package")
async def download_package():
    if not package_lock.acquire(blocking=False):
        raise HTTPException(409, "กำลังสร้างชุดโปรแกรมอยู่แล้ว รอสักครู่")
    try:
        warn = await asyncio.to_thread(ensure_runtime)
        fd, tmp = tempfile.mkstemp(suffix=".zip")
        os.close(fd)
        has_rt = await asyncio.to_thread(build_package, Path(tmp))
    except Exception as e:
        log.exception("package")
        raise HTTPException(500, f"สร้าง zip ไม่สำเร็จ: {e}")
    finally:
        package_lock.release()
    name = f"NWD-portable-{time.strftime('%Y-%m-%d')}.zip" if has_rt else f"NWD-{time.strftime('%Y-%m-%d')}-no-python.zip"
    headers = {"X-NWD-Runtime": "1" if has_rt else "0"}
    if warn:
        headers["X-NWD-Warning"] = quote(warn)
    return FileResponse(tmp, filename=name, media_type="application/zip", headers=headers,
                        background=BackgroundTask(os.remove, tmp))


# ---------------------------------------------------------------- open a terminal to a switch

# old IOS (2960 on 15.x) only offers SHA1 KEX, ssh-rsa host keys and CBC ciphers
SSH_LEGACY = ["-o", "KexAlgorithms=+diffie-hellman-group14-sha1,diffie-hellman-group1-sha1",
              "-o", "HostKeyAlgorithms=+ssh-rsa", "-o", "PubkeyAcceptedAlgorithms=+ssh-rsa",
              "-o", "Ciphers=+aes128-cbc,aes256-cbc,3des-cbc",
              "-o", "MACs=+hmac-sha1,hmac-sha1-96,hmac-md5"]
_SAFE = re.compile(r"[^\w.@\\-]")   # wt.exe treats ';' as a command separator; keep args plain


def terminal_command(ip: str, username: str, proto: str, title: str) -> tuple[list[str], bool]:
    """(argv, uses_windows_terminal). Password is never put on the command line."""
    if proto == "telnet":
        cmd = [shutil.which("telnet") or "telnet.exe", ip]
    else:
        cmd = [shutil.which("ssh") or "ssh.exe", *SSH_LEGACY]
        if username:
            cmd += ["-l", _SAFE.sub("", username)]
        cmd.append(ip)
    wt = shutil.which("wt")
    if wt:
        return [wt, "-w", "0", "new-tab", "--title", _SAFE.sub("", title) or ip, *cmd], True
    return cmd, False


@app.post("/api/devices/terminal")
async def open_terminal(request: Request, body: dict = Body(...)):
    # JSON-only so another web page can't trigger this with a plain form post
    if not request.headers.get("content-type", "").startswith("application/json"):
        raise HTTPException(415, "ต้องเป็น JSON")
    if sys.platform != "win32":
        raise HTTPException(501, "รองรับเฉพาะ Windows")
    rows = db.q("SELECT name, ip, proto FROM device WHERE key=?", (body.get("key", ""),))
    if not rows or not rows[0]["ip"]:
        raise HTTPException(400, "อุปกรณ์นี้ไม่มี IP")
    d = rows[0]
    ip = _check_ip(d["ip"])
    cred = cred_for(ip)
    proto = "telnet" if (d["proto"] == "telnet" or cred["protocol"] == "telnet") else "ssh"
    argv, in_wt = terminal_command(ip, cred["username"], proto, d["name"])
    try:
        subprocess.Popen(argv, creationflags=0 if in_wt else subprocess.CREATE_NEW_CONSOLE)
    except OSError as e:
        raise HTTPException(500, f"เปิด terminal ไม่ได้: {e}")
    return {"ok": True, "proto": proto, "username": cred["username"]}


@app.post("/api/cables/ack")
async def ack_cable(body: dict = Body(...)):
    if not state.acknowledge_cable(body.get("id", "")):
        raise HTTPException(400, "รับทราบได้เฉพาะสายที่สถานะ down")
    await _push_topology()
    return {"ok": True}


# ---------------------------------------------------------------- websocket

@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await ws.accept()
    hub.clients.add(ws)
    try:
        await ws.send_json({"type": "topology", "data": state.topology()})
        await ws.send_json({"type": "status", "data": status})
        while True:
            await ws.receive_text()   # keepalive pings from the page
    except WebSocketDisconnect:
        pass
    finally:
        hub.clients.discard(ws)
