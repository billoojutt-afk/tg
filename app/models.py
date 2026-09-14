from typing import Optional

from pydantic import BaseModel


class LoginRequest(BaseModel):
    username: Optional[str] = ""
    password: str


class RegisterRequest(BaseModel):
    name: Optional[str] = ""
    username: str
    password: str


class ForgotRequest(BaseModel):
    username: Optional[str] = ""


class CreateCustomer(BaseModel):
    name: Optional[str] = ""
    username: str
    password: str
    permissions: Optional[list[str]] = ["validate"]


class PermissionsUpdate(BaseModel):
    permissions: list[str]


ALL_PERMISSIONS = ["dashboard", "accounts", "scrape", "send", "validate"]


class AddCredits(BaseModel):
    customer_id: int
    credits: float


class PayRequest(BaseModel):
    txid: str


class ValidateRequest(BaseModel):
    account_id: int
    numbers: list[str]


class SendCodeRequest(BaseModel):
    phone: str


class VerifyRequest(BaseModel):
    account_id: int
    code: str
    password: Optional[str] = None


class SetApiKeyRequest(BaseModel):
    api_key_id: Optional[int] = None


class PricingUpdate(BaseModel):
    usd: float
    per: int


class AddApiKeyRequest(BaseModel):
    api_id: int
    api_hash: str
    label: str = ""


class SupportSettings(BaseModel):
    username: str = ""


class DelayUpdate(BaseModel):
    min_delay: float
    max_delay: float


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