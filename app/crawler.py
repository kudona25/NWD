"""One Crawl: breadth-first walk from the Seed Switch over CDP + LLDP."""
import ipaddress
import logging
import threading
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field

from . import parsers as P

log = logging.getLogger("nwd.crawl")

COMMANDS = {
    "cdp": "show cdp neighbors detail",
    "lldp": "show lldp neighbors detail",
    "intstatus": "show interfaces status",
    "version": "show version",
}


# ---------------------------------------------------------------- SSH / Telnet

SSH_PORT = 22
TELNET_PORT = 23


def ssh_refused(ip: str, timeout: float = 3) -> bool:
    """True only when the switch actively refuses TCP/22 (SSH not enabled).
    A timeout or unreachable host is NOT a reason to fall back to telnet."""
    import socket
    try:
        socket.create_connection((ip, SSH_PORT), timeout=timeout).close()
        return False
    except ConnectionRefusedError:
        return True
    except OSError:
        return False


def device_fetch(ip: str, cred: dict) -> dict:
    """Log in to one switch and return raw command output. Raises on failure.

    cred: username, password, enable, protocol ('ssh'|'telnet'), telnet_fallback (bool),
          timeout (seconds for the whole device; also caps each command's read)
    """
    proto = cred.get("protocol") or "ssh"
    if proto == "ssh" and cred.get("telnet_fallback") and ssh_refused(ip):
        log.info("%s: SSH refused, falling back to telnet", ip)
        proto = "telnet"
    return _run(ip, cred, proto)


def _run(ip: str, cred: dict, proto: str) -> dict:
    from netmiko import ConnectHandler  # imported lazily so tests don't need a network

    params = dict(
        device_type="cisco_ios_telnet" if proto == "telnet" else "cisco_ios",
        host=ip,
        port=TELNET_PORT if proto == "telnet" else SSH_PORT,
        username=cred["username"],
        password=cred["password"],
        secret=cred.get("enable") or "",
        conn_timeout=8,
        auth_timeout=10,
        banner_timeout=10,
        fast_cli=False,
        # 2960 on IOS 15.x only speaks SHA1 KEX (dh-group14-sha1) and ssh-rsa host keys.
        # paramiko 4+ dropped them, so requirements.txt pins paramiko<4.
    )
    with ConnectHandler(**params) as c:
        if cred.get("enable") and not c.check_enable_mode():
            c.enable()
        out = {"hostname": P.hostname_from_prompt(c.find_prompt()), "proto": proto}
        for k, cmd in COMMANDS.items():
            try:
                out[k] = c.send_command(cmd, read_timeout=min(90, cred.get("timeout") or 90))
            except Exception as e:  # one command failing (e.g. LLDP off) shouldn't kill the device
                log.warning("%s: %s failed: %s", ip, cmd, e)
                out[k] = ""
        return out


def with_deadline(fn, seconds: float):
    """Run fn() but give up after `seconds`.

    Netmiko has no overall limit: a switch that accepts TCP and then stalls can hold a worker
    for minutes, and each BFS wave waits for its slowest switch. The stalled thread is a daemon
    left to finish on netmiko's own timeouts; its result is dropped."""
    box = {}

    def run():
        try:
            box["out"] = fn()
        except BaseException as e:
            box["err"] = e

    t = threading.Thread(target=run, daemon=True)
    t.start()
    t.join(seconds)
    if t.is_alive():
        raise TimeoutError(f"ไม่ตอบภายใน {seconds:g} วินาที")
    if "err" in box:
        raise box["err"]
    return box["out"]


# ---------------------------------------------------------------- crawl

@dataclass
class Snapshot:
    seed_ok: bool = False
    seed_error: str = ""
    devices: dict = field(default_factory=dict)   # key -> dict
    cables: dict = field(default_factory=dict)    # id  -> dict
    reached: set = field(default_factory=set)     # keys of switches we logged in to
    failed: int = 0


def cable_id(a: str, a_port: str, b: str, b_port: str) -> tuple[str, dict]:
    (a, a_port), (b, b_port) = sorted([(a, a_port), (b, b_port)])
    return f"{a}|{a_port}||{b}|{b_port}", {"a": a, "a_port": a_port, "b": b, "b_port": b_port}


def ip_allowed(ip: str, subnets: list[str]) -> bool:
    if not subnets:
        return True
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return False
    for s in subnets:
        try:
            if addr in ipaddress.ip_network(s, strict=False):
                return True
        except ValueError:
            continue
    return False


