import json
import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
DB_PATH = BASE_DIR / "app.db"
STATIC_DIR = BASE_DIR / "static"
EXPORT_DIR = BASE_DIR / "exports"
MEDIA_DIR = BASE_DIR / "media"
CONFIG_PATH = BASE_DIR / "config.json"


def _load_config() -> dict:
    data = {"api_id": 0, "api_hash": "", "password": "", "wallet": "",
            "tronscan_key": "", "public_register": True,
            "smtp_email": "", "smtp_app_password": ""}
    if CONFIG_PATH.exists():
        try:
            with open(CONFIG_PATH, "r", encoding="utf-8") as f:
                data.update(json.load(f))
        except Exception:
            pass
    for key in ("api_id", "api_hash", "password", "wallet", "tronscan_key",
                "smtp_email", "smtp_app_password"):
        env_val = os.environ.get(key.upper(), "")
        if env_val:
            data[key] = int(env_val) if key == "api_id" else env_val
    try:
        data["api_id"] = int(data.get("api_id") or 0)
    except (TypeError, ValueError):
        data["api_id"] = 0
    return data


CONFIG = _load_config()
API_ID = CONFIG["api_id"]
API_HASH = CONFIG["api_hash"]
PASSWORD = CONFIG.get("password") or ""
WALLET = (CONFIG.get("wallet") or "").strip()
TRONSCAN_KEY = (CONFIG.get("tronscan_key") or "").strip()
PUBLIC_REGISTER = bool(CONFIG.get("public_register", True))
SMTP_EMAIL = (CONFIG.get("smtp_email") or "").strip()
SMTP_APP_PASSWORD = (CONFIG.get("smtp_app_password") or "").strip()
SMTP_HOST = CONFIG.get("smtp_host") or "smtp.gmail.com"
SMTP_PORT = int(CONFIG.get("smtp_port") or 587)

# Stable ID shown for the owner and used as the owner identity in the dashboard.
# Set OWNER_USER_ID in Render environment variables (do not put it in config.json).
OWNER_USER_ID = (os.environ.get("OWNER_USER_ID") or "owner").strip()

# 1000 credits = $3 USDT (0.003 $ per credit) as default price
PRICE_PER_CREDIT = 0.003
CREDIT_PACKS = [
    {"credits": 1000, "usd": 3.0},
    {"credits": 5000, "usd": 13.5},
    {"credits": 10000, "usd": 25.0},
]

# Credits get consumed per service. Price in USD per N units.
SERVICE_PRICING = {
    "check":  {"usd": 3.0,  "per": 1000, "unit": "numbers checked",   "label": "Check numbers",  "perm": "validate"},
    "send":   {"usd": 20.0, "per": 1000, "unit": "messages sent",      "label": "Send messages",  "perm": "send"},
    "scrape": {"usd": 10.0, "per": 1000, "unit": "members scraped",    "label": "Scrape members", "perm": "scrape"},
}


def service_pricing_all() -> dict:
    """Merged pricing: DB overrides (if any) on top of defaults."""
    from . import database as _db
    over = {}
    try:
        over = {r["service"]: r for r in _db.get_pricing_overrides()}
    except Exception:
        over = {}
    out = {}
    for s, p in SERVICE_PRICING.items():
        d = over.get(s)
        out[s] = {
            "usd": float(d["usd"]) if d else float(p["usd"]),
            "per": int(d["per"]) if d else int(p["per"]),
            "unit": p["unit"],
            "label": p["label"],
            "perm": p["perm"],
        }
    return out


def credits_per_unit(service: str) -> float:
    p = service_pricing_all().get(service)
    if not p:
        return 0.0
    return round((p["usd"] / PRICE_PER_CREDIT) / p["per"], 4)


def credits_for(service: str, units: float) -> float:
    p = service_pricing_all().get(service)
    if not p or units is None or units <= 0:
        return 0.0
    return round((p["usd"] / PRICE_PER_CREDIT) * (units / p["per"]), 2)


def credits_to_usd(credits: float) -> float:
    return round(credits * PRICE_PER_CREDIT, 2)


def config_ok() -> bool:
    return bool(API_ID and API_HASH)