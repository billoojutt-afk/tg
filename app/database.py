import os
import sqlite3
import uuid
from contextlib import closing
from datetime import datetime
from threading import Lock

from .config import DB_PATH, EXPORT_DIR, MEDIA_DIR

_lock = Lock()

_SCHEMA = """
CREATE TABLE IF NOT EXISTS accounts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    phone       TEXT UNIQUE,
    username    TEXT,
    name        TEXT,
    session_string TEXT,
    phone_code_hash TEXT,
    status      TEXT DEFAULT 'new',
    created_at  TEXT
);

CREATE TABLE IF NOT EXISTS jobs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id  INTEGER,
    group_input TEXT,
    group_title TEXT,
    group_username TEXT,
    status      TEXT DEFAULT 'pending',
    total       INTEGER DEFAULT 0,
    error       TEXT,
    created_at  TEXT,
    finished_at TEXT
);

CREATE TABLE IF NOT EXISTS members (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id      INTEGER,
    user_id     INTEGER,
    access_hash INTEGER,
    username    TEXT,
    first_name  TEXT,
    last_name   TEXT,
    phone       TEXT,
    is_bot      INTEGER DEFAULT 0,
    is_verified INTEGER DEFAULT 0,
    is_premium  INTEGER DEFAULT 0,
    created_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_members_job ON members(job_id);
CREATE INDEX IF NOT EXISTS idx_members_username ON members(username);
CREATE INDEX IF NOT EXISTS idx_members_phone ON members(phone);

CREATE TABLE IF NOT EXISTS campaigns (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT,
    account_ids TEXT,
    job_id      INTEGER,
    filters     TEXT,
    message     TEXT,
    media       TEXT,
    min_delay   REAL DEFAULT 30,
    max_delay   REAL DEFAULT 90,
    max_per_account INTEGER DEFAULT 0,
    status      TEXT DEFAULT 'created',
    total       INTEGER DEFAULT 0,
    sent        INTEGER DEFAULT 0,
    failed      INTEGER DEFAULT 0,
    created_at  TEXT,
    started_at  TEXT,
    finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_campaigns_status ON campaigns(status);

CREATE TABLE IF NOT EXISTS campaign_targets (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id INTEGER,
    member_id   INTEGER,
    account_id  INTEGER,
    target      TEXT,
    target_id   INTEGER,
    access_hash INTEGER,
    username    TEXT,
    target_name TEXT,
    status      TEXT DEFAULT 'pending',
    error       TEXT,
    sent_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_ct_campaign ON campaign_targets(campaign_id);
CREATE INDEX IF NOT EXISTS idx_ct_status ON campaign_targets(status);
CREATE INDEX IF NOT EXISTS idx_ct_account ON campaign_targets(account_id);

CREATE TABLE IF NOT EXISTS campaign_logs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id INTEGER,
    account_id  INTEGER,
    target      TEXT,
    status      TEXT,
    error       TEXT,
    sent_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_logs_campaign ON campaign_logs(campaign_id);
"""


def _now() -> str:
    return datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")


