/*
 * services/macAllocator.js — pull MACs from mac_pool for a batch.
 *
 * Two operations:
 *   allocateForBatch({ batchId, deviceIds, connectionType, macsPerDevice })
 *     Atomically claims (deviceIds.length * macsPerDevice) MACs from
 *     mac_pool of the requested type, flipping status available → assigned
 *     and stamping (iwon=batchId, deviceId).
 *     Returns Map<deviceId, [macHex, ...]>.
 *     All-or-nothing: any failure releases the MACs already claimed.
 *
 *   releaseForBatch(batchId)
 *     Flips assigned → available for every MAC stamped with iwon=batchId.
 *     Used when batch creation fails partway through, or when an admin
 *     deletes a batch that hasn't been burned yet.
 *
 * Allocator NEVER touches MACs in status 'burned' — those are fleet truth
 * and only the verification flow can move a MAC there.
 */

const MacPool = require('../models/macPool');

// Interfaces that actually consume a MAC from the pool. 4G/cellular is
// identified by SIM/IMEI, not a MAC, so a 4G interface is never allocated one —
// e.g. a model that supports both 4G and Eth gets only an Eth MAC.
const MAC_BEARING_TYPES = ['Eth', 'WIFI'];

// Given a SKU's connectionTypes, return just the ones that need a MAC, in a
// stable order (Eth before WIFI). Drops 4G. Returns [] if the model has no
// MAC-bearing interface (caller decides how to handle that edge case).
function macBearingTypes(connectionTypes) {
    const set = new Set(Array.isArray(connectionTypes) ? connectionTypes : []);
    return MAC_BEARING_TYPES.filter(t => set.has(t));
}

