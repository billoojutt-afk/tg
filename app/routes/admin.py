from fastapi import APIRouter, Depends, HTTPException

from .. import database as db
from ..models import (ALL_PERMISSIONS, AddApiKeyRequest, AddCredits,
                      CreateCustomer, PermissionsUpdate, PricingUpdate,
                      SupportSettings, RoleUpdate)
from ..security import require_owner

router = APIRouter(prefix="/api/admin", tags=["admin"], dependencies=[Depends(require_owner)])

_PAGES = {
    "dashboard": "Dashboard",
    "accounts": "Accounts",
    "scrape": "Scrape",
    "send": "Send",
    "validate": "Check",
}


def _clean_perms(perms) -> list:
    seen = []
    for p in perms or []:
        p = (p or "").strip()
        if p in ALL_PERMISSIONS and p not in seen:
            seen.append(p)
    return seen or ["validate"]


@router.get("/customers")
async def customers():
    return {"customers": db.list_customers(), "pages": _PAGES}


@router.post("/customers")
async def create_customer(body: CreateCustomer):
    username = (body.username or "").strip()
    if not username:
        raise HTTPException(400, "Username is required")
    if not body.password:
        raise HTTPException(400, "Password is required")
    from ..security import _hash
    try:
        perms = _clean_perms(body.permissions)
        cid = db.create_customer(body.name, username, _hash(body.password, username), perms)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"ok": True, "id": cid, "customer": db.get_customer(cid)}


@router.patch("/customers/{cid}/permissions")
async def set_permissions(cid: int, body: PermissionsUpdate):
    if not db.get_customer(cid):
        raise HTTPException(404, "Customer not found")
    db.update_customer_permissions(cid, _clean_perms(body.permissions))
    return {"ok": True, "customer": db.get_customer(cid)}


@router.patch("/customers/{cid}/role")
async def set_role(cid: int, body: RoleUpdate):
    if body.role not in ("customer", "admin"):
        raise HTTPException(400, "Role must be customer or admin")
    cust = db.get_customer(cid)
    if not cust:
        raise HTTPException(404, "Customer not found")
    db.update_customer_role(cid, body.role)
    # Admins get the operational permissions automatically; customers retain their own permissions.
    if body.role == "admin":
        db.update_customer_permissions(cid, ALL_PERMISSIONS)
    else:
        db.update_customer_permissions(cid, ["validate"])
    return {"ok": True, "customer": db.get_customer(cid)}


@router.post("/credits")
async def add_credits(body: AddCredits):
    if not db.get_customer(body.customer_id):
        raise HTTPException(404, "Customer not found")
    if body.credits <= 0:
        raise HTTPException(400, "Credits must be positive")
    db.add_customer_credits(body.customer_id, body.credits)
    db.add_tx(body.customer_id, "admin", body.credits, 0, "", "credited")
    return {"ok": True, "customer": db.get_customer(body.customer_id)}


@router.delete("/customers/{cid}")
async def delete_customer(cid: int):
    if not db.get_customer(cid):
        raise HTTPException(404, "Customer not found")
    db.delete_customer(cid)
    return {"ok": True}


@router.get("/transactions")
async def transactions(limit: int = 100):
    return {"transactions": db.list_transactions(min(max(limit, 1), 1000))}


@router.get("/checks")
async def checks(limit: int = 200):
    cust_map = {c["id"]: c for c in db.list_customers()}
    lst = db.list_checks(None, min(max(limit, 1), 1000))
    for ch in lst:
        c = cust_map.get(ch.get("customer_id"))
        ch["customer_name"] = (c or {}).get("name") or ""
        ch["customer_username"] = (c or {}).get("username") or ""
        regs = sum(1 for r in ch.get("results") or [] if r.get("registered"))
        ch["found"] = regs
    return {"checks": lst}


@router.get("/api-keys")
async def get_api_keys():
    return {"api_keys": db.list_api_keys()}


@router.post("/api-keys")
async def add_api_key(body: AddApiKeyRequest):
    if not body.api_id or not (body.api_hash or "").strip():
        raise HTTPException(400, "api_id and api_hash are required")
    kid = db.add_api_key(body.api_id, body.api_hash, body.label)
    return {"ok": True, "key": db.get_api_key(kid)}


@router.delete("/api-keys/{key_id}")
async def del_api_key(key_id: int):
    if not db.get_api_key(key_id):
        raise HTTPException(404, "API key not found")
    db.delete_api_key(key_id)
    return {"ok": True}


@router.post("/api-keys/{key_id}/unlimit")
async def unlimit_api_key(key_id: int):
    if not db.get_api_key(key_id):
        raise HTTPException(404, "API key not found")
    db.set_api_key_limited(key_id, False)
    return {"ok": True}


@router.get("/pricing")
async def get_pricing():
    from ..config import service_pricing_all
    return {"pricing": service_pricing_all()}


@router.put("/pricing/{service}")
async def update_pricing(service: str, body: PricingUpdate):
    from ..config import service_pricing_all
    if service not in service_pricing_all():
        raise HTTPException(404, "Unknown service")
    if body.usd <= 0 or body.per <= 0:
        raise HTTPException(400, "Price and volume must be positive")
    db.set_pricing(service, body.usd, body.per)
    return {"ok": True, "pricing": service_pricing_all()}


@router.delete("/pricing/{service}")
async def reset_pricing(service: str):
    from ..config import service_pricing_all
    if service not in service_pricing_all():
        raise HTTPException(404, "Unknown service")
    db.reset_pricing(service)
    return {"ok": True, "pricing": service_pricing_all()}


@router.get("/settings")
async def get_settings():
    return {"settings": {"support_bot": db.get_setting("support_bot")}}


@router.put("/settings/support")
async def set_support(body: SupportSettings, RoleUpdate):
    username = (body.username or "").strip().lstrip("@")
    db.set_setting("support_bot", username)
    return {"ok": True, "settings": {"support_bot": db.get_setting("support_bot")}}