import asyncio
import json
import uuid

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse

from .. import database as db
from ..config import (CREDIT_PACKS, PRICE_PER_CREDIT, WALLET,
                      credits_for, credits_per_unit, credits_to_usd,
                      service_pricing_all)
from ..crypto import _addr_to_hex, verify_tx
from ..models import PayRequest, ValidateRequest
from ..security import require_auth, require_perm
from ..telegram_manager import tg
from telethon.tl.functions.contacts import (
    ImportContactsRequest,
    ResolvePhoneRequest,
)
from telethon.tl.types import (
    InputPeerUser,
    InputPhoneContact,
    UserStatusEmpty,
    UserStatusLastMonth,
    UserStatusLastWeek,
    UserStatusOffline,
    UserStatusOnline,
    UserStatusRecently,
)

router = APIRouter(prefix="/api", tags=["validate"])


def _fmt_status(st):
    if isinstance(st, UserStatusOnline):
        return "Online now", True
    if isinstance(st, UserStatusOffline):
        ts = getattr(st, "was_online", None)
        if ts:
            return "Last seen " + ts.strftime("%Y-%m-%d %H:%M"), False
        return "Offline", False
    if isinstance(st, UserStatusRecently):
        return "Recently (exact hidden by user)", False
    if isinstance(st, UserStatusLastWeek):
        return "Last week", False
    if isinstance(st, UserStatusLastMonth):
        return "Last month", False
    if isinstance(st, UserStatusEmpty):
        return "Hidden", False
    return "Unknown", False


async def _check(client, num: str) -> dict:
    digits = "".join(c for c in num if c.isdigit())
    if not digits:
        return {"number": num, "registered": False, "error": "Invalid number"}
    try:
        rp = await client(ResolvePhoneRequest("+" + digits))
    except Exception as e:
        return {"number": num, "registered": False, "error": str(e)[:160]}
    users = getattr(rp, "users", None) or []
    if not users:
        peer = getattr(rp, "peer", None)
        if peer is not None and getattr(peer, "user_id", None):
            return {"number": num, "registered": True,
                    "user_id": peer.user_id, "last_seen": "Unknown"}
        return {"number": num, "registered": True, "last_seen": "Unknown"}
    u = users[0]
    try:
        cid_val = int(uuid.uuid4().int % (2 ** 63))
        await client(ImportContactsRequest([
            InputPhoneContact(client_id=cid_val, phone="+" + digits,
                              first_name=getattr(u, "first_name", "") or "",
                              last_name=getattr(u, "last_name", "") or "")
        ]))
    except Exception:
        pass
    status_text, online = None, False
    try:
        ent = await client.get_entity(InputPeerUser(u.id, u.access_hash or 0))
        status_text, online = _fmt_status(getattr(ent, "status", None))
    except Exception:
        pass
    return {
        "number": num,
        "registered": True,
        "user_id": getattr(u, "id", None),
        "first_name": getattr(u, "first_name", None),
        "last_name": getattr(u, "last_name", None),
        "username": getattr(u, "username", None),
        "online": online,
        "last_seen": status_text,
    }


def _norm_targets(lines) -> list:
    out = []
    for l in (lines or []):
        l = str(l).strip().lstrip("@")
        if not l:
            continue
        clean = l.replace(" ", "").replace("-", "").replace("+", "")
        if clean.isdigit() and not l.startswith("+"):
            digits = "".join(c for c in l if c.isdigit())
            if digits:
                l = "+" + digits
        out.append(l)
    return out


_SPAM_KEYS = ("spam", "non-contacts", "user restricted", "account is limited")
_DEAD_KEYS = ("auth key unregistered", "session revoked", "session invalid",
              "unauthorized", "unregistered")


def _flag_account(account_id: int, err):
    txt = str(err or "").lower()
    if not txt:
        return
    try:
        if any(k in txt for k in _DEAD_KEYS):
            db.logout_account(account_id)
        elif any(k in txt for k in _SPAM_KEYS):
            db.set_account_spam(account_id)
    except Exception:
        pass


def _account_order(selected_id: int) -> list:
    """Selected account first, then other healthy accounts, then spam-flagged ones."""
    accs = db.active_accounts()
    accs = [a for a in accs if a.get("session_string")]
    accs.sort(key=lambda a: (1 if a.get("spam_limited") else 0,
                             0 if a["id"] == selected_id else 1,
                             a["id"]))
    return accs


