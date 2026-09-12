import io
import csv

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import Response, StreamingResponse

from .. import database as db

router = APIRouter(prefix="/api/members", tags=["members"])


def _filters(has_username: str = "", has_phone: str = "", exclude_bots: str = "",
             search: str = "") -> dict:
    return {
        "has_username": str(has_username).lower() in ("1", "true", "on"),
        "has_phone": str(has_phone).lower() in ("1", "true", "on"),
        "exclude_bots": str(exclude_bots).lower() in ("1", "true", "on"),
        "search": search or "",
    }


@router.get("")
async def get_members(job_id: int = Query(...),
                      has_username: str = "",
                      has_phone: str = "",
                      exclude_bots: str = "",
                      search: str = "",
                      limit: int = 100,
                      offset: int = 0):
    job = db.get_job(job_id)
    if not job:
        raise HTTPException(404, "Job not found")
    f = _filters(has_username, has_phone, exclude_bots, search)
    result = db.query_members(job_id, f, min(max(limit, 1), 500), max(offset, 0))
    result["job_total"] = db.count_members(job_id)
    return result


@router.get("/export.csv")
async def export_csv(job_id: int = Query(...),
                     has_username: str = "",
                     has_phone: str = "",
                     exclude_bots: str = "",
                     search: str = ""):
    job = db.get_job(job_id)
    if not job:
        raise HTTPException(404, "Job not found")
    f = _filters(has_username, has_phone, exclude_bots, search)
    rows = db.all_members(job_id, f)
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(["username", "phone", "first_name", "last_name", "user_id"])
    for m in rows:
        writer.writerow([m.get("username") or "", m.get("phone") or "",
                         m.get("first_name") or "", m.get("last_name") or "",
                         m.get("user_id") or ""])
    data = buf.getvalue().encode("utf-8-sig")
    return Response(content=data, media_type="text/csv",
                    headers={"Content-Disposition": "attachment; filename=members.csv"})