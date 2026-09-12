from fastapi import APIRouter, HTTPException

from .. import database as db
from ..config import config_ok
from ..models import SendCodeRequest, VerifyRequest
from ..telegram_manager import LoginError, TwoFARequired, tg

router = APIRouter(prefix="/api/accounts", tags=["accounts"])


def _require_config():
    if not config_ok():
        raise HTTPException(
            400,
            "API credentials missing. Open config.json and set api_id / api_hash "
            "(get them from my.telegram.org), then restart the server.")


@router.get("")
async def list_accounts():
    return {"accounts": db.list_accounts()}


@router.post("/send-code")
async def send_code(body: SendCodeRequest):
    _require_config()
    try:
        account = db.find_or_create_account(body.phone)
        code_hash = await tg.send_login_code(account["id"], body.phone)
        db.set_code_hash(account["id"], code_hash)
        return {"ok": True, "account_id": account["id"]}
    except LoginError as e:
        raise HTTPException(400, str(e))


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


@router.delete("/{account_id}")
async def delete_account(account_id: int):
    account = db.get_account(account_id)
    if not account:
        raise HTTPException(404, "Account not found")
    db.logout_account(account_id)
    return {"ok": True}