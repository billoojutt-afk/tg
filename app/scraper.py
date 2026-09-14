import asyncio

from telethon.errors import FloodWaitError

from . import database as db
from .telegram_manager import TelegramManager

tg: TelegramManager = None  # injected from main


def _fmt_user(u) -> str:
    return f"{getattr(u, 'first_name', '') or ''} {getattr(u, 'last_name', '') or ''}".strip()


async def scrape_job(job_id: int, account_id: int, group_input: str):
    account = db.get_account(account_id)
    if not account or account.get("status") != "active":
        db.update_job(job_id, status="failed", error="Account is not active")
        return
    db.update_job(job_id, status="running", error=None)
    try:
        client = await tg.get_client(account)
    except Exception as e:
        db.update_job(job_id, status="failed", error=str(e))
        return

    try:
        peer = await client.get_entity(group_input)
    except Exception as e:
        db.update_job(job_id, status="failed", error=f"Cannot resolve group: {e}")
        return

    title = getattr(peer, "title", None) or group_input
    username = getattr(peer, "username", None)
    count = 0
    try:
        async for u in client.iter_participants(peer, aggressive=True, wait_time=1):
            db.insert_member(job_id, u)
            count += 1
            if count % 10 == 0:
                db.update_job(job_id, total=count, group_title=title,
                              group_username=username)
    except FloodWaitError as e:
        db.update_job(job_id, status="failed", total=count, error=f"Flood wait {e.seconds}s")
        return
    except Exception as e:
        if count == 0:
            db.update_job(job_id, status="failed", error=f"Scrape error: {e}")
            return

    db.update_job(job_id, status="done", total=count, group_title=title,
                  group_username=username, finished_at=db._now())
    if count:
        job = db.get_job(job_id)
        cost, shortfall = db.settle_service(job.get("customer_id"), "scrape", count,
                                            ref=f"job{job_id}")
        if shortfall > 0:
            db.update_job(job_id,
                          error=f"Credit shortfall: charged {count} members, "
                                f"{int(shortfall):,} credits still owed ($"
                                f"{round(shortfall * 0.003, 2)}). Top up credits.")


def start_scrape(job_id: int, account_id: int, group_input: str):
    asyncio.create_task(scrape_job(job_id, account_id, group_input))