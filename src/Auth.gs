/**
 * Identity comes from a Google-verified ID token or, only inside an armed
 * test run, from an in-memory HMAC test token. Email addresses and employee
 * ids in the request body are never treated as identity.
 *
 * A web app deployed as USER_DEPLOYING cannot see the caller's email through
 * Session.getActiveUser(). That method is used only when a person runs
 * initializeDatabase from the Apps Script editor.
 */

function rhRequireActor_(request, options) {
  options = options || {};
  if (!request || typeof request !== 'object') {
    rhTryAuditFailure_('AUTH_FAILED', '', { reason: 'missing_request', action: options.action || '' });
    throw rhFail_('UNAUTHENTICATED', 'A verified Google identity is required');
  }
  var identity = rhVerifyIdToken_(request.idToken);
  if (!identity || !identity.email) {
    rhTryAuditFailure_('AUTH_FAILED', '', { reason: 'unverified_identity', action: options.action || '' });
    throw rhFail_('UNAUTHENTICATED', 'A verified Google identity is required');
  }
  var ctx = rhOpenContext_();
  var matches = rhFindBy_(ctx, RH_SHEET.EMPLOYEES, 'email', identity.email);
  if (matches.length > 1) {
    rhTryAuditFailure_('AUTH_FAILED', '', { reason: 'duplicate_employee', action: options.action || '' });
    throw rhFail_('RECONCILIATION', 'Duplicate employee email found. Refusing to continue.');
  }
  var employee = matches.length ? matches[0] : null;
  if (!employee || employee.is_active !== true) {
    rhTryAuditFailure_('AUTH_FAILED', employee ? employee.employee_id : '', {
      reason: 'no_active_employee',
      action: options.action || '',
      email_fingerprint: rhFingerprint_(identity.email)
    });
    throw rhFail_('FORBIDDEN', 'Access denied');
  }
  if (options.roles && options.roles.indexOf(employee.role) === -1) {
    rhTryAuditFailure_('AUTH_FORBIDDEN', employee.employee_id, {
      reason: 'role_denied',
      action: options.action || '',
      role: employee.role
    });
    throw rhFail_('FORBIDDEN', 'Access denied');
  }
  return rhPublicActor_(employee);
}

function rhReloadActor_(ctx, actor) {
  var matches = rhFindBy_(ctx, RH_SHEET.EMPLOYEES, 'employee_id', actor.employee_id);
  if (matches.length !== 1 || matches[0].is_active !== true) {
    throw rhFail_('FORBIDDEN', 'Access denied');
  }
  if (matches[0].role !== actor.role || matches[0].location_id !== actor.location_id) {
    throw rhFail_('FORBIDDEN', 'Access denied');
  }
  return rhPublicActor_(matches[0]);
}

function rhPublicActor_(employee) {
  return {
    employee_id: employee.employee_id,
    role: employee.role,
    location_id: employee.location_id || '',
    is_active: employee.is_active === true
  };
}

function rhResolveLocation_(ctx, actor, requestedLocationId) {
  if (actor.role === 'ADMIN') {
    if (!requestedLocationId) throw rhFail_('VALIDATION', 'locationId is required');
    var adminLocation = rhRequireLocation_(ctx, requestedLocationId);
    if (adminLocation.is_active !== true) throw rhFail_('VALIDATION', 'locationId is not an active location');
    return adminLocation;
  }
  if (!actor.location_id) throw rhFail_('FORBIDDEN', 'Access denied');
  if (requestedLocationId && requestedLocationId !== actor.location_id) {
    throw rhFail_('FORBIDDEN', 'Access denied');
  }
  var home = rhRequireLocation_(ctx, actor.location_id);
  if (home.is_active !== true) throw rhFail_('FORBIDDEN', 'Access denied');
  return home;
}

function rhRequireLocation_(ctx, locationId) {
  var id = rhRequireUuid_(locationId, 'locationId');
  var matches = rhFindBy_(ctx, RH_SHEET.LOCATIONS, 'location_id', id);
  if (matches.length > 1) throw rhFail_('RECONCILIATION', 'Duplicate location id found. Refusing to continue.');
  if (!matches.length) throw rhFail_('NOT_FOUND', 'Location was not found');
  return matches[0];
}

function rhVerifyIdToken_(token) {
  if (typeof token !== 'string') return null;
  var trimmed = token.trim();
  if (!trimmed || trimmed.length > 8000) return null;
  if (trimmed.indexOf('test.') === 0) return rhVerifyTestToken_(trimmed);
  return rhVerifyGoogleIdToken_(trimmed);
}

function rhVerifyGoogleIdToken_(token) {
  var clientId = rhProps_().getProperty('GOOGLE_CLIENT_ID');
  if (!clientId) return null;
  var response;
  try {
    response = UrlFetchApp.fetch(
      'https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(token),
      { muteHttpExceptions: true, followRedirects: false }
    );
  } catch (err) {
    return null;
  }
  if (!response || response.getResponseCode() !== 200) return null;
  var payload;
  try {
    payload = JSON.parse(response.getContentText());
  } catch (parseErr) {
    return null;
  }
  return rhClaimsFromTokenInfo_(payload, clientId);
}

