#!/bin/bash
#
# batch_generate.sh — build a batch ZIP of pre-provisioned devices.
#
# Wraps existing per-device tooling (does NOT rewrite it):
#   - /home/rahul/HSM-Tool/Certificates-Tool/new_certficate.sh  (cert + key + chain + hash)
#   - /home/rahul/augentix-mqtt/firmware/<fw>/                  (chosen firmware image)
#   - gen_otp.py                                                (16-byte OTP file per device)
#
# Usage:
#   batch_generate.sh <batchId> <productModel> <family> <firmware> <count> <startSerial> <endSerial>
#
# Outputs:
#   $BATCH_OUTPUT_ROOT/<batchId>.zip
#   $BATCH_OUTPUT_ROOT/<batchId>.zip.sha256
#

set -euo pipefail

# ── Inputs ─────────────────────────────────────────────────────────────
BATCH_ID="${1:?batch_id required}"
PRODUCT_MODEL="${2:?product_model required}"
FAMILY="${3:?family required}"         # SECOS | AUGEN | 4GBDP | WFBDP
FIRMWARE="${4:?firmware required}"     # dir name under FIRMWARE_ROOT, e.g. v6.2.20.0-dev
COUNT="${5:?count required}"
SERIAL_START="${6:?serial_start required}"
SERIAL_END="${7:?serial_end required}"

# ── Config (env-overridable) ───────────────────────────────────────────
CERT_TOOL="${CERT_TOOL:-/home/rahul/HSM-Tool/Certificates-Tool/new_certficate.sh}"
FIRMWARE_ROOT="${FIRMWARE_ROOT:-/home/rahul/augentix-mqtt/firmware}"
GEN_OTP="${GEN_OTP:-$(dirname "$0")/gen_otp.py}"
ROOT_CA_PEM="${ROOT_CA_PEM:-/etc/ssl/rahul-arcisai-hsm/root-ca.pem}"
INTERMEDIATE_CA_PEM="${INTERMEDIATE_CA_PEM:-/etc/ssl/rahul-arcisai-hsm/intermediate-ca.pem}"
BATCH_OUTPUT_ROOT="${BATCH_OUTPUT_ROOT:-/home/rahul/Stqc-Ems-Backend/batch_output}"
CERT_VALIDITY_DAYS="${CERT_VALIDITY_DAYS:-1095}"

# SHA256SUMS signer.
# Reuses Rahul's existing firmware-signing tool — same HSM key
# (firmware-signing-key-raw, RSA-2048, PKCS#11), so the station's firmware-
# verify pubkey works for batch-manifest verify too. One root of trust.
#
# If $SIGN_FIRMWARE_TOOL is unset or missing, we skip signing and write an
# UNSIGNED-DEV-BUILD placeholder (fine for dev, reject in prod mode).
SIGN_FIRMWARE_TOOL="${SIGN_FIRMWARE_TOOL:-/home/rahul/HSM-Tool/Sign-Tool/sign_firmware_algo.sh}"

# ── Sanity checks ──────────────────────────────────────────────────────
[[ -x "$CERT_TOOL" ]] || { echo "ERR: cert tool not found/executable: $CERT_TOOL" >&2; exit 2; }
[[ -d "$FIRMWARE_ROOT/$FIRMWARE" ]] || { echo "ERR: firmware dir not found: $FIRMWARE_ROOT/$FIRMWARE" >&2; exit 2; }
[[ -f "$GEN_OTP" ]] || { echo "ERR: gen_otp.py not found: $GEN_OTP" >&2; exit 2; }
[[ -f "$ROOT_CA_PEM" ]] || { echo "ERR: root CA PEM not found: $ROOT_CA_PEM" >&2; exit 2; }
[[ "$COUNT" =~ ^[0-9]+$ ]] || { echo "ERR: count not numeric: $COUNT" >&2; exit 2; }
[[ $((SERIAL_END - SERIAL_START + 1)) -eq "$COUNT" ]] || { echo "ERR: serial range size != count" >&2; exit 2; }

