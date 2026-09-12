import asyncio
import json
import random
import time

from telethon.errors import FloodWaitError
from telethon.tl.types import InputUser

from . import database as db
from .telegram_manager import TelegramManager, tg as _tg_manager


class CampaignManager:
    def __init__(self, tg_manager):
        self._events = {}
        self._tasks = {}
        self._resolved = {}
        self.tg = tg_manager

    def _ev(self, cid: int) -> asyncio.Event:
        if cid not in self._events:
            self._events[cid] = asyncio.Event()
        return self._events[cid]

    def is_running(self, cid: int) -> bool:
        return cid in self._tasks and self._tasks[cid]

    async def start(self, cid: int):
        camp = db.get_campaign(cid)
        if not camp:
            raise ValueError("Campaign not found")
        if camp.get("status") == "running":
            return
        account_ids = [int(x) for x in (camp["account_ids"] or "").split(",") if x]
        accounts = [a for a in db.accounts_by_ids(account_ids) if a.get("status") == "active"]
        if not accounts:
            raise ValueError("No active accounts assigned to this campaign")
        ev = self._ev(cid)
        ev.clear()
        db.update_campaign(cid, status="running", started_at=db._now())
        self._tasks[cid] = [asyncio.create_task(self._worker(cid, a["id"])) for a in accounts]

    async def stop(self, cid: int):
        self._ev(cid).set()
        for t in self._tasks.pop(cid, []) or []:
            t.cancel()
        db.update_campaign(cid, status="stopped", finished_at=db._now())

    async def _worker(self, cid: int, account_id: int):
        try:
            await self._worker_inner(cid, account_id)
        finally:
            self._check_wrap_up(cid)

    async def _worker_inner(self, cid: int, account_id: int):
        camp = db.get_campaign(cid)
        account = db.get_account(account_id)
        if not camp or not account or not account.get("session_string"):
            return
        try:
            client = await self.tg.get_client(account)
        except Exception as e:
            db.add_log(cid, account_id, "-", "failed", f"account error: {e}")
            return

        ev = self._ev(cid)
        message = camp.get("message") or ""
        media = camp.get("media") or None
        min_delay = max(1.0, float(camp.get("min_delay") or 30))
        max_delay = max(min_delay, float(camp.get("max_delay") or 90))
        max_p = int(camp.get("max_per_account") or 0)
        sent_local = 0
        flood_sleep = 0.0

        while not ev.is_set():
            if flood_sleep:
                await self._sleep(flood_sleep, ev)
                flood_sleep = 0.0
                continue
            if max_p and sent_local >= max_p:
                break
            targets = db.get_pending_targets(cid, account_id, 10)
            if not targets:
                if db.count_pending(cid) == 0:
                    break
                await asyncio.sleep(2)
                continue
            for t in targets:
                if ev.is_set() or (max_p and sent_local >= max_p):
                    break
                db.mark_target(t["id"], "sending")
                status, detail = await self._send(client, message, media, t)
                if status == "sent":
                    db.mark_target(t["id"], "sent")
                    db.add_log(cid, account_id, t.get("target"), "sent")
                    db.bump_campaign(cid, sent=1)
                    sent_local += 1
                    await self._sleep(random.uniform(min_delay, max_delay), ev)
                elif status == "flood":
                    db.mark_target(t["id"], "pending")
                    db.add_log(cid, account_id, t.get("target"), "flood_wait",
                               f"flood {detail}s")
                    flood_sleep = float(detail)
                    break
                else:
                    db.mark_target(t["id"], "failed", error=detail)
                    db.add_log(cid, account_id, t.get("target"), "failed", detail)
                    db.bump_campaign(cid, failed=1)
                    await self._sleep(random.uniform(5, 12), ev)

        if db.count_pending(cid) == 0:
            camp_after = db.get_campaign(cid)
            if camp_after and camp_after.get("status") != "stopped":
                db.update_campaign(cid, status="finished", finished_at=db._now())

    async def _send(self, client, message: str, media, t: dict):
        text = (message or "").replace("$name", t.get("target_name") or "").replace(
            "$username", t.get("username") or "")
        candidates = []
        if t.get("target_id") and t.get("access_hash"):
            candidates.append(InputUser(t["target_id"], t["access_hash"]))
        if t.get("username"):
            candidates.append(t["username"])
        if t.get("target"):
            candidates.append(t["target"])
        if not candidates:
            return "failed", "no target info"
        last_detail = None
        for cand in candidates:
            status, detail = await self._send_try(client, cand, text, media)
            if status in ("sent", "flood"):
                return status, detail
            last_detail = detail
        return "failed", last_detail or "no target info"

    async def _send_try(self, client, candidate, text: str, media):
        for attempt in range(3):
            try:
                if not client.is_connected():
                    await client.connect()
                peer = candidate
                if isinstance(candidate, str):
                    peer = await self._resolve(client, candidate)
                await client.send_message(peer, text, file=media)
                return "sent", None
            except FloodWaitError as e:
                return "flood", e.seconds
            except (ConnectionError, OSError, TimeoutError, asyncio.TimeoutError):
                if attempt < 2:
                    await asyncio.sleep(2)
                    continue
                return "failed", "disconnected"
            except Exception as e:
                return "failed", str(e)[:220]
        return "failed", "disconnected"

    async def _resolve(self, client, target: str):
        cached = self._resolved.get(target)
        if cached:
            return cached
        try:
            peer = await client.get_input_entity(target)
            self._resolved[target] = peer
            return peer
        except (ValueError, TypeError):
            pass
        digits = "".join(c for c in target if c.isdigit())
        if digits:
            from telethon.tl.functions.contacts import ResolvePhoneRequest
            from telethon.tl.types import InputPeerUser
            try:
                res = await client(ResolvePhoneRequest("+" + digits))
            except Exception as e:
                raise ValueError(f"{target}: {str(e)[:160]}")
            users = getattr(res, "users", None) or []
            if users:
                u = users[0]
                peer = InputPeerUser(u.id, u.access_hash)
                self._resolved[target] = peer
                return peer
            peer_obj = getattr(res, "peer", None)
            if peer_obj is not None and getattr(peer_obj, "user_id", None):
                peer = InputPeerUser(peer_obj.user_id, 0)
                self._resolved[target] = peer
                return peer
        raise ValueError(f"Cannot find any entity for {target!r}")

    async def _sleep(self, secs: float, ev: asyncio.Event, chunk: float = 5):
        end = time.monotonic() + max(0, secs)
        while time.monotonic() < end:
            if ev.is_set():
                return
            await asyncio.sleep(min(chunk, max(0.2, end - time.monotonic())))

    def _check_wrap_up(self, cid: int):
        tasks = self._tasks.get(cid)
        if tasks and all(t.done() for t in tasks):
            camp = db.get_campaign(cid)
            if camp and camp.get("status") == "running":
                if db.count_pending(cid) == 0:
                    db.update_campaign(cid, status="finished", finished_at=db._now())
                else:
                    db.update_campaign(cid, status="failed", finished_at=db._now())
            self._tasks.pop(cid, None)


campaigns_manager = CampaignManager(_tg_manager)