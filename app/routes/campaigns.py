import json
import uuid

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile

from .. import database as db
from ..config import MEDIA_DIR, credits_for, credits_to_usd
from ..models import DelayUpdate
from ..security import require_perm
from ..sender import campaigns_manager

router = APIRouter(prefix="/api/campaigns", tags=["campaigns"])


def _bool(val: str) -> bool:
    return str(val).lower() in ("1", "true", "on")


async def _save_media(media: UploadFile) -> str:
    ext = (media.filename or "").rsplit(".", 1)[-1] if "." in (media.filename or "") else ""
    fname = f"media_{uuid.uuid4().hex[:10]}.{ext}" if ext else f"media_{uuid.uuid4().hex[:10]}"
    path = MEDIA_DIR / fname
    with open(path, "wb") as f:
        while chunk := await media.read(1 << 20):
            f.write(chunk)
    return str(path)


@router.post("")
async def create_campaign(
    name: str = Form("Campaign"),
    account_ids: str = Form(...),
    job_id: int = Form(None),
    custom_targets: str = Form(""),
    has_username: str = Form(""),
    has_phone: str = Form(""),
    exclude_bots: str = Form(""),
    search: str = Form(""),
    message: str = Form(""),
    min_delay: float = Form(30),
    max_delay: float = Form(90),
    max_per_account: int = Form(0),
    media: UploadFile | None = File(None),
    user: dict = Depends(require_perm("send")),
):
    ids = [int(x) for x in account_ids.split(",") if x.strip()]
    if not ids:
        raise HTTPException(400, "Select at least one account")
    accounts = [a for a in db.accounts_by_ids(ids) if a.get("status") == "active"]
    if not accounts:
        raise HTTPException(400, "No active accounts selected")

    filters = {
        "job_id": job_id,
        "has_username": _bool(has_username),
        "has_phone": _bool(has_phone),
        "exclude_bots": _bool(exclude_bots),
        "search": search or "",
    }
    members = []
    custom = []
    for l in (custom_targets or "").splitlines():
        l = l.strip().lstrip("@")
        if not l:
            continue
        clean = l.replace(" ", "").replace("-", "").replace("+", "")
        if clean.isdigit() and not l.startswith("+"):
            digits = "".join(c for c in l if c.isdigit())
            if digits:
                l = "+" + digits
        custom.append(l)
    if custom:
        members = None
    elif job_id:
        if not db.get_job(job_id):
            raise HTTPException(404, "Scrape job not found")
        members = db.all_members(job_id, filters)
    else:
        raise HTTPException(400, "Choose a scrape job or paste custom targets")

    n = len(members) if members is not None else len(custom)
    if n == 0:
        raise HTTPException(400, "No targets found with the current filters")

    media_path = None
    if media and media.filename:
        media_path = await _save_media(media)

    cid = db.create_campaign(name, ids, job_id, filters, message, media_path,
                             min_delay, max_delay, max_per_account,
                             user.get("customer_id") if user.get("role") == "customer" else None)
    n_acc = len(accounts)
    if members is not None:
        for i, m in enumerate(members):
            target = m.get("username") or m.get("phone") or f"id{m.get('user_id')}"
            db.add_campaign_target(cid, m.get("id"), accounts[i % n_acc]["id"], target,
                                   m.get("user_id"), m.get("access_hash"),
                                   m.get("username"),
                                   f"{m.get('first_name') or ''} {m.get('last_name') or ''}".strip())
    else:
        for i, line in enumerate(custom):
            is_username = not (line.isdigit() or line.replace("+", "").isdigit())
            db.add_campaign_target(cid, None, accounts[i % n_acc]["id"],
                                   line, None, None, line if is_username else None, None)
    db.set_campaign_total(cid, n)
    campaign = db.get_campaign(cid)
    campaign["target_counts"] = db.target_status_counts(cid)
    return {"ok": True, "campaign": campaign}


