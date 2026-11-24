"""Fernet encryption for stored passwords.

The key lives in data/secret.key (created on first start), never in the DB.
Back up nwd.db and secret.key together, or saved passwords become unreadable.
"""
from cryptography.fernet import Fernet, InvalidToken

from .db import DATA_DIR

KEY_PATH = DATA_DIR / "secret.key"
_f: Fernet | None = None


def _fernet() -> Fernet:
    global _f
    if _f is None:
        DATA_DIR.mkdir(exist_ok=True)
        if not KEY_PATH.exists():
            KEY_PATH.write_bytes(Fernet.generate_key())
        _f = Fernet(KEY_PATH.read_bytes().strip())
    return _f


def enc(plain: str) -> str:
    return _fernet().encrypt(plain.encode()).decode() if plain else ""


def dec(token: str) -> str:
    if not token:
        return ""
    try:
        return _fernet().decrypt(token.encode()).decode()
    except InvalidToken:
        return ""