function rhClaimsFromTokenInfo_(payload, clientId) {
  if (!payload || payload.aud !== clientId) return null;
  var verified = payload.email_verified;
  if (verified !== true && verified !== 'true') return null;
  var issuer = payload.iss;
  if (issuer !== 'accounts.google.com' && issuer !== 'https://accounts.google.com') return null;
  var expSeconds = Number(payload.exp);
  if (!expSeconds || expSeconds * 1000 <= Date.now()) return null;
  if (!payload.email || String(payload.email).indexOf('@') === -1) return null;
  var email = rhEnforceEmailDomain_(String(payload.email).trim().toLowerCase());
  if (!email || !payload.sub) return null;
  return { email: email, sub: String(payload.sub) };
}

function rhEnforceEmailDomain_(email) {
  var allowedDomain = rhProps_().getProperty('ALLOWED_EMAIL_DOMAIN');
  if (!allowedDomain) return email;
  if (email.split('@')[1] !== String(allowedDomain).trim().toLowerCase()) return '';
  return email;
}

/**
 * Test tokens are HMAC-signed in memory and are rejected unless this
 * execution armed them, ALLOW_TEST_TOKENS is true, and the open database
 * is the disposable test spreadsheet. They are never sent to Google.
 */
function rhIssueTestToken_(email) {
  if (rhProps_().getProperty('ALLOW_TEST_TOKENS') !== 'true' || !rhTestHmacKey_) {
    throw rhFail_('FORBIDDEN', 'Test tokens are disabled');
  }
  var payload = {
    email: email,
    email_verified: true,
    aud: rhProps_().getProperty('GOOGLE_CLIENT_ID'),
    exp: Date.now() + 5 * 60 * 1000
  };
  var body = Utilities.base64EncodeWebSafe(JSON.stringify(payload));
  var signature = Utilities.base64EncodeWebSafe(
    Utilities.computeHmacSha256Signature(body, rhTestHmacKey_)
  );
  return 'test.' + body + '.' + signature;
}

function rhVerifyTestToken_(token) {
  if (rhProps_().getProperty('ALLOW_TEST_TOKENS') !== 'true') return null;
  if (!rhTestHmacKey_) return null;
  var parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'test' || !parts[1] || !parts[2]) return null;
  var expected = Utilities.base64EncodeWebSafe(
    Utilities.computeHmacSha256Signature(parts[1], rhTestHmacKey_)
  );
  if (!rhConstantTimeEqual_(expected, parts[2])) return null;
  var payload;
  try {
    payload = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(parts[1])).getDataAsString());
  } catch (err) {
    return null;
  }
  if (!payload || payload.email_verified !== true) return null;
  if (payload.aud !== rhProps_().getProperty('GOOGLE_CLIENT_ID')) return null;
  if (!payload.exp || Number(payload.exp) <= Date.now()) return null;
  if (!payload.email) return null;
  var email = rhEnforceEmailDomain_(String(payload.email).toLowerCase());
  if (!email) return null;
  var testId = rhProps_().getProperty('TEST_SPREADSHEET_ID');
  var currentId;
  try {
    currentId = rhGetSpreadsheetId_();
  } catch (idErr) {
    return null;
  }
  if (!testId || currentId !== testId) return null;
  return { email: email, sub: 'test' };
}

function rhSecureRandomString_(length, alphabet) {
  var chars = [];
  var guard = 0;
  while (chars.length < length && guard < 100) {
    guard++;
    var hex = Utilities.getUuid().replace(/-/g, '');
    for (var i = 0; i + 1 < hex.length && chars.length < length; i += 2) {
      var byteValue = parseInt(hex.substring(i, i + 2), 16);
      var limit = Math.floor(256 / alphabet.length) * alphabet.length;
      if (byteValue < limit) chars.push(alphabet.charAt(byteValue % alphabet.length));
    }
  }
  if (chars.length < length) throw rhFail_('INTERNAL', 'Random generation failed');
  return chars.join('');
}

function rhGenerateCardNumber_(ctx) {
  var alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (var attempt = 0; attempt < 8; attempt++) {
    var raw = rhSecureRandomString_(12, alphabet);
    var cardNumber = 'RH-' + raw.substring(0, 4) + '-' + raw.substring(4, 8) + '-' + raw.substring(8, 12);
    if (!rhFindBy_(ctx, RH_SHEET.GIFT_CARDS, 'card_number', cardNumber).length) return cardNumber;
  }
  throw rhFail_('CONFLICT', 'Could not allocate a card number');
}

function rhGenerateQrToken_(ctx) {
  for (var attempt = 0; attempt < 5; attempt++) {
    var token = (
      Utilities.getUuid() + Utilities.getUuid()
    ).replace(/-/g, '').toLowerCase();
    if (token.length !== 64) continue;
    if (!rhFindBy_(ctx, RH_SHEET.GIFT_CARDS, 'qr_token', token).length) return token;
  }
  throw rhFail_('CONFLICT', 'Could not allocate a QR token');
}
