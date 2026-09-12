from typing import Optional

from pydantic import BaseModel


class LoginRequest(BaseModel):
    password: str


class SendCodeRequest(BaseModel):
    phone: str


class VerifyRequest(BaseModel):
    account_id: int
    code: str
    password: Optional[str] = None


class ScrapeRequest(BaseModel):
    account_id: int
    group: str
    group_type: Optional[str] = "group"


class MemberFilters(BaseModel):
    has_username: bool = False
    has_phone: bool = False
    exclude_bots: bool = False
    search: Optional[str] = ""


class TargetFilters(BaseModel):
    job_id: Optional[int] = None
    has_username: bool = False
    has_phone: bool = False
    exclude_bots: bool = False
    search: Optional[str] = ""


class CampaignCreate(BaseModel):
    name: str = "Campaign"
    account_ids: list[int]
    job_id: Optional[int] = None
    custom_targets: Optional[str] = None
    filters: Optional[TargetFilters] = None
    message: Optional[str] = ""
    media: Optional[str] = None
    min_delay: float = 30
    max_delay: float = 90
    max_per_account: int = 0