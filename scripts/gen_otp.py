"""
Augentix gen_otp.py — generates 16-byte otp.bin for ArcisAI devices.

OTP Layout (16 bytes = user_custom[0..3], all LE uint32):
    [0]   Encoded device ID
          - bits 31-24: reserved (0)
          - bits 23-4 : serial (20-bit, from numeric part of device ID)
          - bits 3-0  : family code (4-bit, from FAMILY env var)
    [1..3] Truncated Root CA hash (12 bytes = sha256(root-ca.der)[0:12])

Device ID format: ATPL-NNNNNN-XXXXX
    NNNNNN = 6-digit numeric serial
    XXXXX  = 5 random uppercase letters (per-device, NOT related to family)
    Family is carried as separate metadata, NOT parsed from the device ID.

Sources (checked in order):
    DEVICE_ID env var (required)
    FAMILY    env var — one of SECOS | AUGEN | 4GBDP | WFBDP (required)
    ROOT_CA_PEM env var — path to the Root CA PEM (optional; if unset, uses
                          the hardcoded CA_HASH_FALLBACK below)

Usage:
    DEVICE_ID=ATPL-900001-KTMVR FAMILY=SECOS \\
        ROOT_CA_PEM=/etc/ssl/rahul-arcisai-hsm/root-ca.pem \\
        python3 gen_otp.py otp.bin
"""

import os
import re
import struct
import subprocess
import sys

# ── Constants ────────────────────────────────────────────────────────

DEVICE_ID_RE = re.compile(r"^ATPL-(\d{6})-[A-Z]{5}$")

FAMILY_TABLE = {
    "SECOS": 0,
    "AUGEN": 1,
    "4GBDP": 2,
    "WFBDP": 3,
}

# Fallback used only when ROOT_CA_PEM env var is not set.
# Source: /etc/ssl/rahul-arcisai-hsm/root-ca.pem on platform 34.100.143.36
# sha256(root-ca.der)[0:12] = 44 EA C1 47 53 38 51 46 97 1F 2B C3
CA_HASH_FALLBACK = "44EAC14753385146971F2BC3"


# ── Helpers ─────────────────────────────────────────────────────────

def read_device_id() -> str:
    dev = (os.environ.get("DEVICE_ID") or "").strip()
    if not dev:
        raise RuntimeError("DEVICE_ID env var is required (e.g. ATPL-900001-KTMVR)")
    if not DEVICE_ID_RE.match(dev):
        raise ValueError(
            f"DEVICE_ID '{dev}' must match ATPL-NNNNNN-XXXXX "
            f"(6 digits + 5 uppercase letters)"
        )
    return dev


def read_family() -> tuple[str, int]:
    fam = (os.environ.get("FAMILY") or "").strip().upper()
    if not fam:
        raise RuntimeError(
            f"FAMILY env var is required (one of {', '.join(FAMILY_TABLE)})"
        )
    if fam not in FAMILY_TABLE:
        raise ValueError(
            f"FAMILY '{fam}' invalid; must be one of {', '.join(FAMILY_TABLE)}"
        )
    return fam, FAMILY_TABLE[fam]


def compute_root_ca_hash_12(pem_path: str) -> str:
    """Return hex of sha256(root-ca.der)[0:12] — 24 hex chars."""
    result = subprocess.run(
        ["openssl", "x509", "-in", pem_path, "-outform", "DER"],
        check=True, capture_output=True,
    )
    import hashlib
    full = hashlib.sha256(result.stdout).hexdigest().upper()
    return full[:24]


def read_ca_hash() -> str:
    pem = os.environ.get("ROOT_CA_PEM", "").strip()
    if pem:
        if not os.path.isfile(pem):
            raise FileNotFoundError(f"ROOT_CA_PEM not found: {pem}")
        return compute_root_ca_hash_12(pem)
    return CA_HASH_FALLBACK


def encode_device_id(device_id: str, family_code: int) -> int:
    m = DEVICE_ID_RE.match(device_id)
    assert m, "device_id format pre-validated"
    serial = int(m.group(1))
    if serial == 0 or serial > 0xFFFFF:
        raise ValueError(f"Serial {serial} out of range [1, 1048575]")
    return ((serial & 0xFFFFF) << 4) | (family_code & 0xF)


def parse_ca_hash_to_words(hex24: str) -> tuple[int, int, int]:
    if len(hex24) != 24 or not re.match(r"^[0-9A-Fa-f]{24}$", hex24):
        raise ValueError(f"CA hash must be 24 hex chars, got '{hex24}'")
    return (
        int(hex24[0:8], 16),
        int(hex24[8:16], 16),
        int(hex24[16:24], 16),
    )


# ── Main ────────────────────────────────────────────────────────────

def generate_otp_bin(out_path: str) -> None:
    device_id = read_device_id()
    family, family_code = read_family()
    ca_hash_hex = read_ca_hash()

    encoded = encode_device_id(device_id, family_code)
    ca0, ca1, ca2 = parse_ca_hash_to_words(ca_hash_hex)

    otp = struct.pack("<IIII", encoded, ca0, ca1, ca2)
    assert len(otp) == 16

    with open(out_path, "wb") as f:
        f.write(otp)

    print(f"Device ID:   {device_id}")
    print(f"Family:      {family} (code {family_code})")
    print(f"Encoded[0]:  0x{encoded:08X}")
    print(f"Root CA:     {ca_hash_hex}")
    print(f"Written:     {out_path}  ({len(otp)} bytes)")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Usage: gen_otp.py <output_file>", file=sys.stderr)
        sys.exit(1)
    try:
        generate_otp_bin(sys.argv[1])
    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)