def crawl(settings: dict, cred_for, fetch=device_fetch, progress=None) -> Snapshot:
    """
    settings: seed_ip, max_hops, workers, allowed_subnets, timeout_sec (per switch)
    cred_for(ip) -> {"username","password","enable"}
    fetch(ip, cred) -> {"hostname","proto","cdp","lldp","intstatus"}  (raises on failure)
    progress(done, total) optional callback
    """
    snap = Snapshot()
    seed_ip = settings["seed_ip"]
    subnets = settings.get("allowed_subnets") or []
    max_hops = settings.get("max_hops", 10)
    timeout = settings.get("timeout_sec", 60)

    queued_ips = {seed_ip}
    # (ip, hop, expected_key, parent_key)
    frontier = [(seed_ip, 0, None, None)]
    done = 0

    def job(item):
        ip = item[0]
        try:
            cred = {**cred_for(ip), "timeout": timeout}
            return item, with_deadline(lambda: fetch(ip, cred), timeout), None
        except Exception as e:
            return item, None, f"{type(e).__name__}: {e}"[:200]

    with ThreadPoolExecutor(max_workers=settings.get("workers", 10)) as pool:
        while frontier:
            wave, frontier = frontier, []
            for (ip, hop, expected, parent), out, err in pool.map(job, wave):
                done += 1
                if progress:
                    progress(done, done + len(frontier))

                if err:
                    snap.failed += 1
                    log.info("login failed %s: %s", ip, err)
                    if hop == 0:
                        snap.seed_error = err
                        continue
                    d = snap.devices.get(expected)
                    if d:
                        d.update(status="unreachable", note=err)
                    continue

                key = P.device_key(out["hostname"]) or (expected or ip)
                if hop == 0:
                    snap.seed_ok = True
                if key in snap.reached:
                    continue  # same switch reached through a second IP
                if expected and expected != key and expected in snap.devices:
                    _rename(snap, expected, key)

                snap.reached.add(key)
                dev = snap.devices.setdefault(key, {"key": key, "kind": "switch", "platform": ""})
                dev.update(name=P.device_name(out["hostname"]) or dev.get("name") or key,
                           ip=ip, status="up", note="", hop=hop, proto=out.get("proto", "ssh"),
                           serial=P.parse_serial(out.get("version", "")),
                           parent=dev.get("parent", parent))

                ports = P.parse_int_status(out.get("intstatus", ""))
                neigh = P.merge_neighbors(P.parse_cdp(out.get("cdp", "")),
                                          P.parse_lldp(out.get("lldp", "")))
                for n in neigh:
                    if n["kind"] == "other" or n["key"] == key:
                        continue
                    _add_cable(snap, key, n, P.media_type(ports.get(n["local_port"], "")))

                    if n["key"] in snap.devices:
                        nd = snap.devices[n["key"]]
                        if not nd.get("platform") and n["platform"]:
                            nd["platform"] = n["platform"]
                        # first parent gave no IP, this one does -> try it
                        if (nd.get("status") == "unreachable" and not nd.get("ip") and n["ip"]
                                and ip_allowed(n["ip"], subnets) and n["ip"] not in queued_ips):
                            nd.update(ip=n["ip"], status="pending", note="")
                            queued_ips.add(n["ip"])
                            frontier.append((n["ip"], nd["hop"], n["key"], nd["parent"]))
                        continue

                    nd = {"key": n["key"], "name": n["name"], "kind": n["kind"],
                          "platform": n["platform"], "ip": n["ip"], "hop": hop + 1,
                          "parent": key, "note": ""}
                    snap.devices[n["key"]] = nd

                    if n["kind"] == "ap":
                        nd["status"] = "up"          # leaf: seen is enough
                    elif hop + 1 > max_hops:
                        nd.update(status="boundary", note=f"เกิน {max_hops} hop")
                    elif not n["ip"]:
                        nd.update(status="unreachable", note="ไม่มี management IP ใน CDP/LLDP")
                    elif not ip_allowed(n["ip"], subnets):
                        nd.update(status="boundary", note="อยู่นอก Allowed Subnets")
                    elif n["ip"] in queued_ips:
                        nd.update(status="up")
                    else:
                        nd["status"] = "pending"
                        queued_ips.add(n["ip"])
                        frontier.append((n["ip"], hop + 1, n["key"], key))

    for d in snap.devices.values():
        if d.get("status") == "pending":
            d.update(status="unreachable", note="ไม่ได้รับผลการเชื่อมต่อ")
    return snap


def _add_cable(snap: Snapshot, local: str, n: dict, media: str):
    cid, ends = cable_id(local, n["local_port"], n["key"], n["remote_port"])
    c = snap.cables.get(cid)
    if c is None:
        snap.cables[cid] = {"id": cid, **ends, "media": media}
        return
    if c["media"] == "Unknown" and media != "Unknown":
        c["media"] = media


def _rename(snap: Snapshot, old: str, new: str):
    d = snap.devices.pop(old)
    d["key"] = new
    snap.devices[new] = d
    for cid in list(snap.cables):
        c = snap.cables[cid]
        if old not in (c["a"], c["b"]):
            continue
        del snap.cables[cid]
        a = new if c["a"] == old else c["a"]
        b = new if c["b"] == old else c["b"]
        nid, ends = cable_id(a, c["a_port"], b, c["b_port"])
        snap.cables[nid] = {"id": nid, **ends, "media": c["media"]}
    for dd in snap.devices.values():
        if dd.get("parent") == old:
            dd["parent"] = new