# ── Workspace ──────────────────────────────────────────────────────────
mkdir -p "$BATCH_OUTPUT_ROOT"
WORK_DIR="$BATCH_OUTPUT_ROOT/$BATCH_ID"
rm -rf "$WORK_DIR"
mkdir -p "$WORK_DIR/devices" "$WORK_DIR/ca" "$WORK_DIR/firmware"

log() { echo "[batch_generate $BATCH_ID] $*"; }

log "Starting batch: family=$FAMILY model=$PRODUCT_MODEL fw=$FIRMWARE count=$COUNT range=$SERIAL_START-$SERIAL_END"

# ── Copy CA material ───────────────────────────────────────────────────
cp "$ROOT_CA_PEM" "$WORK_DIR/ca/root-ca.pem"
[[ -f "$INTERMEDIATE_CA_PEM" ]] && cp "$INTERMEDIATE_CA_PEM" "$WORK_DIR/ca/intermediate-ca.pem"

# ── Bundle batch-signing pubkey in all needed formats ──────────────────
# All formats already exist in PUBKEY_DIR — just copy them in. No KMS
# round-trip needed (the pubkey is static until the key is rotated).
PUBKEY_DIR="${PUBKEY_DIR:-/home/rahul/HSM-Tool/Sign-Tool/firmware-signing-key-raw-pubkeys}"

if [[ -d "$PUBKEY_DIR" ]]; then
    mkdir -p "$WORK_DIR/keys"
    KEY_VER="${KMS_FIRMWARE_KEY_VERSION:-1}"

    # Map source filenames → destination names inside the ZIP
    [[ -f "$PUBKEY_DIR/pubkey_v${KEY_VER}.pem"         ]] && cp "$PUBKEY_DIR/pubkey_v${KEY_VER}.pem"         "$WORK_DIR/keys/batch-sign-pubkey.pem"
    [[ -f "$PUBKEY_DIR/pubkey_v${KEY_VER}.der"         ]] && cp "$PUBKEY_DIR/pubkey_v${KEY_VER}.der"         "$WORK_DIR/keys/batch-sign-pubkey.der"
    [[ -f "$PUBKEY_DIR/pubkey_modulus_v${KEY_VER}.bin" ]] && cp "$PUBKEY_DIR/pubkey_modulus_v${KEY_VER}.bin" "$WORK_DIR/keys/batch-sign-pubkey-modulus.bin"
    [[ -f "$PUBKEY_DIR/pubkey_modulus_v${KEY_VER}.hex" ]] && cp "$PUBKEY_DIR/pubkey_modulus_v${KEY_VER}.hex" "$WORK_DIR/keys/batch-sign-pubkey-modulus.hex"
    [[ -f "$PUBKEY_DIR/rotpk_v${KEY_VER}.bin"          ]] && cp "$PUBKEY_DIR/rotpk_v${KEY_VER}.bin"          "$WORK_DIR/keys/batch-sign-pubkey-rotpk.bin"
    [[ -f "$PUBKEY_DIR/rotpk_v${KEY_VER}.txt"          ]] && cp "$PUBKEY_DIR/rotpk_v${KEY_VER}.txt"          "$WORK_DIR/keys/batch-sign-pubkey.sha224"
    [[ -f "$PUBKEY_DIR/u-boot_pubkey_v${KEY_VER}.dtb"  ]] && cp "$PUBKEY_DIR/u-boot_pubkey_v${KEY_VER}.dtb"  "$WORK_DIR/keys/u-boot_pubkey.dtb"
    [[ -f "$PUBKEY_DIR/u-boot_pubkey_v${KEY_VER}.dts"  ]] && cp "$PUBKEY_DIR/u-boot_pubkey_v${KEY_VER}.dts"  "$WORK_DIR/keys/u-boot_pubkey.dts"

    # SHA-256 fingerprint not pre-exported — compute locally from the DER
    if [[ -f "$WORK_DIR/keys/batch-sign-pubkey.der" ]]; then
        openssl dgst -sha256 -hex "$WORK_DIR/keys/batch-sign-pubkey.der" \
            | awk '{print $NF}' > "$WORK_DIR/keys/batch-sign-pubkey.sha256"
    fi

    if [[ -f "$WORK_DIR/keys/batch-sign-pubkey.sha224" ]]; then
        log "pubkey bundled from $PUBKEY_DIR (rotpk/sha224=$(tr -d '[:space:]' <"$WORK_DIR/keys/batch-sign-pubkey.sha224"))"
    else
        log "pubkey copied from $PUBKEY_DIR (rotpk file missing — station ROTPK pin may fail)"
    fi
