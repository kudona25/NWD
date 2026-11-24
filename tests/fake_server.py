"""Run the real app against a simulated network (no switches needed).

    python -m uvicorn tests.fake_server:app --port 8001
"""
import os

os.environ.setdefault("NWD_DATA", os.path.join(os.path.dirname(__file__), "..", "data-fake"))

from app import crawler, main  # noqa: E402

SEP = "-------------------------\n"


def cdp(name, ip, platform, caps, local, remote):
    return (f"{SEP}Device ID: {name}\nEntry address(es): \n  IP address: {ip}\n"
            f"Platform: {platform},  Capabilities: {caps} \n"
            f"Interface: {local},  Port ID (outgoing port): {remote}\nHoldtime : 150 sec\n\n"
            f"Management address(es): \n  IP address: {ip}\n\n")


def status(rows):
    out = "\nPort         Name               Status       Vlan       Duplex  Speed Type \n"
    for port, typ in rows:
        out += f"{port:<13}{'':<19}connected    trunk        full   a-1000 {typ}\n"
    return out


SW = "Switch IGMP"
AP = "Router Trans-Bridge Source-Route-Bridge IGMP"
LR, SX, TX = "SFP-10GBase-LR", "1000BaseSX SFP", "10/100/1000BaseTX"

NET = {
    "10.10.1.1": ("SW-CORE", [
        ("SW-BLD-A.example.local", "10.10.1.11", "cisco C9300-48P", SW, "TenGigabitEthernet1/1/1", "TenGigabitEthernet1/1/1", LR),
        ("SW-BLD-A.example.local", "10.10.1.11", "cisco C9300-48P", SW, "TenGigabitEthernet1/1/2", "TenGigabitEthernet1/1/2", LR),
        ("SW-BLD-B", "10.10.1.12", "cisco C9200L-48P-4X", SW, "TenGigabitEthernet1/1/3", "TenGigabitEthernet1/1/1", LR),
        ("SW-OFFICE", "10.10.1.13", "cisco WS-C2960X-48FPS-L", SW, "GigabitEthernet1/0/47", "GigabitEthernet1/0/49", SX),
        ("SW-WAREHOUSE", "10.10.1.14", "cisco WS-C2960L-24PS", SW, "GigabitEthernet1/0/48", "GigabitEthernet0/25", TX),
    ]),
    "10.10.1.11": ("SW-BLD-A", [
        ("SW-CORE", "10.10.1.1", "cisco C9300-48UXM", "Router Switch IGMP", "TenGigabitEthernet1/1/1", "TenGigabitEthernet1/1/1", LR),
        ("SW-CORE", "10.10.1.1", "cisco C9300-48UXM", "Router Switch IGMP", "TenGigabitEthernet1/1/2", "TenGigabitEthernet1/1/2", LR),
        ("SW-LINE1", "10.10.2.21", "cisco C9200-24P", SW, "GigabitEthernet1/0/48", "GigabitEthernet1/1/1", SX),
        ("SW-LINE2", "10.10.2.22", "cisco C9200-24P", SW, "GigabitEthernet1/0/47", "GigabitEthernet1/1/1", SX),
        *[(f"AP-A-{i:02d}", f"10.30.0.{10+i}", "cisco C9120AXI-S", AP, f"GigabitEthernet1/0/{i}", "GigabitEthernet0", TX) for i in range(1, 5)],
    ]),
    "10.10.1.12": ("SW-BLD-B", [
        ("SW-CORE", "10.10.1.1", "cisco C9300-48UXM", "Router Switch IGMP", "TenGigabitEthernet1/1/1", "TenGigabitEthernet1/1/3", LR),
        *[(f"Meraki MR46 - AP-B-{i:02d}", f"10.30.1.{10+i}", "Meraki MR46 Cloud Managed AP", "Switch", f"GigabitEthernet1/0/{i}", "Port 0", TX) for i in range(1, 8)],
    ]),
    "10.10.1.13": None,  # wrong password
    "10.10.1.14": ("SW-WAREHOUSE", [
        ("SW-CORE", "10.10.1.1", "cisco C9300-48UXM", "Router Switch IGMP", "GigabitEthernet0/25", "GigabitEthernet1/0/48", TX),
        ("AP-WH-01", "10.30.2.11", "cisco AIR-AP2802I-E-K9", AP, "GigabitEthernet0/3", "GigabitEthernet0", TX),
    ]),
    "10.10.2.21": ("SW-LINE1", [
        ("SW-BLD-A", "10.10.1.11", "cisco C9300-48P", SW, "GigabitEthernet1/1/1", "GigabitEthernet1/0/48", SX),
        *[(f"AP-L1-{i:02d}", f"10.30.3.{10+i}", "cisco C9115AXI-S", AP, f"GigabitEthernet1/0/{i}", "GigabitEthernet0", TX) for i in range(1, 4)],
    ]),
    "10.10.2.22": ("SW-LINE2", [
        ("SW-BLD-A", "10.10.1.11", "cisco C9300-48P", SW, "GigabitEthernet1/1/1", "GigabitEthernet1/0/47", SX),
    ]),
}


def fake_fetch(ip, cred):
    entry = NET.get(ip)
    if entry is None:
        raise ConnectionError("Authentication failed")
    host, neigh = entry
    from app.parsers import short_if
    return {
        "hostname": host,
        "proto": "telnet" if host == "SW-WAREHOUSE" else "ssh",
        "cdp": "".join(cdp(n, i, p, c, l, r) for n, i, p, c, l, r, _ in neigh),
        "lldp": "",
        "intstatus": status([(short_if(l), t) for *_, l, r, t in neigh]),
    }


crawler.device_fetch = fake_fetch
main.crawler.device_fetch = fake_fetch
app = main.app
