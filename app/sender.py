import asyncio
import json
import random
import time

from telethon.errors import AuthKeyUnregisteredError, FloodWaitError, UnauthorizedError
from telethon.tl.types import InputUser

from . import database as db
from .telegram_manager import TelegramManager, tg as _tg_manager

FLOOD_FAILOVER_SECONDS = 600


def _is_spam_error(ex) -> bool:
    msg = str(ex).lower()
    return any(k in msg for k in ("spam", "non-contacts", "user restricted",
                                  "account is limited"))


def _is_dead_session(ex) -> bool:
    low = str(ex).lower()
    return isinstance(ex, (AuthKeyUnregisteredError, UnauthorizedError)) or any(
        k in low for k in ("auth key unregistered", "unregistered",
                           "session revoked", "session invalid", "unauthorized"))


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
        accounts = self._usable_accounts(cid)
        if not accounts:
            raise ValueError("All selected accounts are blocked/spam-limited. "
                             "Clear spam flags or add fresh accounts.")
        ev = self._ev(cid)
        ev.clear()
        db.update_campaign(cid, status="running", started_at=db._now())
        self._tasks[cid] = [asyncio.create_task(self._run(cid, accounts))]

    async def stop(self, cid: int):
        self._ev(cid).set()
        for t in self._tasks.pop(cid, []) or []:
            t.cancel()
        db.update_campaign(cid, status="stopped", finished_at=db._now())

    async def _run(self, cid: int, accounts: list):
        try:
            await self._run_inner(cid, accounts)
        finally:
            self._check_wrap_up(cid)

    def _usable_accounts(self, cid: int) -> list:
        camp = db.get_campaign(cid)
        if not camp:
            return []
        ids = [int(x) for x in (camp["account_ids"] or "").split(",") if x]
        accs = {a["id"]: a for a in db.accounts_by_ids(ids)}
        return [accs[a] for a in ids
                if a in accs and accs[a].get("status") == "active"
                and not accs[a].get("spam_limited")]

    async def _drop_account(self, cid: int, account: dict, reason: str):
        """Mark an account as unusable (spam/revoked/huge flood) and stop using it."""
        db.set_account_spam(account["id"])
        if account.get("api_key_id"):
            try:
                db.set_api_key_limited(account["api_key_id"], True)
            except Exception:
                pass
        who = f"{account.get('name') or 'account'} ({account.get('phone') or account['id']})"
        db.add_log(cid, account["id"], "-", "failed",
                   f"[{who}] {reason}. Stopped using this account.")

    async def _run_inner(self, cid: int, accounts: list):
        camp = db.get_campaign(cid)
        if not camp:
            return
        ev = self._ev(cid)
        message = camp.get("message") or ""
        media = camp.get("media") or None
        # Respect explicit campaign min/max delay. Media campaigns get a
        # conservative 30-60s floor so "Too many requests" is avoided.
        min_delay = max(1.0, float(camp.get("min_delay") or 30))
        max_delay = max(min_delay, float(camp.get("max_delay") or 90))
        if media:
            min_delay = max(min_delay, 30.0)
            max_delay = max(max_delay, 60.0)
        max_p = int(camp.get("max_per_account") or 0)
        client_cache = {}
        dropped = set()
        # Per-account cooldown (in-memory, only for this run/campaign):
        # account_id -> absolute expiry using time.monotonic(). An account in
        # cooldown is skipped in the rotation until its expiry passes.
        cooldowns = {}
        sent_total = 0

        while not ev.is_set():
            rotation = [a for a in accounts if a["id"] not in dropped]
            if not rotation:
                db.add_log(cid, None, "-", "failed",
                           "All accounts were blocked/dropped. Remaining targets failed.")
                break
            if max_p and sent_total >= max_p:
                break
            # If every usable account is cooling down, wait for the earliest
            # cooldown to expire instead of hammering Telegram with requests.
            now_ts = time.monotonic()
            cooling = [cooldowns[a["id"]] for a in rotation
                       if cooldowns.get(a["id"], 0) > now_ts]
            if len(cooling) == len(rotation):
                wait = min(max(1.0, min(cooling) - now_ts), 120.0)
                db.add_log(cid, None, "-", "flood_wait",
                           f"all accounts cooling down, waiting {int(wait)}s")
                await self._sleep(wait, ev)
                if ev.is_set():
                    break
                continue
            targets = db.get_next_pending(cid, 25)
            if not targets:
                break
            for t in targets:
                if ev.is_set() or (max_p and sent_total >= max_p):
                    break
                db.mark_target(t["id"], "sending")
                start_idx = 0
                for i, acc in enumerate(rotation):
                    if acc["id"] == t.get("account_id"):
                        start_idx = i
                        break
                order = rotation[start_idx:] + rotation[:start_idx]
                ok = False
                last_detail = ""
                flood_seen = False
                tried = 0

                for acc in order:
                    aid = acc["id"]
                    if ev.is_set():
                        break
                    # Skip accounts still cooling down (never hammer them).
                    if cooldowns.get(aid, 0) > time.monotonic():
                        continue
                    client = client_cache.get(aid)
                    if client is None:
                        try:
                            client = await self.tg.get_client(acc)
                            client_cache[aid] = client
                        except Exception as e:
                            db.add_log(cid, aid, t.get("target"), "failed",
                                       f"account error: {str(e)[:200]}")
                            continue
                    tried += 1
                    status, detail = await self._send(client, message, media, t)
                    if status == "sent":
                        db.mark_target(t["id"], "sent")
                        db.add_log(cid, aid, t.get("target"), "sent")
                        db.bump_campaign(cid, sent=1)
                        sent_total += 1
                        ok = True
                        break
                    if status == "flood":
                        flood_seen = True
                        fsec = float(detail or 0)
                        if fsec >= FLOOD_FAILOVER_SECONDS:
                            db.add_log(cid, aid, t.get("target"), "flood_wait",
                                       f"flood {int(fsec)}s (dropping)")
                            await self._drop_account(
                                cid, acc, f"flood wait {int(fsec)}s (too long to wait)")
                            dropped.add(aid)
                        else:
                            # Exact Telegram-provided wait -> cooldown this account.
                            cooldowns[aid] = time.monotonic() + fsec
                            db.add_log(cid, aid, t.get("target"), "flood_wait",
                                       f"flood {int(fsec)}s (cooldown)")
                        continue
                    if status == "spam":
                        db.add_log(cid, aid, t.get("target"), "failed",
                                   (detail or "spam-limited")[:200])
                        await self._drop_account(
                            cid, acc, detail or "Account is spam-limited. Check @SpamBot")
                        dropped.add(aid)
                        continue
                    if status == "dead":
                        db.add_log(cid, aid, t.get("target"), "failed",
                                   f"session revoked: {(detail or '').strip()[:180]}")
                        db.logout_account(aid)
                        await self._drop_account(
                            cid, acc, "session was revoked / kicked (re-login needed)")
                        dropped.add(aid)
                        continue
                    db.add_log(cid, aid, t.get("target"), "skipped",
                               (detail or "")[:200])
                    last_detail = detail or last_detail

                if ev.is_set():
                    db.mark_target(t["id"], "pending")
                    break
                if not ok:
                    if tried and flood_seen and not last_detail:
                        # Every usable account only called flood (no hard error):
                        # keep the target pending and let cooldowns manage the wait.
                        db.mark_target(t["id"], "pending")
                        continue
                    if tried == 0:
                        # Nothing could even be attempted (all cooling); retry later.
                        db.mark_target(t["id"], "pending")
                        continue
                    db.mark_target(t["id"], "failed",
                                   error=last_detail or "all accounts failed")
                    db.bump_campaign(cid, failed=1)
                    db.add_log(cid, None, t.get("target"), "failed",
                               f"all {tried} account(s) failed")
                else:
                    # Read delays fresh each send so the operator can change
                    # the speed while a campaign is already running.
                    camp_now = db.get_campaign(cid) or camp
                    dm = max(1.0, float(camp_now.get("min_delay") or 30))
                    dx = max(dm, float(camp_now.get("max_delay") or 90))
                    if media:
                        dm = max(dm, 30.0)
                        dx = max(dx, 60.0)
                    await self._sleep(random.uniform(dm, dx), ev)

        for client in client_cache.values():
            try:
                await client.disconnect()
            except Exception:
                pass

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
            if status in ("sent", "flood", "spam", "dead"):
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
                secs = float(getattr(e, "seconds", 0) or 0)
                try:
                    if secs <= 0 and "seconds" in str(e):
                        secs = 60.0
                except Exception:
                    pass
                return "flood", secs if secs > 0 else 60.0
            except (ConnectionError, OSError, TimeoutError, asyncio.TimeoutError):
                if attempt < 2:
                    await asyncio.sleep(2)
                    continue
                return "failed", "disconnected"
            except Exception as e:
                if _is_dead_session(e):
                    return "dead", str(e)[:220]
                if _is_spam_error(e):
                    return "spam", str(e)[:220]
                msg = str(e).lower()
                if "too many requests" in msg or "flood_wait" in msg:
                    secs = float(getattr(e, "seconds", 0) or 0)
                    return "flood", secs if secs > 0 else 60.0
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