def _conn() -> sqlite3.Connection:
    conn = sqlite3.connect(str(DB_PATH), timeout=60, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def init_db():
    with _lock, closing(_conn()) as conn:
        conn.executescript(_SCHEMA)
        conn.commit()
    for d in (EXPORT_DIR, MEDIA_DIR):
        os.makedirs(d, exist_ok=True)


def _r(row) -> dict:
    return dict(row) if row is not None else None


# ---------------- accounts ----------------

def find_or_create_account(phone: str) -> dict:
    with _lock, closing(_conn()) as conn:
        row = conn.execute("SELECT id FROM accounts WHERE phone=?", (phone,)).fetchone()
        if row:
            conn.execute("UPDATE accounts SET status='new', phone_code_hash=NULL WHERE id=?",
                         (row["id"],))
            conn.commit()
            return _r(row)
        cur = conn.execute("INSERT INTO accounts (phone, status, created_at) VALUES (?,?,?)",
                           (phone, "new", _now()))
        conn.commit()
        return {"id": cur.lastrowid}


def set_code_hash(account_id: int, code_hash: str):
    with _lock, closing(_conn()) as conn:
        conn.execute(
            "UPDATE accounts SET phone_code_hash=?, status='waiting_code' WHERE id=?",
            (code_hash, account_id))
        conn.commit()


def login_account(account_id: int, username, name: str, session_string: str):
    with _lock, closing(_conn()) as conn:
        conn.execute(
            "UPDATE accounts SET username=?, name=?, session_string=?, status='active' "
            "WHERE id=?",
            (username, name, session_string, account_id))
        conn.commit()


def get_account(account_id: int) -> dict:
    with _lock, closing(_conn()) as conn:
        return _r(conn.execute("SELECT * FROM accounts WHERE id=?", (account_id,)).fetchone())


def get_account_by_phone(phone: str) -> dict:
    with _lock, closing(_conn()) as conn:
        return _r(conn.execute("SELECT * FROM accounts WHERE phone=?", (phone,)).fetchone())


def list_accounts() -> list:
    with _lock, closing(_conn()) as conn:
        return [dict(r) for r in conn.execute(
            "SELECT * FROM accounts ORDER BY id DESC").fetchall()]


def active_accounts() -> list:
    with _lock, closing(_conn()) as conn:
        return [dict(r) for r in conn.execute(
            "SELECT * FROM accounts WHERE status='active' ORDER BY id").fetchall()]


def accounts_by_ids(ids: list) -> list:
    if not ids:
        return []
    with _lock, closing(_conn()) as conn:
        marks = ",".join("?" * len(ids))
        rows = conn.execute(f"SELECT * FROM accounts WHERE id IN ({marks})", ids).fetchall()
        return [dict(r) for r in rows]


def logout_account(account_id: int):
    with _lock, closing(_conn()) as conn:
        conn.execute(
            "UPDATE accounts SET session_string=NULL, status='logged_out' WHERE id=?",
            (account_id,))
        conn.commit()


# ---------------- jobs / members ----------------

def create_job(account_id: int, group_input: str) -> dict:
    with _lock, closing(_conn()) as conn:
        cur = conn.execute(
            "INSERT INTO jobs (account_id, group_input, status, created_at) VALUES (?,?,?,?)",
            (account_id, group_input, "pending", _now()))
        conn.commit()
        return {"id": cur.lastrowid}


def update_job(job_id: int, **fields):
    if not fields:
        return
    cols = ", ".join(f"{k}=?" for k in fields)
    vals = list(fields.values())
    with _lock, closing(_conn()) as conn:
        conn.execute(f"UPDATE jobs SET {cols} WHERE id=?", (*vals, job_id))
        conn.commit()


def get_job(job_id: int) -> dict:
    with _lock, closing(_conn()) as conn:
        return _r(conn.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone())


def list_jobs() -> list:
    with _lock, closing(_conn()) as conn:
        return [dict(r) for r in conn.execute(
            "SELECT * FROM jobs ORDER BY id DESC").fetchall()]


def delete_job(job_id: int):
    with _lock, closing(_conn()) as conn:
        conn.execute("DELETE FROM members WHERE job_id=?", (job_id,))
        conn.execute("DELETE FROM jobs WHERE id=?", (job_id,))
        conn.commit()


def insert_member(job_id: int, u) -> None:
    with _lock, closing(_conn()) as conn:
        conn.execute(
            "INSERT OR IGNORE INTO members (job_id, user_id, access_hash, username, "
            "first_name, last_name, phone, is_bot, is_verified, is_premium, created_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (job_id, getattr(u, "id", None), getattr(u, "access_hash", None),
             getattr(u, "username", None), getattr(u, "first_name", None),
             getattr(u, "last_name", None), getattr(u, "phone", None),
             1 if getattr(u, "bot", False) else 0,
             1 if getattr(u, "verified", False) else 0,
             1 if getattr(u, "premium", False) else 0,
             _now()))
        conn.commit()


def count_members(job_id: int) -> int:
    with _lock, closing(_conn()) as conn:
        row = conn.execute("SELECT COUNT(*) c FROM members WHERE job_id=?",
                           (job_id,)).fetchone()
        return row["c"] if row else 0


def _member_where(**f) -> tuple:
    conds, args = [], []
    if f.get("has_username"):
        conds.append("(username IS NOT NULL AND username != '')")
    if f.get("has_phone"):
        conds.append("(phone IS NOT NULL AND phone != '')")
    if f.get("exclude_bots"):
        conds.append("is_bot=0")
    search = (f.get("search") or "").strip()
    if search:
        s = f"%{search}%"
        conds.append("(first_name LIKE ? OR last_name LIKE ? OR username LIKE ?)")
        args += [s, s, s]
    return (" AND ".join(conds) if conds else "1", args)


def query_members(job_id: int, f: dict, limit=100, offset=0) -> dict:
    where, args = _member_where(**f)
    with _lock, closing(_conn()) as conn:
        total = conn.execute(
            f"SELECT COUNT(*) c FROM members WHERE job_id=? AND {where}",
            (*([job_id] + args),)).fetchone()["c"]
        rows = conn.execute(
            f"SELECT * FROM members WHERE job_id=? AND {where} ORDER BY id "
            "LIMIT ? OFFSET ?",
            (*([job_id] + args), limit, offset)).fetchall()
        return {"members": [dict(r) for r in rows], "total": total}


def all_members(job_id: int, f: dict) -> list:
    where, args = _member_where(**f)
    with _lock, closing(_conn()) as conn:
        rows = conn.execute(
            f"SELECT * FROM members WHERE job_id=? AND {where} ORDER BY id",
            ([job_id] + args)).fetchall()
        return [dict(r) for r in rows]


# ---------------- campaigns ----------------

