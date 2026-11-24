"""Turn raw Cisco CLI output into neighbor / port records.

CDP is parsed here directly (the ntc-template cuts Device IDs at the first
space, which merges every Meraki AP into one "Meraki" device).
LLDP and `show interfaces status` use ntc-templates.
"""
import ipaddress
import re

from ntc_templates.parse import parse_output

# ---------------------------------------------------------------- names

_IF_SHORT = [
    ("HundredGigE", "Hu"),
    ("FortyGigabitEthernet", "Fo"),
    ("TwentyFiveGigE", "Twe"),
    ("TenGigabitEthernet", "Te"),
    ("TwoGigabitEthernet", "Tw"),
    ("FiveGigabitEthernet", "Fi"),
    ("AppGigabitEthernet", "Ap"),
    ("GigabitEthernet", "Gi"),
    ("FastEthernet", "Fa"),
    ("Port-channel", "Po"),
]


def short_if(name: str) -> str:
    """GigabitEthernet1/0/1 -> Gi1/0/1. Unknown names are returned trimmed."""
    name = (name or "").strip()
    for long, short in _IF_SHORT:
        if name.lower().startswith(long.lower()):
            return short + name[len(long):]
    return name


def _is_ip(s: str) -> bool:
    try:
        ipaddress.ip_address(s)
        return True
    except ValueError:
        return False


def device_name(raw: str) -> str:
    """Display name for a CDP Device ID / LLDP System Name."""
    s = (raw or "").strip()
    if s.lower().startswith("meraki ") and " - " in s:   # "Meraki MR46 - WH-AP-02"
        s = s.split(" - ", 1)[1].strip()
    s = re.sub(r"\(.*\)$", "", s).strip()                 # NX-OS "SW01(FOC123)"
    if not _is_ip(s) and "." in s:
        s = s.split(".", 1)[0]                            # strip domain
    return s


def device_key(raw: str) -> str:
    """Identity of a Device: hostname without domain, case-insensitive."""
    return device_name(raw).upper()


# ---------------------------------------------------------------- classify

_AP_PLATFORM = re.compile(r"(AIR-|C91\d\d|\bAP\b|Cloud Managed AP|Meraki MR|ArubaOS|Aruba AP|IAP)", re.I)


def classify_cdp(platform: str, caps: str) -> str:
    """'switch' | 'ap' | 'other'"""
    caps_l = (caps or "").lower()
    if "phone" in caps_l:
        return "other"
    if _AP_PLATFORM.search(platform or "") or "trans-bridge" in caps_l:
        return "ap"
    if "switch" in caps_l.split():
        return "switch"
    return "other"


def classify_lldp(caps: str, description: str) -> str:
    codes = {c.strip().upper() for c in re.split(r"[,\s]+", caps or "") if c.strip()}
    if "T" in codes:                      # telephone
        return "other"
    if "W" in codes or _AP_PLATFORM.search(description or ""):
        return "ap"
    if "B" in codes:
        return "switch"
    return "other"


# ---------------------------------------------------------------- media type

def media_type(transceiver: str) -> str:
    """Map the `Type` column of show interfaces status to UTP / MM / SM / DAC / Unknown."""
    t = (transceiver or "").upper()
    if not t or "NOT PRESENT" in t or t == "UNKNOWN":
        return "Unknown"
    if "-CU" in t or "TWINAX" in t or "DAC" in t:
        return "DAC"
    if "BASETX" in t or "BASE-T" in t or "BASET" in t or re.search(r"\b10/100", t):
        return "UTP"
    if re.search(r"(SX|SR|SR4|MMF|LRM)\b", t):
        return "MM"
    if re.search(r"(LX|LR|LR4|ER|ZR|ZX|BX|EX|LH|SMF)", t):
        return "SM"
    return "Unknown"


# ---------------------------------------------------------------- CDP

_CDP_FIELDS = {
    "device_id": re.compile(r"^Device ID:\s*(.+?)\s*$", re.M),
    "platform": re.compile(r"^Platform:\s*(.+?),\s*Capabilities:", re.M),
    "caps": re.compile(r"Capabilities:\s*(.+?)\s*$", re.M),
    "local": re.compile(r"^Interface:\s*(.+?),", re.M),
    "remote": re.compile(r"Port ID \(outgoing port\):\s*(.+?)\s*$", re.M),
}
_IP = re.compile(r"IP(?:v4)? [Aa]ddress:\s*(\d+\.\d+\.\d+\.\d+)")


