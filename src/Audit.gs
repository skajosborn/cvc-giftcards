/**
 * Append-only operational audit. Financial amounts stay in TRANSACTIONS.
 * Audit details never store passwords, ID tokens, raw QR tokens, or
 * customer email addresses.
 */

var RH_AUDIT_FORBIDDEN_KEYS = {
  qr_token: true,
  idToken: true,
  id_token: true,
  password: true,
  authorization: true,
  metadata_json: true,
  customer_email: true,
  token: true,
  signature: true
};

function rhAudit_(ctx, entry) {
  var details = rhRedactAuditDetails_(entry.details || {});
  return rhAppendRecord_(ctx, RH_SHEET.AUDIT_LOG, {
    audit_id: rhNewId_(),
    employee_id: entry.employee_id || '',
    action: entry.action,
    entity_type: entry.entity_type,
    entity_id: entry.entity_id || '',
    details: JSON.stringify(details),
    timestamp: rhNowIso_()
  });
}

function rhRedactAuditDetails_(details) {
  if (!details || typeof details !== 'object') return {};
  var clean = {};
  var keys = Object.keys(details);
  for (var i = 0; i < keys.length; i++) {
    var key = keys[i];
    if (RH_AUDIT_FORBIDDEN_KEYS[key]) continue;
    var value = details[key];
    if (typeof value === 'string' && value.indexOf(RH_QR_PAYLOAD_PREFIX) === 0) continue;
    if (value && typeof value === 'object') {
      clean[key] = rhRedactAuditDetails_(value);
    } else {
      clean[key] = value;
    }
  }
  return clean;
}

function rhTryAuditFailure_(action, employeeId, details) {
  try {
    rhWithLock_(function (ctx) {
      rhAudit_(ctx, {
        employee_id: employeeId || '',
        action: action,
        entity_type: 'AUTH',
        entity_id: employeeId || '',
        details: details || {}
      });
    });
  } catch (err) {
    // The access decision still stands when the audit write cannot be stored.
  }
}
