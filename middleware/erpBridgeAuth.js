/*
 * middleware/erpBridgeAuth.js
 *
 * Service-to-service auth for the ERP → EMS batch bridge (POST /api/createBatch).
 * The ERP (Adiance-Erp-ST) sends:
 *
 *   Authorization: Bearer <ERP_BRIDGE_TOKEN>
 *
 * The SAME pre-shared token is used in both directions — EMS sends it back to
 * ERP's POST /api/request/batch-done when a batch finishes (see
 * controllers/erpBatchController.js → notifyErpBatchDone). Mirrors the ERP
 * side's middleware/etaemsAuth.js exactly so the contract stays symmetric.
 *
 * Refuse (503) when the token isn't configured rather than letting an empty
 * comparison accept any caller.
 */

const crypto = require('crypto');

// Constant-time compare to avoid leaking token length/content via timing.
function safeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    if (ab.length !== bb.length) return false;
    return crypto.timingSafeEqual(ab, bb);
}

module.exports.erpBridgeAuth = (req, res, next) => {
    const expected = process.env.ERP_BRIDGE_TOKEN;
    if (!expected || expected.length < 32) {
        return res.status(503).json({
            success: false,
            message: 'ERP bridge not configured on this server (ERP_BRIDGE_TOKEN missing)',
        });
    }

    const header = req.headers.authorization || '';
    const m = /^Bearer\s+(.+)$/i.exec(header);
    const presented = m ? m[1].trim() : '';

    if (!safeEqual(presented, expected)) {
        return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    req.isErp = true;
    next();
};
