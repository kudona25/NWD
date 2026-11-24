"""Drives the real Netmiko telnet path against a tiny fake Cisco IOS telnet server."""
import socket
import socketserver
import threading
from pathlib import Path

import pytest

from app import crawler

CDP = (Path(__file__).parent / "fixtures" / "core_cdp.txt").read_text().replace("\n", "\r\n")


class FakeIOS(socketserver.StreamRequestHandler):
    def readline(self):
        """Line ends at CR or LF; the LF/NUL right after a CR belongs to the previous line."""
        buf = b""
        while True:
            ch = self.rfile.read(1)
            if not ch:
                raise ConnectionError
            if ch == b"\xff":           # skip telnet IAC sequences
                self.rfile.read(2)
                continue
            after_cr, self._cr = getattr(self, "_cr", False), False
            if ch in (b"\n", b"\x00") and after_cr and not buf:
                continue
            if ch in (b"\r", b"\n"):
                self._cr = ch == b"\r"
                return buf.decode()
            buf += ch

    def w(self, s):
        self.wfile.write(s.encode())
        self.wfile.flush()

    def handle(self):
        try:
            self.w("\r\n\r\nUser Access Verification\r\n\r\nUsername: ")
            user = self.readline()
            self.w("\r\nPassword: ")
            pw = self.readline()
            if (user, pw) != ("admin", "secret"):
                self.w("\r\n% Authentication failed\r\n")
                return
            prompt = "SW-TELNET#"
            self.w("\r\n" + prompt)
            while True:
                cmd = self.readline().strip()
                out = ""
                if cmd.startswith("show cdp neighbors detail"):
                    out = CDP
                elif cmd.startswith("show"):
                    out = ""
                elif cmd == "exit":
                    return
                self.w(cmd + "\r\n" + (out + "\r\n" if out else "") + prompt)
        except (ConnectionError, OSError):
            pass


@pytest.fixture
def telnet_server(monkeypatch):
    srv = socketserver.ThreadingTCPServer(("127.0.0.1", 0), FakeIOS)
    srv.daemon_threads = True
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    # a port nothing listens on -> SSH is "refused"
    s = socket.socket(); s.bind(("127.0.0.1", 0)); closed = s.getsockname()[1]; s.close()
    monkeypatch.setattr(crawler, "TELNET_PORT", srv.server_address[1])
    monkeypatch.setattr(crawler, "SSH_PORT", closed)
    yield
    srv.shutdown()


CRED = {"username": "admin", "password": "secret", "enable": ""}


def test_fallback_to_telnet_when_ssh_refused(telnet_server):
    out = crawler.device_fetch("127.0.0.1", {**CRED, "protocol": "ssh", "telnet_fallback": True})
    assert out["proto"] == "telnet"
    assert out["hostname"] == "SW-TELNET"
    assert "SW-ACC-01" in out["cdp"]


def test_no_fallback_when_disabled(telnet_server):
    with pytest.raises(Exception):
        crawler.device_fetch("127.0.0.1", {**CRED, "protocol": "ssh", "telnet_fallback": False})


def test_override_forces_telnet(telnet_server):
    out = crawler.device_fetch("127.0.0.1", {**CRED, "protocol": "telnet"})
    assert out["proto"] == "telnet"


def test_listening_ssh_port_is_not_refused(monkeypatch):
    s = socket.socket(); s.bind(("127.0.0.1", 0)); s.listen()
    monkeypatch.setattr(crawler, "SSH_PORT", s.getsockname()[1])
    try:
        assert crawler.ssh_refused("127.0.0.1") is False
    finally:
        s.close()