def parse_cdp(text: str) -> list[dict]:
    out = []
    for block in re.split(r"^-{10,}\s*$", text or "", flags=re.M):
        m = {k: r.search(block) for k, r in _CDP_FIELDS.items()}
        if not m["device_id"] or not m["local"]:
            continue
        mgmt = None
        if "Management address" in block:
            ips = _IP.findall(block.split("Management address", 1)[1])
            mgmt = ips[0] if ips else None
        if not mgmt:
            ips = _IP.findall(block)
            mgmt = ips[0] if ips else None
        platform = m["platform"].group(1).strip() if m["platform"] else ""
        caps = m["caps"].group(1).strip() if m["caps"] else ""
        out.append({
            "proto": "cdp",
            "raw_name": m["device_id"].group(1),
            "name": device_name(m["device_id"].group(1)),
            "key": device_key(m["device_id"].group(1)),
            "ip": mgmt,
            "platform": platform,
            "kind": classify_cdp(platform, caps),
            "local_port": short_if(m["local"].group(1)),
            "remote_port": short_if(m["remote"].group(1)) if m["remote"] else "",
        })
    return out


# ---------------------------------------------------------------- LLDP

def parse_lldp(text: str) -> list[dict]:
    if not text or "LLDP is not enabled" in text or "Invalid input" in text:
        return []
    try:
        rows = parse_output(platform="cisco_ios", command="show lldp neighbors detail", data=text)
    except Exception:
        return []
    out = []
    for r in rows:
        raw = (r.get("neighbor_name") or "").strip() or (r.get("chassis_id") or "").strip()
        if not raw or not r.get("local_interface"):
            continue
        desc = r.get("neighbor_description") or ""
        port = (r.get("neighbor_interface") or "").strip() or (r.get("neighbor_port_id") or "").strip()
        mgmt = r.get("mgmt_address") or None
        if mgmt and not _is_ip(mgmt):
            mgmt = None
        out.append({
            "proto": "lldp",
            "raw_name": raw,
            "name": device_name(raw),
            "key": device_key(raw),
            "ip": mgmt,
            "platform": (r.get("platform") or desc.split(",")[0]).strip()[:80],
            "kind": classify_lldp(r.get("capabilities"), desc),
            "local_port": short_if(r["local_interface"]),
            "remote_port": short_if(port),
        })
    return out


def merge_neighbors(cdp: list[dict], lldp: list[dict]) -> list[dict]:
    """CDP wins when both protocols report the same neighbor on the same local port."""
    seen = {(n["local_port"], n["key"]) for n in cdp}
    cdp_ports = {n["local_port"] for n in cdp}
    merged = list(cdp)
    for n in lldp:
        if (n["local_port"], n["key"]) in seen:
            continue
        # same port, different name spelling (e.g. LLDP sends chassis MAC) -> trust CDP
        if n["local_port"] in cdp_ports and n["kind"] == "switch":
            continue
        merged.append(n)
    return merged


# ---------------------------------------------------------------- interfaces status

def parse_int_status(text: str) -> dict[str, str]:
    """{short_port: transceiver Type}"""
    try:
        rows = parse_output(platform="cisco_ios", command="show interfaces status", data=text or "")
    except Exception:
        return {}
    return {short_if(r["port"]): (r.get("type") or "").strip() for r in rows if r.get("port")}


# ---------------------------------------------------------------- show version

_SERIAL = re.compile(r"^\s*System Serial Number\s*:\s*(\S+)", re.M | re.I)
_BOARD_ID = re.compile(r"^\s*Processor Board ID\s+(\S+)", re.M | re.I)


def parse_serial(text: str) -> str:
    """System Serial Number(s) from `show version`; a stack gives one per member, e.g. 'FOC1, FOC2'.
    Falls back to 'Processor board ID' (routers, NX-OS, some older IOS)."""
    sns = _SERIAL.findall(text or "") or _BOARD_ID.findall(text or "")
    seen = []
    for s in (x.strip().rstrip(",") for x in sns):
        if s and s not in seen:
            seen.append(s)
    return ", ".join(seen)


def hostname_from_prompt(prompt: str) -> str:
    return re.sub(r"[>#]\s*$", "", (prompt or "").strip())
