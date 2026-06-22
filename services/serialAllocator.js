/*
 * services/serialAllocator.js — hand out contiguous, non-overlapping device
 * serial ranges per family for auto-created (ERP) batches.
 *
 * The manual UI flow lets the operator type an explicit ATPL-NNNNNN range.
 * ERP batches carry no range, so we allocate one here from a per-family
 * counter (models/provisionCounter.js) using an atomic $inc so concurrent
 * batches never collide.
 *
 *   allocateRange(family, count) -> { serialStart, serialEnd,
 *                                     startDeviceId, endDeviceId }
 *
 * On first use for a family the counter is seeded above any serials the manual
 * flow may already have written, so the two paths can't overlap.
 */

const ProvisionCounter = require('../models/provisionCounter');
const ProvisionedDevice = require('../models/provisionedDevice');

const SERIAL_MAX = 0xFFFFF;            // 20-bit serial space (1,048,575)
const DEFAULT_FLOOR = 900000;          // matches provisionCounter schema default

function fmtDeviceSerial(serial) {
    return `ATPL-${String(serial).padStart(6, '0')}`;
}

async function ensureSeeded(family) {
    const existing = await ProvisionCounter.findOne({ family }).lean();
    if (existing) return;
    // Seed above the highest serial already used by the manual path for this
    // family so auto-allocation never reuses an operator-chosen serial.
    const highest = await ProvisionedDevice.findOne({ family })
        .sort('-serialNumber')
        .select('serialNumber')
        .lean();
    const seed = Math.max(DEFAULT_FLOOR, highest ? highest.serialNumber : 0);
    // upsert-without-overwrite: only create if still absent (idempotent under race)
    await ProvisionCounter.updateOne(
        { family },
        { $setOnInsert: { lastSerial: seed } },
        { upsert: true }
    );
}

async function allocateRange(family, count) {
    const qty = parseInt(count, 10);
    if (!['SECOS', 'AUGEN', '4GBDP', 'WFBDP'].includes(family)) {
        throw new Error(`serialAllocator: unknown family '${family}'`);
    }
    if (!Number.isFinite(qty) || qty < 1) {
        throw new Error('serialAllocator: count must be >= 1');
    }

    await ensureSeeded(family);

    // Atomically reserve `qty` serials. lastSerial advances by qty; the reserved
    // block is (prev, prev+qty] i.e. [prev+1 .. prev+qty].
    const updated = await ProvisionCounter.findOneAndUpdate(
        { family },
        { $inc: { lastSerial: qty } },
        { new: true }
    );
    const serialEnd = updated.lastSerial;
    const serialStart = serialEnd - qty + 1;

    if (serialEnd > SERIAL_MAX) {
        throw new Error(
            `serialAllocator: family ${family} exhausted the 20-bit serial space ` +
            `(would reach ${serialEnd} > ${SERIAL_MAX})`
        );
    }

    // Defensive overlap check — should never fire if the counter is seeded
    // correctly, but a misconfigured manual batch could have claimed into this
    // range. Surface it instead of silently double-assigning a serial.
    const overlap = await ProvisionedDevice.findOne({
        family,
        serialNumber: { $gte: serialStart, $lte: serialEnd },
    }).select('deviceId').lean();
    if (overlap) {
        throw new Error(
            `serialAllocator: allocated range ${serialStart}-${serialEnd} for ${family} ` +
            `overlaps existing device ${overlap.deviceId} — counter is behind reality`
        );
    }

    return {
        serialStart,
        serialEnd,
        startDeviceId: fmtDeviceSerial(serialStart),
        endDeviceId: fmtDeviceSerial(serialEnd),
    };
}

module.exports = { allocateRange };
