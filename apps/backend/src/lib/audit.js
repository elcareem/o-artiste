/**
 * Audit trail — docs/07-ADMIN-CONFIG.md §5.
 *
 * Two ways to write, because there are two kinds of event and they have
 * opposite failure requirements.
 */

const prisma = require('./prisma');

/**
 * Writes an audit row that MUST succeed, inside the caller's transaction.
 *
 * For configuration changes, dispute resolutions and manual money movements:
 * if the audit row cannot be written, the change it records must not happen
 * either. Pass the transaction client so both commit or neither does.
 */
function recordAudit(tx, entry) {
  return tx.auditLog.create({ data: entry });
}

/**
 * Writes a security event, best effort, never throwing.
 *
 * For rejected privilege escalation and similar: the rejection has already
 * happened and is correct. A failure to write the log must not turn a clean
 * 403 into a 500 — that would let an attacker suppress their own audit trail
 * by breaking the logger.
 */
function recordAuditSafe(entry) {
  prisma.auditLog.create({ data: entry }).catch((err) => {
    console.error('[audit] failed to record event', entry.action, err.message);
  });
}

/** Request context for events with no authenticated actor. */
function actorContext(req) {
  return {
    actorIp: req.ip || req.socket?.remoteAddress || null,
    actorUserAgent: req.get?.('user-agent') || null,
  };
}

module.exports = { recordAudit, recordAuditSafe, actorContext };
