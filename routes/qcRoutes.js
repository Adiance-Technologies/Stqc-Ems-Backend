const express = require('express');
const { ingestReport, listReports, getReport } = require('../controllers/qcController');
const { qcMtlsOnly } = require('../middleware/qcAuth');
const { isAuthenticatedUser, authorizeRoles } = require('../middleware/authMiddleware');

const router = express.Router();

// ═══════════════════════════════════════════════════════════════
//  External QC Report API
//  The external QC App pushes each assembled camera's QC result
//  here over mutual TLS; EMS stores + tracks it as a QC report.
// ═══════════════════════════════════════════════════════════════

// ── External QC App ingest (strict mTLS — client cert required) ──
router.post('/report', qcMtlsOnly, ingestReport);

// ── Dashboard (admin cookie auth) ─────────────────────────────
router.get('/reports',     isAuthenticatedUser, authorizeRoles('admin'), listReports);
router.get('/reports/:id', isAuthenticatedUser, authorizeRoles('admin'), getReport);

module.exports = router;
