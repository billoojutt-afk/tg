import smtplib
from email.message import EmailMessage

from . import config as cfg


def smtp_configured() -> bool:
    return bool(cfg.SMTP_EMAIL and cfg.SMTP_APP_PASSWORD)


def send_password_email(recover_username: str, password: str) -> None:
    """Send the password for an account to the configured Gmail. Raises on failure."""
    if not smtp_configured():
        raise RuntimeError("Gmail recovery is not configured yet — ask the owner to set smtp_email / smtp_app_password in config.json")
    subject = "WOLF TGBulk — Password recovery"
    name = recover_username or "Owner"
    body = (
        "Hi!\n\n"
        f"You requested the password for username: {name}\n\n"
        f"Password: {password}\n\n"
        "Keep it safe. — WOLF TGBulk"
    )
    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = cfg.SMTP_EMAIL
    msg["To"] = cfg.SMTP_EMAIL
    msg.set_content(body)

    with smtplib.SMTP(cfg.SMTP_HOST, cfg.SMTP_PORT, timeout=20) as s:
        s.ehlo()
        s.starttls()
        s.login(cfg.SMTP_EMAIL, cfg.SMTP_APP_PASSWORD)
        s.send_message(msg)