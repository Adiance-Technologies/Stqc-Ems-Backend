/*
 * services/batchGenerationService.js
 *
 * Pure-Node port of /home/rahul/Stqc-Ems-Backend/scripts/batch_generate.sh.
 *
 * No shell-out, no PKCS#11, no gcloud CLI. Uses:
 *   - certIssuanceService          for GCP CAS cert issuance
 *   - @google-cloud/kms KeyManagementServiceClient for SHA256SUMS signing
 *   - node-forge / Node `crypto`   for OTP, hashes, CA-DER computations
 *   - adm-zip                      for ZIP packaging
 *
 * Public surface:
 *   generateBatch({ batchId, productModel, family, firmware, count,
 *                   serialStart, serialEnd })
 *     Returns { ok, batchId, zipPath, zipSha256, zipSizeBytes, rootCaHash,
 *               devices: [{ deviceId, ... }] }
 */

const fs       = require('fs');
const path     = require('path');
const crypto   = require('crypto');
const AdmZip   = require('adm-zip');
const { KeyManagementServiceClient } = require('@google-cloud/kms');

const certIssuance = require('./certIssuanceService');
const firmwareSource = require('./firmwareSource');

// ── Config ───────────────────────────────────────────────────────────
const PROJECT     = process.env.GCP_PROJECT_ID || 'arcisai-iot-platform';
const REGION      = process.env.GCP_REGION     || 'asia-south1';
const KEYRING     = process.env.KMS_KEYRING    || 'arcisai-manufacturing';
const KEY_NAME    = process.env.KMS_FIRMWARE_KEY || 'firmware-signing-key-raw';
const KEY_VERSION = process.env.KMS_FIRMWARE_KEY_VERSION || '1';

const ROOT_CA_PEM         = process.env.ROOT_CA_PEM || '/etc/ssl/rahul-arcisai-hsm/root-ca.pem';
const INTERMEDIATE_CA_PEM = process.env.INTERMEDIATE_CA_PEM || '/etc/ssl/rahul-arcisai-hsm/intermediate-ca.pem';
const FIRMWARE_ROOT       = process.env.FIRMWARE_ROOT || '/home/rahul/augentix-mqtt/firmware';
const PUBKEY_DIR          = process.env.PUBKEY_DIR || '/home/rahul/HSM-Tool/Sign-Tool/firmware-signing-key-raw-pubkeys';
const BATCH_OUTPUT_ROOT   = process.env.BATCH_OUTPUT_ROOT || '/home/rahul/Stqc-Ems-Backend/batch_output';

const FAMILY_CODES = { SECOS: 0, AUGEN: 1, '4GBDP': 2, WFBDP: 3 };

const kmsClient = new KeyManagementServiceClient();
function kmsKeyVersionPath() {
    return kmsClient.cryptoKeyVersionPath(PROJECT, REGION, KEYRING, KEY_NAME, KEY_VERSION);
}

