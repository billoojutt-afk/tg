import json
import urllib.request

from .config import TRONSCAN_KEY, WALLET

USDT_CONTRACT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t"
USDT_DECIMALS = 6

_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"


def _b58decode(s: str) -> bytes:
    num = 0
    for ch in s:
        num = num * 58 + _ALPHABET.index(ch)
    return num.to_bytes((num.bit_length() + 7) // 8 or 1, "big")


def _addr_to_hex(addr) -> str | None:
    addr = (addr or "").strip()
    if not addr:
        return None
    if addr.lower().startswith("41") and len(addr) == 42 and \
            all(c in "0123456789abcdefABCDEF" for c in addr):
        return addr.lower()
    try:
        data = _b58decode(addr)
        decoded = data[:-4]  # drop 4-byte checksum
        if len(decoded) == 21 and decoded[0] == 0x41:
            return decoded.hex()
    except Exception:
        pass
    return None


def _api_get(url: str, timeout: float = 30) -> dict:
    headers = {"User-Agent": "Mozilla/5.0", "Accept": "application/json"}
    if TRONSCAN_KEY:
        headers["TRON-PRO-API-KEY"] = TRONSCAN_KEY
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def verify_tx(txid: str) -> float | None:
    """Returns USDT amount (TRC20) received to the owner wallet, or None."""
    wallet_hex = _addr_to_hex(WALLET)
    wallet_b58 = WALLET.strip()
    if not wallet_hex:
        raise ValueError("Wallet address is not set in config.json (key 'wallet')")

    data = _api_get(f"https://apilist.tronscanapi.com/api/transaction-info?hash={txid}")

    confirmed = bool(data.get("confirmed", False) or data.get("contractRet") not in (None, ""))
    if not confirmed:
        return None

    transfers = data.get("trc20TransferInfo") or []
    if transfers:
        for tr in transfers:
            to_b58 = (tr.get("to_address") or "").strip()
            symbol = (tr.get("tokenInfo") or {}).get("symbol") or ""
            contract = (tr.get("tokenInfo") or {}).get("tokenId") or ""
            if contract not in (USDT_CONTRACT, _addr_to_hex(USDT_CONTRACT) or ""):
                continue
            if symbol and symbol.upper() != "USDT":
                continue
            if to_b58 != wallet_b58 and (_addr_to_hex(to_b58) or "") != wallet_hex:
                continue
            try:
                raw = tr.get("amount_str") or tr.get("amount") or "0"
                usdt = float(str(raw).replace(",", "")) / (10 ** USDT_DECIMALS)
            except (TypeError, ValueError):
                usdt = 0.0
            return usdt

    cd = data.get("contractData") or {}
    if data.get("contractType") == 31 and cd.get("function_selector") == "transfer(address,uint256)":
        contract_hex = _addr_to_hex(cd.get("contract_address")) or data.get("toAddress") or ""
        if contract_hex != _addr_to_hex(USDT_CONTRACT):
            return None
        to_hex = (_addr_to_hex(cd.get("to_address")) or "").lower()
        if to_hex != wallet_hex:
            return None
        try:
            usdt = float(cd.get("amount") or 0) / (10 ** USDT_DECIMALS)
        except (TypeError, ValueError):
            usdt = 0.0
        return usdt

    return None