def create_campaign(name, account_ids: list, job_id, filters: dict, message,
                    media, min_delay, max_delay, max_per_account) -> int:
    with _lock, closing(_conn()) as conn:
        cur = conn.execute(
            "INSERT INTO campaigns (name, account_ids, job_id, filters, message, media, "
            "min_delay, max_delay, max_per_account, status, created_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (name, ",".join(str(i) for i in account_ids), job_id,
             __import__("json").dumps(filters), message, media,
             min_delay, max_delay, max_per_account, "created", _now()))
        conn.commit()
        return cur.lastrowid


def add_campaign_target(campaign_id, member_id, account_id, target, target_id,
                        access_hash, username, target_name):
    with _lock, closing(_conn()) as conn:
        conn.execute(
            "INSERT INTO campaign_targets (campaign_id, member_id, account_id, target, "
            "target_id, access_hash, username, target_name, status) VALUES (?,?,?,?,?,?,?,?,?)",
            (campaign_id, member_id, account_id, target, target_id, access_hash,
             username, target_name, "pending"))
        conn.commit()


def set_campaign_total(campaign_id: int, total: int):
    with _lock, closing(_conn()) as conn:
        conn.execute("UPDATE campaigns SET total=? WHERE id=?", (total, campaign_id))
        conn.commit()


def get_campaign(campaign_id: int) -> dict:
    with _lock, closing(_conn()) as conn:
        return _r(conn.execute("SELECT * FROM campaigns WHERE id=?",
                               (campaign_id,)).fetchone())


def update_campaign(campaign_id: int, **fields):
    if not fields:
        return
    cols = ", ".join(f"{k}=?" for k in fields)
    vals = list(fields.values())
    with _lock, closing(_conn()) as conn:
        conn.execute(f"UPDATE campaigns SET {cols} WHERE id=?", (*vals, campaign_id))
        conn.commit()


def bump_campaign(campaign_id: int, sent=0, failed=0):
    with _lock, closing(_conn()) as conn:
        conn.execute(
            "UPDATE campaigns SET sent=sent+?, failed=failed+? WHERE id=?",
            (sent, failed, campaign_id))
        conn.commit()


def list_campaigns() -> list:
    with _lock, closing(_conn()) as conn:
        return [dict(r) for r in conn.execute(
            "SELECT * FROM campaigns ORDER BY id DESC").fetchall()]


def get_pending_targets(campaign_id: int, account_id: int, limit=10) -> list:
    with _lock, closing(_conn()) as conn:
        rows = conn.execute(
            "SELECT * FROM campaign_targets WHERE campaign_id=? AND account_id=? "
            "AND status='pending' ORDER BY id LIMIT ?",
            (campaign_id, account_id, limit)).fetchall()
        return [dict(r) for r in rows]


def count_pending(campaign_id: int) -> int:
    with _lock, closing(_conn()) as conn:
        row = conn.execute(
            "SELECT COUNT(*) c FROM campaign_targets WHERE campaign_id=? AND status='pending'",
            (campaign_id,)).fetchone()
        return row["c"] if row else 0


def target_status_counts(campaign_id: int) -> dict:
    with _lock, closing(_conn()) as conn:
        rows = conn.execute(
            "SELECT status, COUNT(*) c FROM campaign_targets WHERE campaign_id=? "
            "GROUP BY status", (campaign_id,)).fetchall()
        return {r["status"]: r["c"] for r in rows}


def mark_target(target_id: int, status: str, error=None):
    with _lock, closing(_conn()) as conn:
        if status == "sent":
            conn.execute(
                "UPDATE campaign_targets SET status=?, error=NULL, sent_at=? WHERE id=?",
                (status, _now(), target_id))
        else:
            conn.execute(
                "UPDATE campaign_targets SET status=?, error=? WHERE id=?",
                (status, error, target_id))
        conn.commit()


def add_log(campaign_id, account_id, target, status, error=None):
    with _lock, closing(_conn()) as conn:
        conn.execute(
            "INSERT INTO campaign_logs (campaign_id, account_id, target, status, error, sent_at) "
            "VALUES (?,?,?,?,?,?)",
            (campaign_id, account_id, target, status, error, _now()))
        conn.commit()


def get_logs(campaign_id: int, limit=200) -> list:
    with _lock, closing(_conn()) as conn:
        rows = conn.execute(
            "SELECT * FROM campaign_logs WHERE campaign_id=? ORDER BY id DESC LIMIT ?",
            (campaign_id, limit)).fetchall()
        return [dict(r) for r in rows]


def stats_dashboard() -> dict:
    with _lock, closing(_conn()) as conn:
        accounts = conn.execute(
            "SELECT COUNT(*) c FROM accounts WHERE status='active'").fetchone()["c"]
        members = conn.execute("SELECT COUNT(*) c FROM members").fetchone()["c"]
        campaigns = conn.execute("SELECT COUNT(*) c FROM campaigns").fetchone()["c"]
        sent = conn.execute("SELECT COALESCE(SUM(sent),0) c FROM campaigns").fetchone()["c"]
        failed = conn.execute("SELECT COALESCE(SUM(failed),0) c FROM campaigns").fetchone()["c"]
        return {"accounts": accounts, "members": members, "campaigns": campaigns,
                "sent": sent, "failed": failed}