// Map a single free-form connection string (as ERP/operator picks it) to the
// full interface set for that device — the single source of truth for both the
// ERP bridge and the manual create form. A WiFi camera also carries Ethernet
// (Eth = HwMac, WiFi = WifiMac); a 4G camera carries Ethernet (4G gets no MAC).
//   poe/eth/lan/rj45 → ['Eth']
//   wifi/wireless/wlan → ['Eth','WIFI']
//   4g/lte/cellular/gsm/gprs → ['4G','Eth']
// Returns null for an unrecognized connection.
const CONNECTION_TO_TYPES = {
    poe: ['Eth'], eth: ['Eth'], ethernet: ['Eth'], lan: ['Eth'], rj45: ['Eth'],
    wifi: ['Eth', 'WIFI'], wireless: ['Eth', 'WIFI'], wlan: ['Eth', 'WIFI'],
    '4g': ['4G', 'Eth'], lte: ['4G', 'Eth'], cellular: ['4G', 'Eth'], gsm: ['4G', 'Eth'], gprs: ['4G', 'Eth'],
};
function connectionToTypes(raw) {
    const k = String(raw || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    return CONNECTION_TO_TYPES[k] || null;
}

// Format hex (12 char) → "80:77:86:50:00:01" for display / mac.txt
function formatMac(hex12) {
    if (!hex12 || hex12.length !== 12) return null;
    return [0, 2, 4, 6, 8, 10].map(i => hex12.slice(i, i + 2)).join(':').toUpperCase();
}

async function pickOne(connectionType) {
    // Atomic claim — race-safe across concurrent batches.
    // Prefer rows already typed for this connection. Fall back to typeless
    // (type=null) rows — they were imported without a type marker and are
    // claimable for any type at allocation time. We stamp the requested
    // type on them as part of the claim.
    let claimed = await MacPool.findOneAndUpdate(
        { status: 'available', type: connectionType },
        { $set: { status: 'assigned', assignedAt: new Date() } },
        { new: true }
    );
    if (!claimed) {
        claimed = await MacPool.findOneAndUpdate(
            { status: 'available', type: null },
            { $set: { status: 'assigned', type: connectionType, assignedAt: new Date() } },
            { new: true }
        );
    }
    return claimed;
}

async function allocateForBatch({ batchId, deviceIds, connectionType, macsPerDevice = 1 }) {
    if (!batchId || !Array.isArray(deviceIds) || !deviceIds.length) {
        throw new Error('allocateForBatch: batchId and deviceIds[] required');
    }
    if (!['Eth', 'WIFI', '4G'].includes(connectionType)) {
        throw new Error(`allocateForBatch: unsupported connectionType '${connectionType}'`);
    }
    const total = deviceIds.length * macsPerDevice;

    // Cheap pre-flight so we 409 fast instead of claiming half the pool first.
    // Counts both typed-for-this-connection rows AND typeless rows (which the
    // allocator can claim for any type at pickOne time).
    const avail = await MacPool.countDocuments({
        status: 'available',
        $or: [{ type: connectionType }, { type: null }],
    });
    if (avail < total) {
        const err = new Error(
            `Insufficient ${connectionType} MACs in pool: need ${total}, have ${avail}`
        );
        err.code = 'MAC_POOL_EXHAUSTED';
        err.statusCode = 409;
        throw err;
    }

    const assignment = new Map();   // deviceId → [hex, ...]
    const claimedHexes = [];        // flat list for rollback

    try {
        for (const deviceId of deviceIds) {
            const macs = [];
            for (let i = 0; i < macsPerDevice; i++) {
                const row = await pickOne(connectionType);
                if (!row) {
                    // Race: another batch drained the pool between countDocuments
                    // and now. Roll back everything we've claimed in this call.
                    const err = new Error(
                        `Pool drained mid-allocation (claimed ${claimedHexes.length}/${total})`
                    );
                    err.code = 'MAC_POOL_RACE';
                    err.statusCode = 409;
                    throw err;
                }
                macs.push(row.mac);
                claimedHexes.push(row.mac);
            }
            assignment.set(deviceId, macs);

            // Now stamp deviceId on each claimed MAC for this device
            await MacPool.updateMany(
                { mac: { $in: macs } },
                { $set: { deviceId, iwon: batchId } }
            );
        }
        return assignment;
    } catch (e) {
        // Rollback — only the rows we just claimed in this call
        if (claimedHexes.length) {
            await MacPool.updateMany(
                { mac: { $in: claimedHexes } },
                {
                    $set: { status: 'available' },
                    $unset: { deviceId: '', iwon: '', assignedAt: '' },
                }
            );
        }
        throw e;
    }
}

// Allocate one MAC of EACH requested type for every device. Used for
// dual-interface SKUs (e.g. Eth+WiFi) where a single device needs a separate
// MAC per interface, kept distinct so the station can burn each to the right
// NIC. `types` is the SKU's full connectionTypes list (e.g. ['Eth','WIFI']);
// pass a single-element list for ordinary one-interface devices.
//
// Returns Map<deviceId, [{ type, mac }]>  (mac = 12-char hex, un-formatted).
// All-or-nothing: any failure releases every MAC claimed in this call.
async function allocateMultiTypeForBatch({ batchId, deviceIds, types }) {
    if (!batchId || !Array.isArray(deviceIds) || !deviceIds.length) {
        throw new Error('allocateMultiTypeForBatch: batchId and deviceIds[] required');
    }
    if (!Array.isArray(types) || !types.length) {
        throw new Error('allocateMultiTypeForBatch: types[] required');
    }
    for (const t of types) {
        if (!['Eth', 'WIFI', '4G'].includes(t)) {
            throw new Error(`allocateMultiTypeForBatch: unsupported type '${t}'`);
        }
    }

    // Pre-flight per type so we 409 fast. Each type draws from its typed rows
    // PLUS the shared typeless pool, so a device needing both Eth and WiFi pulls
    // each from that same fungible pool — count per type independently against
    // the per-device demand. (See macAllocator pickOne fallback behavior.)
    const perType = {};
    for (const t of types) perType[t] = (perType[t] || 0) + 1;
    const need = {};
    for (const t of types) need[t] = deviceIds.length;   // one of each type per device
    for (const t of Object.keys(need)) {
        const avail = await MacPool.countDocuments({
            status: 'available',
            $or: [{ type: t }, { type: null }],
        });
        if (avail < need[t]) {
            const err = new Error(`Insufficient ${t} MACs in pool: need ${need[t]}, have ${avail}`);
            err.code = 'MAC_POOL_EXHAUSTED';
            err.statusCode = 409;
            throw err;
        }
    }

    const assignment = new Map();   // deviceId → [{type, mac}]
    const claimedHexes = [];        // flat list for rollback

    try {
        for (const deviceId of deviceIds) {
            const entries = [];
            const hexes = [];
            for (const t of types) {
                const row = await pickOne(t);
                if (!row) {
                    const err = new Error(
                        `Pool drained mid-allocation (claimed ${claimedHexes.length})`
                    );
                    err.code = 'MAC_POOL_RACE';
                    err.statusCode = 409;
                    throw err;
                }
                entries.push({ type: t, mac: row.mac });
                hexes.push(row.mac);
                claimedHexes.push(row.mac);
            }
            assignment.set(deviceId, entries);

            // Stamp deviceId + iwon on every MAC claimed for this device.
            await MacPool.updateMany(
                { mac: { $in: hexes } },
                { $set: { deviceId, iwon: batchId } }
            );
        }
        return assignment;
    } catch (e) {
        if (claimedHexes.length) {
            await MacPool.updateMany(
                { mac: { $in: claimedHexes } },
                {
                    $set: { status: 'available' },
                    $unset: { deviceId: '', iwon: '', assignedAt: '' },
                }
            );
        }
        throw e;
    }
}

async function releaseForBatch(batchId) {
    // Only releases 'assigned' rows — once a MAC is 'burned' it stays put.
    const r = await MacPool.updateMany(
        { iwon: batchId, status: 'assigned' },
        {
            $set: { status: 'available' },
            $unset: { deviceId: '', iwon: '', assignedAt: '' },
        }
    );
    return r.modifiedCount || 0;
}

async function markBurnedForDevice(deviceId, mac) {
    // Called by the verification flow when station reports the MAC was
    // actually written to the device. Idempotent — re-running on a row
    // already 'burned' is a no-op.
    return MacPool.updateOne(
        { mac, deviceId, status: { $in: ['assigned', 'burned'] } },
        { $set: { status: 'burned', burnedAt: new Date() } }
    );
}

module.exports = {
    allocateForBatch,
    allocateMultiTypeForBatch,
    releaseForBatch,
    markBurnedForDevice,
    formatMac,
    macBearingTypes,
    connectionToTypes,
    MAC_BEARING_TYPES,
};