@router.post("/validate")
async def validate_numbers(body: ValidateRequest, user: dict = Depends(require_perm("validate"))):
    account = None
    if body.account_id:
        account = db.get_account(body.account_id)
        if not account or account.get("status") != "active":
            raise HTTPException(400, "Account is not active")
    nums = _norm_targets(body.numbers)
    if not nums:
        raise HTTPException(400, "Add at least one number")

    cost = credits_for("check", len(nums))
    if user.get("role") == "customer":
        balance_after = db.deduct_customer_credits(user["customer_id"], cost)
        if balance_after < 0:
            raise HTTPException(400,
                                "Not enough credits. Buy credits to run checks.")
    else:
        balance_after = None

    accounts = _account_order(account["id"] if account else 0)
    if not accounts:
        if balance_after is not None:
            db.add_customer_credits(user["customer_id"], cost)
        raise HTTPException(400, "No active accounts available for checking")

    async def gen():
        clients = {}
        results = []
        try:
            for num in nums:
                found = None
                attempts = []
                for acc in accounts:
                    client = clients.get(acc["id"])
                    if client is None:
                        try:
                            client = await tg.get_client(acc)
                        except Exception as e:
                            _flag_account(acc["id"], e)
                            attempts.append({"account_id": acc["id"],
                                             "error": f"{type(e).__name__}: {str(e)[:140]}"})
                            continue
                        clients[acc["id"]] = client
                    try:
                        r = await _check(client, num)
                    except Exception as e:
                        _flag_account(acc["id"], e)
                        attempts.append({"account_id": acc["id"],
                                         "error": f"{type(e).__name__}: {str(e)[:140]}"})
                        continue
                    if r.get("registered"):
                        r["checked_by"] = acc["id"]
                        found = r
                        break
                    _flag_account(acc["id"], r.get("error"))
                    attempts.append({"account_id": acc["id"],
                                     "error": r.get("error") or "not on Telegram"})
                    await asyncio.sleep(0.6)
                if found is not None:
                    results.append(found)
                else:
                    results.append({
                        "number": num,
                        "registered": False,
                        "error": f"Not found on any of {len(accounts)} account(s)",
                        "attempts": attempts,
                    })
                yield json.dumps({
                    "type": "result",
                    "result": results[-1],
                }) + "\n"
                await asyncio.sleep(1.2)

            if user.get("role") == "customer" and results:
                db.add_check(user["customer_id"], (account or accounts[0])["id"],
                             nums, results, cost)
            yield json.dumps({
                "type": "done",
                "results": results,
                "balance_after": balance_after,
            }) + "\n"
        finally:
            if user.get("role") == "customer" and len(results) < len(nums):
                unused = cost - credits_for("check", len(results))
                if unused > 0:
                    db.add_customer_credits(user["customer_id"], unused)

    return StreamingResponse(gen(), media_type="application/x-ndjson")


@router.get("/checks/mine")
async def my_checks(user: dict = Depends(require_auth)):
    if user.get("role") != "customer":
        return {"checks": []}
    return {"checks": db.list_checks(user["customer_id"], 200)}


@router.get("/transactions/mine")
async def my_transactions(user: dict = Depends(require_auth)):
    if user.get("role") != "customer":
        raise HTTPException(403, "Owner only")
    return {"transactions": db.list_transactions_for_customer(user["customer_id"], 200)}


@router.get("/accounts/public")
async def public_accounts(_: dict = Depends(require_perm("validate"))):
    accs = db.active_accounts()
    return {"accounts": [
        {"id": a["id"], "phone": a.get("phone") or "", "username": a.get("username") or ""}
        for a in accs]}


@router.get("/support")
async def support():
    return {"username": db.get_setting("support_bot")}


@router.get("/me")
async def me(user: dict = Depends(require_auth)):
    if user.get("role") != "customer":
        return {"role": "owner", "name": "Owner", "id": None}
    cust = db.get_customer(user["customer_id"])
    if not cust:
        raise HTTPException(404, "Customer not found")
    return {
        "role": "customer",
        "id": cust["id"],
        "name": cust["name"],
        "username": cust["username"],
        "credits": cust["credits"],
        "permissions": cust.get("permissions") or [],
    }


@router.get("/shop")
async def shop():
    pricing = [{
        "service": s,
        "label": p["label"],
        "unit": p["unit"],
        "per": p["per"],
        "usd": p["usd"],
        "perm": p["perm"],
        "credits_per_unit": credits_per_unit(s),
        "credits_for_per": credits_for(s, p["per"]),
    } for s, p in service_pricing_all().items()]
    return {
        "wallet": WALLET or "",
        "wallet_configured": bool(WALLET),
        "packs": CREDIT_PACKS,
        "price_per_credit": PRICE_PER_CREDIT,
        "pricing": pricing,
    }


@router.post("/pay")
async def pay(body: PayRequest, user: dict = Depends(require_auth)):
    if user.get("role") != "customer":
        raise HTTPException(403, "Only customers can buy credits")
    txid = (body.txid or "").strip()
    if not txid:
        raise HTTPException(400, "Enter the transaction hash (TXID)")
    if db.tx_exists(txid):
        raise HTTPException(400, "This TXID was already used")
    try:
        usdt = verify_tx(txid)
    except Exception as e:
        raise HTTPException(400, f"Could not verify payment: {e}")
    if not usdt or usdt <= 0:
        raise HTTPException(400,
                            "Payment not found / not confirmed yet. "
                            "Double-check the TXID and that the coins reached the wallet.")
    credits = int(round(usdt / PRICE_PER_CREDIT))
    if credits <= 0:
        raise HTTPException(400, "Amount too small to add credits")
    db.add_customer_credits(user["customer_id"], credits)
    db.add_tx(user["customer_id"], "buy", credits, usdt, txid, "credited")
    cust = db.get_customer(user["customer_id"])
    return {"ok": True, "credits_added": credits, "credits": cust["credits"]}