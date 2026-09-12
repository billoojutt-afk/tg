import secrets

from fastapi import HTTPException
from fastapi.params import Header

from .config import PASSWORD

_token = None


def login(password: str):
    global _token
    if not PASSWORD:
        return ""
    if password == PASSWORD:
        _token = secrets.token_urlsafe(32)
        return _token
    raise HTTPException(401, "Wrong password")


def require_auth(authorization: str = Header(None)):
    if not PASSWORD:
        return
    if not _token or authorization != "Bearer " + _token:
        raise HTTPException(401, "Not authenticated")