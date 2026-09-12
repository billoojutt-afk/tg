from fastapi import APIRouter, HTTPException

from .. import database as db
from ..models import ScrapeRequest
from ..scraper import start_scrape

router = APIRouter(prefix="/api/scrape", tags=["scrape"])


@router.post("/jobs")
async def create_scrape(body: ScrapeRequest):
    account = db.get_account(body.account_id)
    if not account or account.get("status") != "active":
        raise HTTPException(400, "Account is not active. Add & verify an account first.")
    group = (body.group or "").strip()
    if not group:
        raise HTTPException(400, "Group link or username is required")
    if not group.startswith("@") and "t.me/" not in group and not group.startswith("http"):
        if not any(c.isalpha() for c in group):
            raise HTTPException(400, "Enter a group username (@group) or full t.me link")
    job_id = db.create_job(body.account_id, group)
    start_scrape(job_id, body.account_id, group)
    return {"ok": True, "job": db.get_job(job_id)}


@router.get("/jobs")
async def list_jobs():
    jobs = db.list_jobs()
    out = []
    for j in jobs:
        j["member_count"] = db.count_members(j["id"])
        out.append(j)
    return {"jobs": out}


@router.get("/jobs/{job_id}")
async def get_job(job_id: int):
    job = db.get_job(job_id)
    if not job:
        raise HTTPException(404, "Job not found")
    job["member_count"] = db.count_members(job_id)
    return {"job": job}


@router.delete("/jobs/{job_id}")
async def delete_job(job_id: int):
    db.delete_job(job_id)
    return {"ok": True}