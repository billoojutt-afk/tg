import hashlib
import secrets

from fastapi import Depends, Header, HTTPException

from . import database as db
from .config import PASSWORD, OWNER_USER_ID

_tokens = {}  # token -> payload dict


def _hash(secret: str, salt: str = "") -> str:
    return hashlib.sha256(f"{salt}:{secret}".encode()).hexdigest()


def _new_token(payload: dict) -> str:
    tok = secrets.token_urlsafe(32)
    _tokens[tok] = payload
    return tok


def login(username: str, password: str):
    username = (username or "").strip()
    # Owner may log in with the configured owner ID, while the legacy blank-username
    # owner login remains supported for compatibility.
    if not username or username == OWNER_USER_ID:
        if PASSWORD and password == PASSWORD:
            return _new_token({"role": "owner", "owner_user_id": OWNER_USER_ID})
        raise HTTPException(401, "Wrong owner ID or password")
    cust = db.get_customer_by_username(username)
    if not cust or cust["password"] != _hash(password, username):
        raise HTTPException(401, "Wrong username or password")
    role = cust.get("role") or "customer"
    return _new_token({"role": role, "customer_id": cust["id"]})


def _resolve(authorization) -> dict:
    if not authorization:
        raise HTTPException(401, "Not authenticated")
    token = authorization.removeprefix("Bearer ").strip()
    payload = _tokens.get(token)
    if not payload:
        raise HTTPException(401, "Not authenticated")
    return payload


def logout(authorization: str = Header(None)):
    if not authorization:
        raise HTTPException(401, "Not authenticated")
    token = authorization.removeprefix("Bearer ").strip()
    _tokens.pop(token, None)
    return {"ok": True}


def current(authorization: str = Header(None)) -> dict:
    return _resolve(authorization)


def require_auth(payload: dict = Depends(current)) -> dict:
    return payload


def require_owner(payload: dict = Depends(current)) -> dict:
    if payload.get("role") != "owner":
        raise HTTPException(403, "Owner only")
    return payload


def require_perm(perm: str):
    """Every authenticated user gets access to all services — no per-tab locking."""
    def dep(payload: dict = Depends(current)) -> dict:
        return payload
    return dep

def require_staff(payload: dict = Depends(current)) -> dict:
    """Allow only the owner or users explicitly promoted to admin."""
    if payload.get("role") not in ("owner", "admin"):
        raise HTTPException(403, "Admin access required")
    return payload
