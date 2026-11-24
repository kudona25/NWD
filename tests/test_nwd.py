"""Run:  python -m pytest -q tests"""
import time
from pathlib import Path

import pytest

from app import crawler, db, parsers as P, state

FX = Path(__file__).parent / "fixtures"
read = lambda n: (FX / f"{n}.txt").read_text()

SETTINGS = {"seed_ip": "10.10.1.1", "max_hops": 10, "workers": 4, "allowed_subnets": []}
CRED = lambda ip: {"username": "u", "password": "p", "enable": ""}


def network(**override):
    net = {
        "10.10.1.1": {"hostname": "SW-CORE", "cdp": read("core_cdp"), "lldp": "", "intstatus": read("core_intstatus")},
        "10.10.1.11": {"hostname": "SW-ACC-01", "cdp": read("acc_cdp"), "lldp": read("acc_lldp"),
                       "intstatus": read("acc_intstatus")},
        "10.10.1.21": None,  # 2960 with wrong password
    }
    net.update(override)

    def fetch(ip, cred):
        out = net.get(ip)
        if out is None:
            raise ConnectionError("Authentication failed")
        return out
    return fetch


@pytest.fixture(autouse=True)
def fresh_db(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DATA_DIR", tmp_path)
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "t.db")
    monkeypatch.setattr(db, "_conn", None)
    db.set_setting("seed_ip", "10.10.1.1")
    yield


def run(fetch, settings=SETTINGS):
    snap = crawler.crawl(settings, CRED, fetch)
    return snap, state.apply(snap, "test", time.time())


def by_key():
    return {d["key"]: d for d in db.q("SELECT * FROM device")}


# ---------------------------------------------------------------- parsers

def test_meraki_name_not_truncated():
    names = {n["name"] for n in P.parse_cdp(read("acc_cdp"))}
    assert "WH-AP-02" in names


def test_phone_and_router_ignored_media_mapped():
    n = {x["name"]: x for x in P.parse_cdp(read("core_cdp"))}
    assert n["SEP001122334455"]["kind"] == "other"
    assert n["FW-EDGE"]["kind"] == "other"
    assert P.media_type("1000BaseSX SFP") == "MM"
    assert P.media_type("SFP-10GBase-LR") == "SM"
    assert P.media_type("SFP-H10GB-CU1M") == "DAC"
    assert P.media_type("10/100/1000BaseTX") == "UTP"
    assert P.media_type("Not Present") == "Unknown"


VER_9300_STACK = """Cisco IOS XE Software, Version 17.09.04a
cisco C9300-48P (X86) processor with 1338934K/6147K bytes of memory.
Processor board ID FOC2345X0AB
Model Number                       : C9300-48P
System Serial Number               : FOC2345X0AB

Switch 02
---------
Model Number                       : C9300-48P
System Serial Number               : FOC2345X1CD
"""
VER_2960 = """cisco WS-C2960X-48FPS-L (APM86XXX) processor (revision B0) with 524288K bytes of memory.
Processor board ID FOC1928W1ZZ
Model number                    : WS-C2960X-48FPS-L
System serial number            : FOC1928W1ZZ
"""


def test_parse_serial():
    assert P.parse_serial(VER_9300_STACK) == "FOC2345X0AB, FOC2345X1CD"
    assert P.parse_serial(VER_2960) == "FOC1928W1ZZ"
    assert P.parse_serial("Processor board ID FTX1111A2BC\n") == "FTX1111A2BC"
    assert P.parse_serial("") == ""


def test_serial_stored_kept_and_change_reported():
    core = network()("10.10.1.1", None)
    run(network(**{"10.10.1.1": {**core, "version": VER_2960}}))
    assert by_key()["SW-CORE"]["serial"] == "FOC1928W1ZZ"
    run(network())  # show version gave nothing this time -> keep it
    assert by_key()["SW-CORE"]["serial"] == "FOC1928W1ZZ"
    _, events = run(network(**{"10.10.1.1": {**core, "version": VER_9300_STACK}}))
    assert "serial_changed" in [e["kind"] for e in events]
    assert by_key()["SW-CORE"]["serial"] == "FOC2345X0AB, FOC2345X1CD"


# ---------------------------------------------------------------- crawl

def test_crawl_builds_tree():
    snap, events = run(network())
    d = snap.devices
    assert set(d) == {"SW-CORE", "SW-ACC-01", "SW-OLD-2960", "AP-LINE1-01", "WH-AP-02", "ARUBA-AP-OFFICE-03"}
    assert d["SW-OLD-2960"]["status"] == "unreachable"
    assert d["ARUBA-AP-OFFICE-03"]["kind"] == "ap" and d["ARUBA-AP-OFFICE-03"]["parent"] == "SW-ACC-01"
    # double uplink core<->acc: two cables, reported from both sides but stored once each
    core_acc = [c for c in snap.cables.values() if {c["a"], c["b"]} == {"SW-CORE", "SW-ACC-01"}]
    assert len(core_acc) == 2 and all(c["media"] == "SM" for c in core_acc)
    assert snap.reached == {"SW-CORE", "SW-ACC-01"}
    assert [e["kind"] for e in events] == ["initial"]