else
    log "WARN: PUBKEY_DIR not found ($PUBKEY_DIR) — keys/ omitted from ZIP"
fi

# ── Compute Root CA hash (truncated 96-bit for OTP pin) ────────────────
ROOT_CA_HASH_FULL=$(openssl x509 -in "$WORK_DIR/ca/root-ca.pem" -outform DER | sha256sum | awk '{print $1}')
ROOT_CA_HASH_12=${ROOT_CA_HASH_FULL:0:24}   # first 12 bytes = 24 hex chars
log "Root CA hash (truncated 96-bit): $ROOT_CA_HASH_12"

# ── Copy firmware image(s) ─────────────────────────────────────────────
cp -r "$FIRMWARE_ROOT/$FIRMWARE"/. "$WORK_DIR/firmware/"
( cd "$WORK_DIR/firmware" && sha256sum * > firmware.sha256 || true )

# ── Generate devices ───────────────────────────────────────────────────
PROVISION_CFG="$WORK_DIR/provision.cfg"
: > "$PROVISION_CFG"

# IDs list for batch.json
DEVICE_IDS_JSON=""

# Track per-device dir for zipping
for (( i=0; i<COUNT; i++ )); do
    SERIAL=$((SERIAL_START + i))
    SERIAL_PADDED=$(printf "%06d" "$SERIAL")

    # 5-char random uppercase suffix per device (A-Z only, no digits).
    # Pure bash to avoid SIGPIPE from `tr | head` — `head -c 5` closes the
    # pipe, `tr` gets SIGPIPE, and with `set -o pipefail` the script aborts
    # before the loop body even logs (exit 141).
    ALPHA="ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    SUFFIX=""
    for ((j=0; j<5; j++)); do SUFFIX+="${ALPHA:$((RANDOM % 26)):1}"; done
    DEVICE_ID="ATPL-${SERIAL_PADDED}-${SUFFIX}"

    DEV_DIR="$WORK_DIR/devices/${DEVICE_ID}"
    mkdir -p "$DEV_DIR"

    log "[$((i+1))/$COUNT] $DEVICE_ID"

    # 1. Run cert tool. It writes into its own ./certificates/<DEVICE_ID>/ —
    #    we cd into device dir and move its output up after.
    #    cert tool takes: DEVICE_ID VALIDITY_DAYS
    (
        cd "$DEV_DIR"
        "$CERT_TOOL" "$DEVICE_ID" "$CERT_VALIDITY_DAYS" >cert.log 2>&1
    )

    # cert tool wrote to $DEV_DIR/certificates/$DEVICE_ID/* — flatten one level up
    if [[ -d "$DEV_DIR/certificates/$DEVICE_ID" ]]; then
        mv "$DEV_DIR/certificates/$DEVICE_ID"/* "$DEV_DIR/"
        rm -rf "$DEV_DIR/certificates"
    fi

    # 2. OTP: takes DEVICE_ID + FAMILY via env, rootCaPath for the 96-bit hash.
    DEVICE_ID="$DEVICE_ID" FAMILY="$FAMILY" ROOT_CA_PEM="$WORK_DIR/ca/root-ca.pem" \
        python3 "$GEN_OTP" "$DEV_DIR/otp.bin"

    # 3. Write handoff file for provision_device.sh
    echo "$DEVICE_ID" > "$DEV_DIR/current_device.id"

    # 4. Append to batch-wide provision.cfg
    echo "$DEVICE_ID" >> "$PROVISION_CFG"

    # 5. Accumulate device ID for batch.json
    if [[ -z "$DEVICE_IDS_JSON" ]]; then
        DEVICE_IDS_JSON="\"$DEVICE_ID\""
    else
        DEVICE_IDS_JSON="$DEVICE_IDS_JSON, \"$DEVICE_ID\""
    fi
done

# ── batch.json manifest ────────────────────────────────────────────────
FAMILY_CODE=0
case "$FAMILY" in
    SECOS)  FAMILY_CODE=0 ;;
    AUGEN)  FAMILY_CODE=1 ;;
    4GBDP)  FAMILY_CODE=2 ;;
    WFBDP)  FAMILY_CODE=3 ;;
esac

CREATED_AT=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

cat > "$WORK_DIR/batch.json" <<EOF
{
  "batchId": "$BATCH_ID",
  "productModel": "$PRODUCT_MODEL",
  "family": "$FAMILY",
  "familyCode": $FAMILY_CODE,
  "firmware": "$FIRMWARE",
  "count": $COUNT,
  "serialStart": $SERIAL_START,
  "serialEnd": $SERIAL_END,
  "rootCaHash": {
    "algorithm": "SHA-256-truncated-96",
    "hex": "$ROOT_CA_HASH_12"
  },
  "createdAt": "$CREATED_AT",
  "deviceIds": [$DEVICE_IDS_JSON]
}
EOF

# ── SHA256SUMS of the whole batch ──────────────────────────────────────
(
    cd "$WORK_DIR"
    find . -type f \( \
        -path './batch.json' -o \
        -path './provision.cfg' -o \
        -path './ca/*' -o \
        -path './firmware/*' -o \
        -path './devices/*' -o \
        -path './keys/*' \
    \) ! -name 'SHA256SUMS*' -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS
)

# HSM-sign SHA256SUMS via the same tool used for firmware signing.
# Output is a 256-byte RSA-2048 PKCS#1 v1.5 signature over SHA-256(SHA256SUMS),
# produced by firmware-signing-key-raw. The station's firmware-verify pubkey
# verifies this, so no new key distribution is needed.
if [[ -x "$SIGN_FIRMWARE_TOOL" ]]; then
    # sign_firmware_algo.sh sources $HOME/.arcisai_hsm_env which sets
    # GCP_KEY_NAME (currently set to "secure_ota_key" — wrong for our purpose).
    # Override to the firmware-signing key we want — its pubkey hash is what's
    # burned into device ROTPK, so the manifest signature can be verified by
    # any device on the fleet using the same trust anchor as firmware verify.
    SIGN_KEY_OVERRIDE="${KMS_FIRMWARE_KEY:-firmware-signing-key-raw}"
    log "HSM-signing SHA256SUMS via $SIGN_FIRMWARE_TOOL (key=$SIGN_KEY_OVERRIDE)"
    (
        cd "$WORK_DIR"
        GCP_KEY_NAME="$SIGN_KEY_OVERRIDE" \
            "$SIGN_FIRMWARE_TOOL" SHA256SUMS SHA256SUMS.sig sha256 binary >sign.log 2>&1
    )
    rm -f "$WORK_DIR/sign.log"
else
    log "WARN: $SIGN_FIRMWARE_TOOL not found/executable; writing unsigned placeholder"
    echo "UNSIGNED-DEV-BUILD" > "$WORK_DIR/SHA256SUMS.sig"
fi

# ── ZIP it ─────────────────────────────────────────────────────────────
ZIP_FILE="$BATCH_OUTPUT_ROOT/${BATCH_ID}.zip"
rm -f "$ZIP_FILE"
(
    cd "$WORK_DIR"
    zip -qr "$ZIP_FILE" \
        batch.json SHA256SUMS SHA256SUMS.sig provision.cfg \
        ca firmware devices \
        $([[ -d keys ]] && echo keys)
)

ZIP_SHA256=$(sha256sum "$ZIP_FILE" | awk '{print $1}')
echo "$ZIP_SHA256  $(basename "$ZIP_FILE")" > "${ZIP_FILE}.sha256"

ZIP_SIZE=$(stat -c %s "$ZIP_FILE")

log "Done. ZIP=$ZIP_FILE size=$ZIP_SIZE sha256=$ZIP_SHA256"

# Emit a one-line JSON result on stdout for the controller to parse
printf '{"batchId":"%s","zipPath":"%s","zipSha256":"%s","zipSizeBytes":%d,"rootCaHash":"%s"}\n' \
    "$BATCH_ID" "$ZIP_FILE" "$ZIP_SHA256" "$ZIP_SIZE" "$ROOT_CA_HASH_12"
