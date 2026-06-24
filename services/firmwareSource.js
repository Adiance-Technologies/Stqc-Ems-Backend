/*
 * services/firmwareSource.js — firmware comes from GitHub Releases of
 * Adiance-STQC/arcisai-app (NOT a local directory). Each release tag is a
 * firmware version carrying one .bin (signed full-NOR image, shown in the UI +
 * flashed by PPC) and one .rom (kept in the batch ZIP as reference).
 *
 * Public surface:
 *   listReleases()            → [{ version, publishedAt, bin:{name,id,size}, rom:{...} }]
 *   resolveRelease(tag)       → the matching entry (throws 404 if missing)
 *   downloadFirmware(tag, dir)→ ensures dir has BOTH .bin and .rom; returns
 *                               { binPath, romPath, binName, romName }. Cached
 *                               under FIRMWARE_CACHE_DIR so each version is
 *                               fetched from GitHub only once.
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');

const REPO = process.env.FIRMWARE_GH_REPO || 'Adiance-STQC/arcisai-app';
const TOKEN = process.env.FIRMWARE_GH_TOKEN || '';
const CACHE_DIR = process.env.FIRMWARE_CACHE_DIR || path.join(__dirname, '..', 'firmware_cache');
const API = 'https://api.github.com';

function authHeaders(extra = {}) {
    const h = { 'User-Agent': 'arcisai-ems', Accept: 'application/vnd.github+json', ...extra };
    if (TOKEN) h.Authorization = `Bearer ${TOKEN}`;
    return h;
}

// Pick the single .bin / .rom firmware asset from a release's asset list.
function pickFirmwareAssets(assets) {
    const bin = assets.find(a => /\.bin$/i.test(a.name));
    const rom = assets.find(a => /\.rom$/i.test(a.name));
    return { bin, rom };
}

// ── listReleases ──────────────────────────────────────────────
// Newest-first list of releases that carry both a .bin and a .rom. Cached for a
// short TTL so repeated dropdown loads don't hammer the GitHub API.
let _cache = { at: 0, data: null };
const LIST_TTL_MS = 60 * 1000;

async function listReleases({ force = false } = {}) {
    if (!force && _cache.data && (Date.now() - _cache.at) < LIST_TTL_MS) {
        return _cache.data;
    }
    if (!TOKEN) throw new Error('FIRMWARE_GH_TOKEN not configured — cannot list firmware from GitHub');

    const out = [];
    for (let page = 1; page <= 10; page++) {
        const { data } = await axios.get(`${API}/repos/${REPO}/releases`, {
            headers: authHeaders(),
            params: { per_page: 100, page },
            timeout: 20000,
        });
        if (!Array.isArray(data) || !data.length) break;
        for (const r of data) {
            if (r.draft) continue;
            const { bin, rom } = pickFirmwareAssets(r.assets || []);
            if (!bin || !rom) continue;   // only releases with a firmware pair
            out.push({
                version: r.tag_name,
                name: r.name || r.tag_name,
                publishedAt: r.published_at,
                prerelease: r.prerelease,
                bin: { name: bin.name, id: bin.id, size: bin.size },
                rom: { name: rom.name, id: rom.id, size: rom.size },
            });
        }
        if (data.length < 100) break;
    }
    // GitHub returns releases newest-first already; keep that order.
    _cache = { at: Date.now(), data: out };
    return out;
}

async function resolveRelease(tag) {
    if (!tag) { const e = new Error('firmware version (release tag) required'); e.statusCode = 400; throw e; }
    let rel = (await listReleases()).find(r => r.version === tag);
    if (!rel) {
        // Cache might be stale (a brand-new release) — force a refresh once.
        rel = (await listReleases({ force: true })).find(r => r.version === tag);
    }
    if (!rel) {
        const e = new Error(`Firmware release '${tag}' not found in ${REPO} (or missing a .bin/.rom asset)`);
        e.statusCode = 400;
        throw e;
    }
    return rel;
}

// Download one release asset (private repo) to destPath via the asset API URL.
async function downloadAsset(assetId, destPath) {
    const resp = await axios.get(`${API}/repos/${REPO}/releases/assets/${assetId}`, {
        headers: authHeaders({ Accept: 'application/octet-stream' }),
        responseType: 'arraybuffer',
        maxRedirects: 5,
        timeout: 180000,
    });
    fs.writeFileSync(destPath, Buffer.from(resp.data));
}

// ── downloadFirmware ──────────────────────────────────────────
// Ensure CACHE_DIR/<tag>/ holds both assets (download once), then copy them into
// destDir. Returns the per-file paths/names.
async function downloadFirmware(tag, destDir) {
    const rel = await resolveRelease(tag);
    const cacheTagDir = path.join(CACHE_DIR, tag);
    fs.mkdirSync(cacheTagDir, { recursive: true });
    fs.mkdirSync(destDir, { recursive: true });

    const cachedBin = path.join(cacheTagDir, rel.bin.name);
    const cachedRom = path.join(cacheTagDir, rel.rom.name);

    if (!fs.existsSync(cachedBin) || fs.statSync(cachedBin).size !== rel.bin.size) {
        await downloadAsset(rel.bin.id, cachedBin);
    }
    if (!fs.existsSync(cachedRom) || fs.statSync(cachedRom).size !== rel.rom.size) {
        await downloadAsset(rel.rom.id, cachedRom);
    }

    const binPath = path.join(destDir, rel.bin.name);
    const romPath = path.join(destDir, rel.rom.name);
    fs.copyFileSync(cachedBin, binPath);
    fs.copyFileSync(cachedRom, romPath);

    return { binPath, romPath, binName: rel.bin.name, romName: rel.rom.name };
}

module.exports = { listReleases, resolveRelease, downloadFirmware };
