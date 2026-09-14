from fastapi import APIRouter, HTTPException

from .. import database as db
from ..models import SendCodeRequest, VerifyRequest, SetApiKeyRequest
from ..telegram_manager import (LoginError, TwoFARequired,
                                api_creds_available, resolve_api_creds, tg)

router = APIRouter(prefix="/api/accounts", tags=["accounts"])


def _require_config():
    if not api_creds_available():
        raise HTTPException(
            400,
            "API credentials missing. Add an API key below or set api_id / api_hash in "
            "config.json, then restart the server.")


@router.get("")
async def list_accounts():
    keys = {k["id"]: k for k in db.list_api_keys()}
    accs = db.list_accounts()
    for a in accs:
        k = keys.get(a.get("api_key_id")) or {}
        a["api_label"] = k.get("label") or ""
        a["api_limited"] = bool(k.get("limited"))
    return {"accounts": accs}


@router.get("/api-keys")
async def list_api_key_options():
    keys = db.list_api_keys()
    return {"api_keys": [{"id": k["id"], "api_id": k["api_id"], "label": k["label"]}
                         for k in keys], "config_set": bool(api_creds_available())}


@router.post("/send-code")
async def send_code(body: SendCodeRequest):
    _require_config()
    try:
        account = db.find_or_create_account(body.phone)
        api_id, api_hash = resolve_api_creds(account.get("api_key_id"))
        code_hash = await tg.send_login_code(account["id"], body.phone, api_id, api_hash)
        db.set_code_hash(account["id"], code_hash)
        return {"ok": True, "account_id": account["id"]}
    except LoginError as e:
        raise HTTPException(400, str(e))


@router.patch("/{account_id}/api-key")
async def set_account_api(account_id: int, body: SetApiKeyRequest):
    account = db.get_account(account_id)
    if not account:
        raise HTTPException(404, "Account not found")
    if body.api_key_id is not None and not db.get_api_key(body.api_key_id):
        raise HTTPException(404, "API key not found")
    db.set_account_api_key(account_id, body.api_key_id)
    return {"ok": True, "account": db.get_account(account_id)}


@router.post("/verify")
async def verify(body: VerifyRequest):
    account = db.get_account(body.account_id)
    if not account:
        raise HTTPException(404, "Account not found")
    try:
        await tg.verify_code(body.account_id, account.get("phone"), body.code,
                             body.password, account.get("phone_code_hash") or "")
    except TwoFARequired:
        return {"need_password": True}
    except LoginError as e:
        raise HTTPException(400, str(e))
    return {"ok": True, "account": db.get_account(body.account_id)}


@router.post("/{account_id}/unflag")
async def unflag_account(account_id: int):
    account = db.get_account(account_id)
    if not account:
        raise HTTPException(404, "Account not found")
    db.set_account_spam(account_id, False)
    return {"ok": True, "account": db.get_account(account_id)}


@router.delete("/{account_id}")
async def delete_account(account_id: int):
    account = db.get_account(account_id)
    if not account:
        raise HTTPException(404, "Account not found")
    db.logout_account(account_id)
    return {"ok": True}