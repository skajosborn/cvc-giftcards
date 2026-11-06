/**
 * Request validation. Monetary amounts are integer cents and are rejected
 * when they arrive as strings, floats, or values outside the configured cap.
 */

function rhFail_(code, message, details) {
  var err = new Error(message);
  err.name = 'AppError';
  err.code = code;
  if (details) err.details = details;
  return err;
}

function rhRequireObject_(value, name) {
  if (!value || typeof value !== 'object' || Object.prototype.toString.call(value) === '[object Array]') {
    throw rhFail_('VALIDATION', name + ' is required');
  }
  return value;
}

function rhRequireEnum_(value, allowed, name) {
  if (allowed.indexOf(value) === -1) {
    throw rhFail_('VALIDATION', name + ' is invalid');
  }
  return value;
}

function rhRequireText_(value, name, min, max) {
  if (typeof value !== 'string') throw rhFail_('VALIDATION', name + ' must be text');
  var trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max) {
    throw rhFail_('VALIDATION', name + ' must be between ' + min + ' and ' + max + ' characters');
  }
  return trimmed;
}

function rhOptionalText_(value, name, max) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string') throw rhFail_('VALIDATION', name + ' must be text');
  var trimmed = value.trim();
  if (trimmed.length > max) throw rhFail_('VALIDATION', name + ' is too long');
  return trimmed;
}

function rhOptionalNotes_(value) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string') throw rhFail_('VALIDATION', 'notes must be text');
  var cleaned = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim();
  if (cleaned.length > 500) throw rhFail_('VALIDATION', 'notes must be 500 characters or fewer');
  return cleaned;
}

function rhRequireNotes_(value) {
  var notes = rhOptionalNotes_(value);
  if (notes.length < 10) {
    throw rhFail_('VALIDATION', 'notes must explain the correction in at least 10 characters');
  }
  return notes;
}

function rhOptionalReference_(value) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string') throw rhFail_('VALIDATION', 'registerReference must be text');
  var trimmed = value.trim();
  if (!/^[A-Za-z0-9._:-]{1,64}$/.test(trimmed)) {
    throw rhFail_('VALIDATION', 'registerReference contains unsupported characters');
  }
  return trimmed;
}

function rhRequireIdempotencyKey_(value) {
  if (typeof value !== 'string') throw rhFail_('VALIDATION', 'idempotencyKey is required');
  var key = value.trim();
  if (!/^[A-Za-z0-9._:-]{12,128}$/.test(key)) {
    throw rhFail_(
      'VALIDATION',
      'idempotencyKey must be 12 to 128 characters and use only letters, numbers, and . _ : -'
    );
  }
  return key;
}

function rhRequireUuid_(value, name) {
  if (typeof value !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw rhFail_('VALIDATION', name + ' must be a UUID');
  }
  return value.toLowerCase();
}

function rhNormalizeEmail_(value) {
  if (typeof value !== 'string') throw rhFail_('VALIDATION', 'email must be text');
  var email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw rhFail_('VALIDATION', 'email is invalid');
  }
  return email;
}

function rhOptionalEmail_(value) {
  if (value === undefined || value === null || value === '') return '';
  return rhNormalizeEmail_(value);
}

function rhRequireBatchCount_(value) {
  if (typeof value !== 'number' || !isFinite(value) || Math.floor(value) !== value ||
      value < 1 || value > RH_BLANK_BATCH_LIMIT) {
    throw rhFail_('VALIDATION', 'count must be an integer from 1 to ' + RH_BLANK_BATCH_LIMIT);
  }
  return value;
}

function rhRequireCents_(value, name) {
  if (typeof value !== 'number' || !isFinite(value) || Math.floor(value) !== value) {
    throw rhFail_('VALIDATION', name + ' must be an integer number of cents');
  }
  if (value <= 0) throw rhFail_('VALIDATION', name + ' must be greater than zero');
  if (value > rhMaxSingleAmount_()) {
    throw rhFail_('VALIDATION', name + ' exceeds the maximum allowed amount');
  }
  return value;
}

function rhRequireBoolean_(value, name) {
  if (typeof value !== 'boolean') throw rhFail_('VALIDATION', name + ' must be true or false');
  return value;
}

function rhAddCents_(a, b) {
  if (typeof a !== 'number' || typeof b !== 'number' || !isFinite(a) || !isFinite(b) ||
      Math.floor(a) !== a || Math.floor(b) !== b) {
    throw rhFail_('VALIDATION', 'Money math requires integer cents');
  }
  var sum = a + b;
  if (!isFinite(sum) || Math.floor(sum) !== sum || Math.abs(sum) > 9007199254740991) {
    throw rhFail_('VALIDATION', 'Money math exceeded the safe integer range');
  }
  if (sum < 0) throw rhFail_('INSUFFICIENT_FUNDS', 'The gift card balance cannot go negative');
  return sum;
}

function rhExactSum_(a, b) {
  if (typeof a !== 'number' || typeof b !== 'number' || Math.floor(a) !== a || Math.floor(b) !== b) {
    throw rhFail_('RECONCILIATION', 'Ledger contains a non-integer amount');
  }
  var sum = a + b;
  if (!isFinite(sum) || Math.floor(sum) !== sum || Math.abs(sum) > 9007199254740991) {
    throw rhFail_('RECONCILIATION', 'Ledger totals are outside the safe integer range');
  }
  return sum;
}

function rhAssertBalanceCap_(balance) {
  if (balance > rhMaxBalance_()) {
    throw rhFail_('VALIDATION', 'The resulting balance exceeds the maximum allowed balance');
  }
  return balance;
}

function rhCanonical_(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Object.prototype.toString.call(value) === '[object Array]') {
    var items = [];
    for (var i = 0; i < value.length; i++) items.push(rhCanonical_(value[i]));
    return '[' + items.join(',') + ']';
  }
  var keys = Object.keys(value).sort();
  var parts = [];
  for (var k = 0; k < keys.length; k++) {
    parts.push(JSON.stringify(keys[k]) + ':' + rhCanonical_(value[keys[k]]));
  }
  return '{' + parts.join(',') + '}';
}

function rhRequestHash_(payload) {
  var digest = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    rhCanonical_(payload),
    Utilities.Charset.UTF_8
  );
  return Utilities.base64EncodeWebSafe(digest);
}

function rhFingerprint_(value) {
  var digest = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    String(value),
    Utilities.Charset.UTF_8
  );
  return Utilities.base64EncodeWebSafe(digest).slice(0, 12);
}

function rhConstantTimeEqual_(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  var diff = a.length ^ b.length;
  var len = Math.max(a.length, b.length);
  for (var i = 0; i < len; i++) {
    var left = i < a.length ? a.charCodeAt(i) : 0;
    var right = i < b.length ? b.charCodeAt(i) : 0;
    diff = diff | (left ^ right);
  }
  return diff === 0;
}

function rhOptionalIso_(value, name) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/.test(value)) {
    throw rhFail_('VALIDATION', name + ' must be an ISO-8601 UTC timestamp');
  }
  if (isNaN(Date.parse(value))) throw rhFail_('VALIDATION', name + ' is not a real timestamp');
  return value;
}

function rhReportDate_(iso) {
  var timeZone = 'America/Chicago';
  try {
    if (Session.getScriptTimeZone) timeZone = Session.getScriptTimeZone() || timeZone;
  } catch (err) {
    timeZone = 'America/Chicago';
  }
  return Utilities.formatDate(new Date(iso), timeZone, 'yyyy-MM-dd');
}
