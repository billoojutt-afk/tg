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
    data = {"api_id": 0, "api_hash": "", "password": ""}
    if CONFIG_PATH.exists():
        try:
            with open(CONFIG_PATH, "r", encoding="utf-8") as f:
                data.update(json.load(f))
        except Exception:
            pass
    for key in ("api_id", "api_hash", "password"):
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


def config_ok() -> bool:
    return bool(API_ID and API_HASH)