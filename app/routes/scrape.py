from fastapi import APIRouter, Depends, HTTPException

from .. import database as db
from ..models import ScrapeRequest
from ..scraper import start_scrape
from ..security import require_perm

router = APIRouter(prefix="/api/scrape", tags=["scrape"])


def _own_job(job, user: dict):
    if user.get("role") == "customer" and job.get("customer_id") != user["customer_id"]:
        raise HTTPException(403, "You can only view your own scrape jobs")


@router.post("/jobs")
async def create_scrape(body: ScrapeRequest, user: dict = Depends(require_perm("scrape"))):
    account = db.get_account(body.account_id)
    if not account or account.get("status") != "active":
        raise HTTPException(400, "Account is not active. Add & verify an account first.")
    group = (body.group or "").strip()
    if not group:
        raise HTTPException(400, "Group link or username is required")
    if not group.startswith("@") and "t.me/" not in group and not group.startswith("http"):
        if not any(c.isalpha() for c in group):
            raise HTTPException(400, "Enter a group username (@group) or full t.me link")
    cid = user.get("customer_id") if user.get("role") == "customer" else None
    job_id = db.create_job(body.account_id, group, cid)
    start_scrape(job_id, body.account_id, group)
    return {"ok": True, "job": db.get_job(job_id)}


@router.get("/jobs")
async def list_jobs(user: dict = Depends(require_perm("scrape"))):
    jobs = db.list_jobs()
    out = []
    for j in jobs:
        if user.get("role") == "customer" and j.get("customer_id") != user["customer_id"]:
            continue
        j["member_count"] = db.count_members(j["id"])
        out.append(j)
    return {"jobs": out}


@router.get("/jobs/{job_id}")
async def get_job(job_id: int, user: dict = Depends(require_perm("scrape"))):
    job = db.get_job(job_id)
    if not job:
        raise HTTPException(404, "Job not found")
    _own_job(job, user)
    job["member_count"] = db.count_members(job_id)
    return {"job": job}


@router.delete("/jobs/{job_id}")
async def delete_job(job_id: int, user: dict = Depends(require_perm("scrape"))):
    job = db.get_job(job_id)
    if not job:
        raise HTTPException(404, "Job not found")
    _own_job(job, user)
    db.delete_job(job_id)
    return {"ok": True}