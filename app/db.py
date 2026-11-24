"""SQLite storage. One file: data/nwd.db"""
import json
import os
import sqlite3
import threading
import time
from pathlib import Path

DATA_DIR = Path(os.environ.get("NWD_DATA") or Path(__file__).resolve().parent.parent / "data")
DB_PATH = DATA_DIR / "nwd.db"

_lock = threading.RLock()
_conn: sqlite3.Connection | None = None

SCHEMA = """
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS cred_override (
    ip TEXT PRIMARY KEY, username TEXT, password_enc TEXT, enable_enc TEXT,
    protocol TEXT DEFAULT 'ssh'      -- ssh | telnet
);

-- current map state
CREATE TABLE IF NOT EXISTS device (
    key TEXT PRIMARY KEY,
    name TEXT, kind TEXT, platform TEXT, ip TEXT,
    status TEXT,            -- up | unreachable | boundary | suspect | down
    note TEXT,              -- why unreachable / boundary
    hop INTEGER, parent TEXT,
    miss INTEGER DEFAULT 0,
    first_seen REAL, last_seen REAL,
    pos_x REAL, pos_y REAL,
    proto TEXT,             -- how we logged in last time: ssh | telnet (switches only)
    serial TEXT             -- System Serial Number(s) from show version; stack = "SN1, SN2"
);

CREATE TABLE IF NOT EXISTS cable (
    id TEXT PRIMARY KEY,    -- "A|portA||B|portB" with A<B
    a TEXT, a_port TEXT, b TEXT, b_port TEXT,
    media TEXT, media_override TEXT,
    status TEXT,            -- up | suspect | down
    miss INTEGER DEFAULT 0,
    first_seen REAL, last_seen REAL
);

CREATE TABLE IF NOT EXISTS event (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts REAL, kind TEXT, subject TEXT, detail TEXT
);

CREATE TABLE IF NOT EXISTS run (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started REAL, finished REAL, trigger TEXT,
    reached INTEGER, failed INTEGER, ok INTEGER, note TEXT
);
"""

DEFAULTS = {
    "seed_ip": "",
    "interval_min": "5",
    "max_hops": "10",
    "workers": "10",
    "timeout_sec": "60",
    "allowed_subnets": "[]",
    "username": "",
    "password_enc": "",
    "enable_enc": "",
    "telnet_fallback": "0",
}

# columns added after v1 — ALTER existing databases
MIGRATIONS = [
    ("cred_override", "protocol", "TEXT DEFAULT 'ssh'"),
    ("device", "proto", "TEXT"),
    ("device", "serial", "TEXT"),
]


def conn() -> sqlite3.Connection:
    global _conn
    if _conn is None:
        DATA_DIR.mkdir(exist_ok=True)
        _conn = sqlite3.connect(DB_PATH, check_same_thread=False, isolation_level=None)
        _conn.row_factory = sqlite3.Row
        _conn.execute("PRAGMA journal_mode=WAL")
        _conn.executescript(SCHEMA)
        for table, col, decl in MIGRATIONS:
            cols = {r[1] for r in _conn.execute(f"PRAGMA table_info({table})")}
            if col not in cols:
                _conn.execute(f"ALTER TABLE {table} ADD COLUMN {col} {decl}")
        for k, v in DEFAULTS.items():
            _conn.execute("INSERT OR IGNORE INTO settings VALUES (?,?)", (k, v))
    return _conn


def q(sql: str, args=()) -> list[dict]:
    with _lock:
        return [dict(r) for r in conn().execute(sql, args).fetchall()]


def x(sql: str, args=()) -> None:
    with _lock:
        conn().execute(sql, args)


def tx(fn):
    """Run fn(connection) inside one transaction."""
    with _lock:
        c = conn()
        c.execute("BEGIN")
        try:
            fn(c)
            c.execute("COMMIT")
        except Exception:
            c.execute("ROLLBACK")
            raise


def get_settings() -> dict:
    s = {r["key"]: r["value"] for r in q("SELECT key, value FROM settings")}
    s["interval_min"] = max(1, int(s["interval_min"] or 5))
    s["max_hops"] = max(1, int(s["max_hops"] or 10))
    s["workers"] = max(1, min(50, int(s["workers"] or 10)))
    s["timeout_sec"] = max(10, min(600, int(s.get("timeout_sec") or 60)))
    s["allowed_subnets"] = json.loads(s["allowed_subnets"] or "[]")
    s["telnet_fallback"] = s.get("telnet_fallback") == "1"
    return s


def set_setting(key: str, value) -> None:
    if not isinstance(value, str):
        value = json.dumps(value) if isinstance(value, (list, dict)) else str(value)
    x("INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, value))


def add_event(kind: str, subject: str, detail: str = "", ts: float | None = None, c=None) -> dict:
    ev = {"ts": ts or time.time(), "kind": kind, "subject": subject, "detail": detail}
    sql = "INSERT INTO event (ts, kind, subject, detail) VALUES (?,?,?,?)"
    args = (ev["ts"], kind, subject, detail)
    if c is not None:
        c.execute(sql, args)
    else:
        x(sql, args)
    return ev
