"""Automatic rescan interval: settings validation and the scheduler loop.
Run:  python -m pytest -q tests"""
import asyncio

import pytest
from fastapi import HTTPException

from app import db, main


@pytest.fixture(autouse=True)
def fresh_db(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DATA_DIR", tmp_path)
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "t.db")
    monkeypatch.setattr(db, "_conn", None)
    yield


def put(**body):
    return asyncio.run(main.put_settings(body))


def test_interval_default_and_units():
    assert db.get_settings()["interval_min"] == 5
    for minutes in (0, 1, 90, 3 * 60, 2 * 1440, 6 * 43200, db.INTERVAL_MAX_MIN):
        put(interval_min=minutes)
        assert db.get_settings()["interval_min"] == minutes


@pytest.mark.parametrize("bad", [-1, db.INTERVAL_MAX_MIN + 1, "abc", None])
def test_interval_rejected(bad):
    put(interval_min=60)
    with pytest.raises(HTTPException):
        put(interval_min=bad)
    assert db.get_settings()["interval_min"] == 60


def run_scheduler(monkeypatch, steps):
    """Run main.scheduler with a fake crawl; `steps(crawls)` drives it and returns when done."""
    async def go():
        for name in ("wake", "resched", "resume"):
            monkeypatch.setattr(main, name, asyncio.Event())
        crawls = []

        async def fake_crawl(trigger):
            crawls.append(trigger)

        async def no_send(msg):
            pass

        monkeypatch.setattr(main, "run_crawl", fake_crawl)
        monkeypatch.setattr(main.hub, "send", no_send)
        main.resume.set()
        task = asyncio.create_task(main.scheduler())
        try:
            await asyncio.wait_for(steps(crawls), timeout=5)
        finally:
            task.cancel()
    asyncio.run(go())


def test_interval_off_waits_for_manual_rescan(monkeypatch):
    db.set_setting("interval_min", 0)

    async def steps(crawls):
        await asyncio.sleep(0.2)
        assert crawls == ["schedule"]           # first crawl, then nothing on its own
        assert main.status["next_run"] is None
        main.wake.set()                         # manual Rescan
        while len(crawls) < 2:
            await asyncio.sleep(0.01)
    run_scheduler(monkeypatch, steps)


def test_changed_interval_applies_immediately(monkeypatch):
    db.set_setting("interval_min", 43200)       # a month

    async def steps(crawls):
        await asyncio.sleep(0.2)
        assert len(crawls) == 1
        assert main.status["next_run"] > 0
        await main.put_settings({"interval_min": 0})   # switch off: re-planned without crawling
        await asyncio.sleep(0.1)
        assert len(crawls) == 1 and main.status["next_run"] is None
    run_scheduler(monkeypatch, steps)


def test_interval_elapses_and_crawls_again(monkeypatch):
    real = db.get_settings
    monkeypatch.setattr(db, "get_settings", lambda: {**real(), "interval_min": 0.002})  # ~0.12 s

    async def steps(crawls):
        while len(crawls) < 3:
            await asyncio.sleep(0.02)
    run_scheduler(monkeypatch, steps)
