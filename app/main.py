from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.staticfiles import StaticFiles

from . import database as db
from . import scraper as scraper_mod
from .config import STATIC_DIR
from .config import PUBLIC_REGISTER
from .models import ForgotRequest, LoginRequest, RegisterRequest
from .routes import accounts, admin, campaigns, members, scrape, validate
from .security import login as do_login
from .security import logout as do_logout
from .security import require_auth, require_owner, require_perm
from . import mail as mail_mod
from .telegram_manager import tg


@asynccontextmanager
async def lifespan(app: FastAPI):
    db.init_db()
    scraper_mod.tg = tg
    yield
    await tg.close_all()


app = FastAPI(title="TG Bulk Sender", lifespan=lifespan)


@app.post("/api/login")
async def api_login(body: LoginRequest):
    return {"token": do_login(body.username or "", body.password)}


@app.post("/api/forgot-password")
async def api_forgot_password(body: ForgotRequest):
    from . import database as db
    from .config import PASSWORD
    from .security import _hash
    import secrets
    import string
    username = (body.username or "").strip()
    if not username:
        recover = "Owner"
        password = PASSWORD
    else:
        cust = db.get_customer_by_username(username)
        if not cust:
            raise HTTPException(400, "No account found with that username")
        alphabet = string.ascii_letters + string.digits
        password = "".join(secrets.choice(alphabet) for _ in range(10))
        recover = cust["username"]
    try:
        mail_mod.send_password_email(recover, password)
    except Exception as e:
        raise HTTPException(400, str(e))
    if username:
        db.update_customer_password(cust["id"], _hash(password, username))
    return {"ok": True, "msg": "Password emailed to the configured Gmail"}


@app.post("/api/register")
async def api_register(body: RegisterRequest):
    from .security import _hash
    if not PUBLIC_REGISTER:
        raise HTTPException(403, "Registration is disabled")
    username = (body.username or "").strip()
    if len(username) < 3:
        raise HTTPException(400, "Username must be at least 3 characters")
    if not body.password or len(body.password) < 4:
        raise HTTPException(400, "Password must be at least 4 characters")
    if username.lower() in ("owner", "admin"):
        raise HTTPException(400, "This username is reserved")
    try:
        cid = db.create_customer(body.name, username, _hash(body.password, username),
                                 ["validate"])
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"ok": True, "id": cid}


@app.post("/api/logout")
async def api_logout(authorization: str = Header(None)):
    return do_logout(authorization)


@app.get("/api/auth/check")
async def auth_check(_: dict = Depends(require_auth)):
    return {"ok": True}


app.include_router(accounts.router, dependencies=[Depends(require_owner)])
app.include_router(scrape.router, dependencies=[Depends(require_perm("scrape"))])
app.include_router(members.router, dependencies=[Depends(require_perm("scrape"))])
app.include_router(campaigns.router, dependencies=[Depends(require_perm("send"))])
app.include_router(validate.router)
app.include_router(admin.router, dependencies=[Depends(require_owner)])


@app.get("/api/status")
async def status():
    import app.config as cfg
    return {"ok": True, "config_ok": cfg.config_ok()}


app.mount("/", StaticFiles(directory=str(STATIC_DIR), html=True), name="static")