// ── Helpers ──────────────────────────────────────────────────────────

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest(); }
function sha256Hex(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function sha256File(p) { return sha256Hex(fs.readFileSync(p)); }

/**
 * PEM cert → DER bytes.
 * Plain base64 decode of the PEM payload — no ASN.1 parsing, so this works
 * for ANY cert algorithm (RSA, EC, Ed25519). node-forge can't parse EC
 * pubkeys, so we avoid it for cert ↔ DER conversions.
 */
function pemCertToDer(pemString) {
    const b64 = pemString
        .replace(/-----BEGIN CERTIFICATE-----/g, '')
        .replace(/-----END CERTIFICATE-----/g, '')
        .replace(/\s+/g, '');
    return Buffer.from(b64, 'base64');
}

/**
 * Build the 16-byte otp.bin for one device.
 * Layout (LE uint32 × 4):
 *   [0]  reserved(8) | serial(20) | family_code(4)
 *   [1..3] sha256(rootCA.der)[0:12]
 */
function buildOtp(serial, family, rootCaSha256) {
    const familyCode = FAMILY_CODES[family];
    if (familyCode === undefined) throw new Error(`unknown family: ${family}`);
    if (serial === 0 || serial > 0xFFFFF) throw new Error(`serial ${serial} out of 20-bit range`);

    const encoded = ((serial & 0xFFFFF) << 4) | (familyCode & 0xF);
    const buf = Buffer.alloc(16);
    buf.writeUInt32LE(encoded, 0);

    // Pack rootCA[0..11] as 3 LITTLE-ENDIAN uint32s (matches gen_otp.py's
    // `struct.pack("<IIII", ...)`). The on-device verifier (otp_provision.c)
    // reads `user_custom[1..3]` as ARM uint32s, so the bytes on flash are
    // the little-endian representation of each 4-byte chunk interpreted as
    // a big-endian uint32 (same convention as the hex string display).
    //
    // SHA-256 bytes : 44 EA C1 47 53 38 51 46 97 1F 2B C3 ...
    //   → BE uint32 : 0x44EAC147   0x53385146   0x971F2BC3
    //   → LE bytes  : 47 C1 EA 44  46 51 38 53  C3 2B 1F 97
    buf.writeUInt32LE(rootCaSha256.readUInt32BE(0), 4);
    buf.writeUInt32LE(rootCaSha256.readUInt32BE(4), 8);
    buf.writeUInt32LE(rootCaSha256.readUInt32BE(8), 12);
    return buf;
}

/** Recursive copy (mirrors `cp -r src/. dst/`). */
function copyDir(src, dst) {
    fs.mkdirSync(dst, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        const sp = path.join(src, entry.name);
        const dp = path.join(dst, entry.name);
        if (entry.isDirectory()) copyDir(sp, dp);
        else if (entry.isFile()) fs.copyFileSync(sp, dp);
    }
}

/**
 * HSM-sign a buffer using firmware-signing-key-raw via @google-cloud/kms.
 *
 * The "raw" key requires the caller to supply a pre-built DigestInfo (PKCS#1
 * v1.5). For SHA-256 the DigestInfo is:
 *   30 31 30 0D 06 09 60 86 48 01 65 03 04 02 01 05 00 04 20 || <32-byte hash>
 *
 * Result: 256-byte raw RSA-2048 PKCS#1 v1.5 signature — same shape that
 * `sign_firmware_algo.sh` produces, so device-side verifiers don't change.
 */
async function hsmSignSha256(messageBuf) {
    const digest = sha256(messageBuf);                                    // 32 bytes
    const digestInfoPrefix = Buffer.from(
        '3031300d060960864801650304020105000420', 'hex'                   // SHA-256 PKCS#1 v1.5 prefix
    );
    const digestInfo = Buffer.concat([digestInfoPrefix, digest]);          // 51 bytes

    const [resp] = await kmsClient.asymmetricSign({
        name: kmsKeyVersionPath(),
        data: digestInfo,
    });

    if (!resp.signature || resp.signature.length !== 256) {
        throw new Error(`unexpected signature length: ${resp.signature && resp.signature.length}`);
    }
    return Buffer.from(resp.signature);
}

/** Copy pre-exported pubkey artefacts into the batch's keys/ dir. */
function bundlePubkey(workDir, log) {
    if (!fs.existsSync(PUBKEY_DIR)) {
        log(`WARN: PUBKEY_DIR not found (${PUBKEY_DIR}) — keys/ omitted from ZIP`);
        return;
    }
    const keysDir = path.join(workDir, 'keys');
    fs.mkdirSync(keysDir, { recursive: true });
    const v = KEY_VERSION;
    const pairs = [
        [`pubkey_v${v}.pem`,         'batch-sign-pubkey.pem'],
        [`pubkey_v${v}.der`,         'batch-sign-pubkey.der'],
        [`pubkey_modulus_v${v}.bin`, 'batch-sign-pubkey-modulus.bin'],
        [`pubkey_modulus_v${v}.hex`, 'batch-sign-pubkey-modulus.hex'],
        [`rotpk_v${v}.bin`,          'batch-sign-pubkey-rotpk.bin'],
        [`rotpk_v${v}.txt`,          'batch-sign-pubkey.sha224'],
        [`u-boot_pubkey_v${v}.dtb`,  'u-boot_pubkey.dtb'],
        [`u-boot_pubkey_v${v}.dts`,  'u-boot_pubkey.dts'],
    ];
    for (const [src, dst] of pairs) {
        const sp = path.join(PUBKEY_DIR, src);
        if (fs.existsSync(sp)) fs.copyFileSync(sp, path.join(keysDir, dst));
    }
    // SHA-256 fingerprint not pre-exported — compute locally from DER
    const derPath = path.join(keysDir, 'batch-sign-pubkey.der');
    if (fs.existsSync(derPath)) {
        fs.writeFileSync(path.join(keysDir, 'batch-sign-pubkey.sha256'),
                         sha256Hex(fs.readFileSync(derPath)) + '\n');
    }
    const sha224Path = path.join(keysDir, 'batch-sign-pubkey.sha224');
    if (fs.existsSync(sha224Path)) {
        log(`pubkey bundled from ${PUBKEY_DIR} (rotpk/sha224=${fs.readFileSync(sha224Path, 'utf8').trim()})`);
    }
}

// ── Public: generateBatch ────────────────────────────────────────────

/**
 * Run the entire batch generation flow synchronously. Caller is expected
 * to await this — the controller invokes it in the background after
 * returning 202 Accepted.
 */
async function generateBatch({
    batchId,
    productModel,
    family,
    firmware,
    count,
    serialStart,
    serialEnd,
    deviceIds,        // optional: pre-allocated IDs (controller already inserted to Mongo)
    macAssignment,    // optional: Map<deviceId, [hex, ...]> from macAllocator
    connectionType,   // 'Eth' | 'WIFI' | '4G' (for batch.json + mac.txt header)
    onLog,
}) {
    const log = (msg) => {
        const line = `[batchGen ${batchId}] ${msg}`;
        if (typeof onLog === 'function') onLog(line);
        console.log(line);
    };

    if (!batchId || !family || !firmware || !count || !serialStart || !serialEnd) {
        throw new Error('missing required arg(s) for generateBatch');
    }
    if (FAMILY_CODES[family] === undefined) throw new Error(`unknown family: ${family}`);
    if (serialEnd - serialStart + 1 !== count) {
        throw new Error(`range size (${serialEnd - serialStart + 1}) != count (${count})`);
    }

    // ── Workspace ─────────────────────────────────────────────────────
    fs.mkdirSync(BATCH_OUTPUT_ROOT, { recursive: true });
    const workDir = path.join(BATCH_OUTPUT_ROOT, batchId);
    fs.rmSync(workDir, { recursive: true, force: true });
    fs.mkdirSync(workDir, { recursive: true });
    fs.mkdirSync(path.join(workDir, 'devices'),  { recursive: true });
    fs.mkdirSync(path.join(workDir, 'ca'),       { recursive: true });
    fs.mkdirSync(path.join(workDir, 'firmware'), { recursive: true });

    log(`Starting batch: family=${family} model=${productModel} fw=${firmware} count=${count} range=${serialStart}-${serialEnd}`);

    // ── Copy CA material from disk (matches script) ──────────────────
    if (fs.existsSync(ROOT_CA_PEM)) {
        fs.copyFileSync(ROOT_CA_PEM, path.join(workDir, 'ca', 'root-ca.pem'));
    } else {
        throw new Error(`root CA PEM not found: ${ROOT_CA_PEM}`);
    }
    if (fs.existsSync(INTERMEDIATE_CA_PEM)) {
        fs.copyFileSync(INTERMEDIATE_CA_PEM, path.join(workDir, 'ca', 'intermediate-ca.pem'));
    }

    // ── Compute Root CA hash for OTP pin ─────────────────────────────
    const rootCaPem = fs.readFileSync(path.join(workDir, 'ca', 'root-ca.pem'), 'utf8');
    const rootCaDer = pemCertToDer(rootCaPem);
    const rootCaSha = sha256(rootCaDer);                                    // 32-byte buffer
    const rootCaHash12 = rootCaSha.subarray(0, 12).toString('hex').toUpperCase();
    log(`Root CA hash (truncated 96-bit): ${rootCaHash12}`);

    // ── Bundle pubkey ────────────────────────────────────────────────
    bundlePubkey(workDir, log);

    // ── Fetch firmware from GitHub Releases ──────────────────────────
    // `firmware` is a release tag (e.g. v6.2.50.0-dev). Downloads BOTH the .bin
    // (flashed by PPC / shown in UI) and .rom (kept as reference) into firmware/.
    const fwDownload = await firmwareSource.downloadFirmware(firmware, path.join(workDir, 'firmware'));
    log(`firmware ${firmware}: bin=${fwDownload.binName} rom=${fwDownload.romName}`);
    // firmware.sha256 manifest
    const fwLines = [];
    for (const f of fs.readdirSync(path.join(workDir, 'firmware'))) {
        if (f === 'firmware.sha256') continue;
        const p = path.join(workDir, 'firmware', f);
        if (fs.statSync(p).isFile()) {
            fwLines.push(`${sha256File(p)}  ${f}`);
        }
    }
    fs.writeFileSync(path.join(workDir, 'firmware', 'firmware.sha256'), fwLines.join('\n') + '\n');

    // ── Per-device loop ──────────────────────────────────────────────
    const provisionCfgLines = [];
    const finalDeviceIds = [];   // collected for batch.json manifest
    const deviceRecords = [];

    // Controller pre-allocates the device IDs (ATPL-NNNNNN-FAMILY) and inserts
    // them into Mongo before calling us. We use those verbatim — never
    // regenerate suffixes here, otherwise the ZIP and EMS DB would desync.
    const usePreAllocated = Array.isArray(deviceIds) && deviceIds.length === count;
    if (!usePreAllocated) {
        throw new Error(`generateBatch: deviceIds[] (length ${count}) must be passed in by the caller`);
    }
    log(`Using ${count} pre-allocated device IDs from controller.`);

    for (let i = 0; i < count; i++) {
        const serial = serialStart + i;
        const deviceId = deviceIds[i];
        const m = /^ATPL-(\d{6})-(SECOS|AUGEN|4GBDP|WFBDP)$/.exec(deviceId);
        if (!m) throw new Error(`device ID '${deviceId}' must match ATPL-NNNNNN-FAMILY`);
        const suffix = m[2];
        finalDeviceIds.push(deviceId);
        log(`[${i + 1}/${count}] ${deviceId}`);

        const devDir = path.join(workDir, 'devices', deviceId);
        fs.mkdirSync(devDir, { recursive: true });

        // 1. Issue cert via GCP CAS (no shell-out)
        const cert = await certIssuance.issueCertificate(deviceId);

        // Write cert files (parity with new_certficate.sh layout)
        fs.writeFileSync(path.join(devDir, `${deviceId}_key.pem`),        cert.keyPem,    { mode: 0o600 });
        fs.writeFileSync(path.join(devDir, `${deviceId}_cert.pem`),       cert.certPem);
        fs.writeFileSync(path.join(devDir, `${deviceId}_cert_chain.pem`), cert.certPem + (cert.chainPem ? '\n' + cert.chainPem : ''));
        fs.writeFileSync(path.join(devDir, `${deviceId}_cert_hash.txt`),  cert.certHash + '\n');
        // ca_chain.pem: just intermediate (matches original)
        if (cert.chainPem) fs.writeFileSync(path.join(devDir, 'ca_chain.pem'), cert.chainPem);

        // 2. OTP (16 bytes)
        fs.writeFileSync(path.join(devDir, 'otp.bin'), buildOtp(serial, family, rootCaSha));

        // 3. mac.txt — primary MAC + any secondary MACs assigned to this device.
        //    Format: one MAC per line, "TYPE COLON_FORMAT" (the station parses this).
        //      Eth   80:77:86:50:00:01
        //      WIFI  80:77:86:50:00:02
        //    Each line carries its OWN interface type, so a dual-interface device
        //    (Eth + WiFi) labels each MAC correctly. SHA256SUMS below covers this
        //    file, so the HSM signature includes the MAC assignment.
        //
        //    macAssignment entries are {type, mac(hex)} objects. Legacy callers
        //    may still pass bare hex strings — fall back to the batch connectionType.
        const macsForDevice = macAssignment instanceof Map ? (macAssignment.get(deviceId) || []) : [];
        if (macsForDevice.length) {
            const macLines = macsForDevice.map(entry => {
                const hex = typeof entry === 'string' ? entry : entry.mac;
                const type = typeof entry === 'string' ? (connectionType || 'Eth') : (entry.type || connectionType || 'Eth');
                const colon = [0, 2, 4, 6, 8, 10].map(i => hex.slice(i, i + 2)).join(':').toUpperCase();
                return `${type}\t${colon}`;
            });
            fs.writeFileSync(path.join(devDir, 'mac.txt'), macLines.join('\n') + '\n');
        }

        // 4. Handoff for provision_device.sh on station
        fs.writeFileSync(path.join(devDir, 'current_device.id'), deviceId + '\n');

        // 5. Append to batch-wide queue
        provisionCfgLines.push(deviceId);

        deviceRecords.push({
            deviceId,
            serial,
            suffix,
            certHash: cert.certHash,
            certGcpName: cert.certGcpName,
            certNotBefore: cert.notBefore,
            certNotAfter:  cert.notAfter,
            certSerialNumber: cert.serialNumber,
            macs: macsForDevice,
        });
    }

    fs.writeFileSync(path.join(workDir, 'provision.cfg'), provisionCfgLines.join('\n') + '\n');

    // ── batch.json manifest ─────────────────────────────────────────
    const familyCode = FAMILY_CODES[family];
    const manifest = {
        batchId,
        productModel,
        family,
        familyCode,
        firmware,
        connectionType: connectionType || null,
        count,
        serialStart,
        serialEnd,
        rootCaHash: { algorithm: 'SHA-256-truncated-96', hex: rootCaHash12 },
        createdAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
        deviceIds: finalDeviceIds,
    };
    fs.writeFileSync(path.join(workDir, 'batch.json'), JSON.stringify(manifest, null, 2));

    // ── SHA256SUMS over every relevant file ─────────────────────────
    const sumsLines = [];
    function walk(dir, rel = '.') {
        for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            const sp = path.join(dir, e.name);
            const sr = rel === '.' ? `./${e.name}` : `${rel}/${e.name}`;
            if (e.isDirectory()) walk(sp, sr);
            else if (e.isFile() && !e.name.startsWith('SHA256SUMS')) sumsLines.push(`${sha256File(sp)}  ${sr}`);
        }
    }
    walk(workDir);
    const sumsContent = sumsLines.join('\n') + '\n';
    fs.writeFileSync(path.join(workDir, 'SHA256SUMS'), sumsContent);

    // ── HSM-sign SHA256SUMS via @google-cloud/kms ────────────────────
    log(`HSM-signing SHA256SUMS with ${KEY_NAME} v${KEY_VERSION} via @google-cloud/kms`);
    const sig = await hsmSignSha256(Buffer.from(sumsContent, 'utf8'));
    fs.writeFileSync(path.join(workDir, 'SHA256SUMS.sig'), sig);

    // ── ZIP it ───────────────────────────────────────────────────────
    const zipPath = path.join(BATCH_OUTPUT_ROOT, `${batchId}.zip`);
    if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
    const zip = new AdmZip();
    function zipAdd(absPath, zipRel) {
        const stat = fs.statSync(absPath);
        if (stat.isDirectory()) {
            for (const e of fs.readdirSync(absPath)) zipAdd(path.join(absPath, e), zipRel ? `${zipRel}/${e}` : e);
        } else {
            zip.addFile(zipRel, fs.readFileSync(absPath));
        }
    }
    for (const top of ['batch.json', 'SHA256SUMS', 'SHA256SUMS.sig', 'provision.cfg', 'ca', 'firmware', 'devices']) {
        const p = path.join(workDir, top);
        if (fs.existsSync(p)) zipAdd(p, top);
    }
    if (fs.existsSync(path.join(workDir, 'keys'))) zipAdd(path.join(workDir, 'keys'), 'keys');
    zip.writeZip(zipPath);

    const zipSha256 = sha256File(zipPath);
    fs.writeFileSync(`${zipPath}.sha256`, `${zipSha256}  ${path.basename(zipPath)}\n`);
    const zipSizeBytes = fs.statSync(zipPath).size;
    log(`Done. ZIP=${zipPath} size=${zipSizeBytes} sha256=${zipSha256}`);

    return {
        ok: true,
        batchId,
        zipPath,
        zipSha256,
        zipSizeBytes,
        rootCaHash: rootCaHash12,
        devices: deviceRecords,
    };
}

module.exports = { generateBatch };
