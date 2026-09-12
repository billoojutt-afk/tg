from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI
from fastapi.staticfiles import StaticFiles

from . import database as db
from . import scraper as scraper_mod
from .config import STATIC_DIR
from .models import LoginRequest
from .routes import accounts, campaigns, members, scrape
from .security import login as do_login
from .security import require_auth
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
    return {"token": do_login(body.password)}


@app.get("/api/auth/check")
async def auth_check(_: None = Depends(require_auth)):
    return {"ok": True}


app.include_router(accounts.router, dependencies=[Depends(require_auth)])
app.include_router(scrape.router, dependencies=[Depends(require_auth)])
app.include_router(members.router, dependencies=[Depends(require_auth)])
app.include_router(campaigns.router, dependencies=[Depends(require_auth)])


@app.get("/api/status")
async def status():
    import app.config as cfg
    return {"ok": True, "config_ok": cfg.config_ok()}


app.mount("/", StaticFiles(directory=str(STATIC_DIR), html=True), name="static")