def test_allowed_subnets_and_hops():
    snap = crawler.crawl({**SETTINGS, "allowed_subnets": ["10.10.1.0/28"]}, CRED, network())
    assert snap.devices["SW-ACC-01"]["status"] == "up"
    assert snap.devices["SW-OLD-2960"]["status"] == "boundary"
    snap = crawler.crawl({**SETTINGS, "max_hops": 0}, CRED, network())
    assert snap.devices["SW-ACC-01"]["status"] == "boundary"


def test_hung_switch_times_out_without_stalling_crawl():
    ok = network()

    def fetch(ip, cred):
        if ip == "10.10.1.21":  # accepts the connection, then never answers
            time.sleep(5)
        return ok(ip, cred)

    t0 = time.time()
    snap = crawler.crawl({**SETTINGS, "timeout_sec": 0.3}, CRED, fetch)
    assert time.time() - t0 < 2
    old = snap.devices["SW-OLD-2960"]
    assert old["status"] == "unreachable" and old["note"].startswith("TimeoutError")
    assert snap.reached == {"SW-CORE", "SW-ACC-01"}


def test_hung_seed_reports_timeout():
    snap = crawler.crawl({**SETTINGS, "timeout_sec": 0.2}, CRED, lambda ip, cred: time.sleep(5))
    assert not snap.seed_ok and snap.seed_error.startswith("TimeoutError")


def test_seed_down_keeps_map():
    run(network())
    snap, events = run(network(**{"10.10.1.1": None}))
    assert not snap.seed_ok and events[0]["kind"] == "seed_fail"
    assert all(d["status"] != "down" for d in by_key().values())


# ---------------------------------------------------------------- suspect / down rules

def test_device_gone_while_parent_reached_is_down_immediately():
    run(network())
    acc = network()("10.10.1.11", None)
    blocks = read("acc_cdp").split("-------------------------")
    kept = [b for b in blocks if "AP-LINE1-01" not in b]
    _, events = run(network(**{"10.10.1.11": {**acc, "cdp": "-------------------------".join(kept)}}))
    assert by_key()["AP-LINE1-01"]["status"] == "down"
    assert "device_down" in [e["kind"] for e in events]


def test_parent_unreachable_gives_suspect_then_down():
    run(network())
    run(network(**{"10.10.1.11": None}))
    d = by_key()
    assert d["SW-ACC-01"]["status"] == "unreachable"
    assert d["AP-LINE1-01"]["status"] == "suspect"
    run(network(**{"10.10.1.11": None}))
    assert by_key()["AP-LINE1-01"]["status"] == "down"
    run(network())
    assert by_key()["AP-LINE1-01"]["status"] == "up"


def test_cable_moved_port():
    run(network())
    core = network()("10.10.1.1", None)
    moved = {**core, "cdp": core["cdp"].replace("Interface: GigabitEthernet1/0/24,", "Interface: GigabitEthernet1/0/23,")}
    _, events = run(network(**{"10.10.1.1": moved}))
    kinds = [e["kind"] for e in events]
    assert "cable_moved" in kinds and "cable_down" not in kinds


def test_ack_removes_down_device():
    run(network())
    run(network(**{"10.10.1.11": None}))
    run(network(**{"10.10.1.11": None}))
    assert state.acknowledge_device("AP-LINE1-01")
    assert "AP-LINE1-01" not in by_key()
    assert not state.acknowledge_device("SW-CORE")  # only down devices


def test_delete_any_device_and_its_cables():
    run(network())
    assert state.delete_devices(["SW-ACC-01", "AP-LINE1-01"]) == 2
    d = by_key()
    assert "SW-ACC-01" not in d and "AP-LINE1-01" not in d
    assert not db.q("SELECT * FROM cable WHERE a='SW-ACC-01' OR b='SW-ACC-01'")
    assert state.delete_devices(["NOPE"]) == 0


def test_clear_map_then_next_crawl_is_initial():
    run(network())
    assert state.clear_map(clear_events=True) == 6
    assert not by_key() and not db.q("SELECT * FROM cable")
    assert [e["kind"] for e in db.q("SELECT kind FROM event")] == ["cleared"]
    _, events = run(network())
    assert [e["kind"] for e in events] == ["initial"]


# ---------------------------------------------------------------- telnet bookkeeping

def test_proto_stored_and_event_on_switch_to_telnet():
    run(network())
    assert by_key()["SW-ACC-01"]["proto"] == "ssh" or by_key()["SW-ACC-01"]["proto"] is None
    acc = network()("10.10.1.11", None)
    _, events = run(network(**{"10.10.1.11": {**acc, "proto": "telnet"}}))
    assert by_key()["SW-ACC-01"]["proto"] == "telnet"
    assert "telnet" in [e["kind"] for e in events]


def test_migrates_v1_database(tmp_path, monkeypatch):
    import sqlite3
    path = tmp_path / "old.db"
    old = sqlite3.connect(path)
    old.executescript("""CREATE TABLE cred_override (ip TEXT PRIMARY KEY, username TEXT, password_enc TEXT, enable_enc TEXT);
                         CREATE TABLE device (key TEXT PRIMARY KEY, name TEXT);""")
    old.close()
    monkeypatch.setattr(db, "DB_PATH", path)
    monkeypatch.setattr(db, "_conn", None)
    cols = {r["name"] for r in db.q("PRAGMA table_info(cred_override)")}
    assert "protocol" in cols
    assert "proto" in {r["name"] for r in db.q("PRAGMA table_info(device)")}
    assert db.get_settings()["telnet_fallback"] is False
