import re

from telethon import TelegramClient, errors
from telethon.sessions import StringSession

from . import database as db
from .config import API_ID, API_HASH


class LoginError(Exception):
    pass


class TwoFARequired(Exception):
    pass


def normalize_phone(phone: str) -> str:
    phone = re.sub(r"[^\d]", "", phone or "")
    if not phone:
        raise LoginError("Phone number is empty")
    if not phone.startswith(("1", "7", "9", "20", "4", "8", "6", "3")) and len(phone) > 11:
        pass
    if len(phone) < 8:
        raise LoginError("Phone number looks too short. Use international format, e.g. +15551234567")
    return phone


class TelegramManager:
    def __init__(self, api_id=API_ID, api_hash=API_HASH):
        self.api_id = api_id
        self.api_hash = api_hash
        self._pending = {}   # account_id -> TelegramClient (mid-login)
        self._clients = {}   # account_id -> TelegramClient (logged in)

    async def send_login_code(self, account_id: int, phone: str) -> str:
        phone = normalize_phone(phone)
        client = TelegramClient(StringSession(), self.api_id, self.api_hash)
        await client.connect()
        try:
            res = await client.send_code_request(phone)
        except errors.PhoneNumberInvalidError:
            await client.disconnect()
            raise LoginError("Invalid phone number")
        except errors.FloodWaitError as e:
            await client.disconnect()
            raise LoginError(f"Flood wait: try again after {e.seconds}s")
        self._pending[account_id] = client
        return res.phone_code_hash

    async def verify_code(self, account_id: int, phone: str, code: str,
                          password: str | None = None, code_hash: str = "") -> str:
        client = self._pending.get(account_id)
        if client is None:
            raise LoginError("Session expired. Request a new code.")
        if phone:
            phone = normalize_phone(phone)
        try:
            await client.sign_in(phone=phone, code=code, phone_code_hash=code_hash)
        except errors.SessionPasswordNeededError:
            if not password:
                raise TwoFARequired()
            try:
                await client.sign_in(password=password)
            except errors.PasswordHashInvalidError:
                raise LoginError("Wrong 2FA password")
            except Exception as e:
                raise LoginError(f"2FA sign-in failed: {e}")
        except errors.PhoneCodeInvalidError:
            raise LoginError("The code is incorrect or expired")
        except errors.PhoneCodeExpiredError:
            raise LoginError("The code has expired. Request a new one.")
        except Exception as e:
            raise LoginError(f"Sign-in failed: {e}")
        me = await client.get_me()
        session_string = client.session.save()
        self._pending.pop(account_id, None)
        await client.disconnect()
        name = f"{getattr(me, 'first_name', '') or ''} {getattr(me, 'last_name', '') or ''}".strip()
        db.login_account(account_id, getattr(me, "username", None), name, session_string)
        return session_string

    async def get_client(self, account: dict) -> TelegramClient:
        account_id = account["id"]
        client = self._clients.get(account_id)
        if client is None:
            if not account.get("session_string"):
                raise LoginError(f"Account {account['phone']} is not logged in")
            client = TelegramClient(StringSession(account["session_string"]),
                                    self.api_id, self.api_hash)
            try:
                await client.connect()
            except OSError:
                raise LoginError("Connection failed")
            if not await client.is_user_authorized():
                await client.disconnect()
                raise LoginError("Session expired, please re-login")
            self._clients[account_id] = client
        return client

    async def close_all(self):
        for client in list(self._pending.values()) + list(self._clients.values()):
            try:
                await client.disconnect()
            except Exception:
                pass
        self._pending.clear()
        self._clients.clear()


tg = TelegramManager()