/*
 * middleware/qcAuth.js — strict mTLS gate for the QC ingest endpoint.
 *
 * The QC App pushes results over an mTLS connection. nginx terminates TLS with
 * `ssl_verify_client on` and forwards the verification verdict in the
 * `X-Client-Cert-Verified` header (the ems.devices vhost already sets this; a
 * dedicated QC/etaems vhost must do the same). We require that verdict to be
 * SUCCESS — no client cert, no ingest.
 *
 * Note: a direct hit to :5000 (bypassing nginx) has no such header → rejected,
 * which is the intended strict behavior.
 */

module.exports.qcMtlsOnly = (req, res, next) => {
    const verified = req.headers['x-client-cert-verified'];
    if (verified === 'SUCCESS') {
        req.qcClientDN = req.headers['x-client-dn'] || null;
        return next();
    }
    return res.status(403).json({
        success: false,
        message: 'mTLS client certificate required (X-Client-Cert-Verified != SUCCESS)',
    });
};