@router.post("/{cid}/start")
async def start_campaign(cid: int, user: dict = Depends(require_perm("send"))):
    camp = db.get_campaign(cid)
    if not camp:
        raise HTTPException(404, "Campaign not found")
    if user.get("role") == "customer":
        if camp.get("customer_id") != user["customer_id"]:
            raise HTTPException(403, "You can only start your own campaigns")
        cost = credits_for("send", camp.get("total") or 0)
        if cost > 0:
            charged = db.deduct_customer_credits(user["customer_id"], cost)
            if charged < 0:
                ball = db.get_customer(user["customer_id"])
                have = (ball or {}).get("credits") or 0
                raise HTTPException(400,
                    f"Insufficient credits: every {int(float(cost)):,} send costs "
                    f"{int(cost):,} credits (${credits_to_usd(cost):.2f}). Balance: "
                    f"{int(have):,}. Deposit USDT in Settings.")
            db.add_tx(user["customer_id"], "send", -cost, credits_to_usd(cost),
                      f"campaign{cid}", "ok")
    try:
        await campaigns_manager.start(cid)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"ok": True, "campaign": db.get_campaign(cid)}


@router.post("/{cid}/stop")
async def stop_campaign(cid: int, user: dict = Depends(require_perm("send"))):
    camp = db.get_campaign(cid)
    if not camp:
        raise HTTPException(404, "Campaign not found")
    if user.get("role") == "customer" and camp.get("customer_id") != user["customer_id"]:
        raise HTTPException(403, "You can only stop your own campaigns")
    await campaigns_manager.stop(cid)
    return {"ok": True, "campaign": db.get_campaign(cid)}


@router.get("")
async def list_campaigns(user: dict = Depends(require_perm("send"))):
    camps = db.list_campaigns()
    out = []
    for c in camps:
        if user.get("role") == "customer" and c.get("customer_id") != user["customer_id"]:
            continue
        c["target_counts"] = db.target_status_counts(c["id"])
        out.append(c)
    return {"campaigns": out}


@router.get("/{cid}")
async def get_campaign(cid: int, user: dict = Depends(require_perm("send"))):
    camp = db.get_campaign(cid)
    if not camp:
        raise HTTPException(404, "Campaign not found")
    if user.get("role") == "customer" and camp.get("customer_id") != user["customer_id"]:
        raise HTTPException(403, "Not your campaign")
    try:
        camp["account_ids"] = [int(x) for x in (camp["account_ids"] or "").split(",") if x]
    except Exception:
        pass
    camp["target_counts"] = db.target_status_counts(cid)
    camp["running"] = campaigns_manager.is_running(cid)
    return {"campaign": camp}


@router.get("/{cid}/logs")
async def campaign_logs(cid: int, limit: int = 200,
                        user: dict = Depends(require_perm("send"))):
    camp = db.get_campaign(cid)
    if not camp:
        raise HTTPException(404, "Campaign not found")
    if user.get("role") == "customer" and camp.get("customer_id") != user["customer_id"]:
        raise HTTPException(403, "Not your campaign")
    return {"logs": db.get_logs(cid, min(max(limit, 1), 1000))}


@router.patch("/{cid}/delay")
async def update_delay(cid: int, body: DelayUpdate,
                       user: dict = Depends(require_perm("send"))):
    camp = db.get_campaign(cid)
    if not camp:
        raise HTTPException(404, "Campaign not found")
    if user.get("role") == "customer" and camp.get("customer_id") != user["customer_id"]:
        raise HTTPException(403, "Not your campaign")
    if body.min_delay <= 0 or body.max_delay < body.min_delay or body.max_delay > 43200:
        raise HTTPException(400, "Invalid delay range (1-43200s, min <= max)")
    db.update_campaign(cid, min_delay=round(body.min_delay, 1),
                       max_delay=round(body.max_delay, 1))
    return {"ok": True, "campaign": db.get_campaign(cid)}


@router.delete("/{cid}")
async def delete_campaign(cid: int, user: dict = Depends(require_perm("send"))):
    camp = db.get_campaign(cid)
    if not camp:
        raise HTTPException(404, "Campaign not found")
    if user.get("role") == "customer" and camp.get("customer_id") != user["customer_id"]:
        raise HTTPException(403, "Not your campaign")
    if campaigns_manager.is_running(cid):
        await campaigns_manager.stop(cid)
    db.delete_campaign(cid)
    return {"ok": True}