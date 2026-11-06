/**
 * Spreadsheet access, schema setup, and the script lock.
 *
 * Google Sheets is not a transactional database. There are no multi-row
 * commits and no unique constraints. Every balance change holds
 * LockService.getScriptLock(), re-reads the card, and flushes before the
 * lock is released. Document locks are not available to a standalone web
 * app, and this lock does not stop a person editing the sheet by hand.
 */

function rhOpenDb_() {
  return SpreadsheetApp.openById(rhGetSpreadsheetId_());
}

function rhOpenContext_() {
  return { db: rhOpenDb_(), cache: {} };
}

function rhWithLock_(fn) {
  if (rhLockForceFailure_) {
    if (rhProps_().getProperty('ALLOW_TEST_TOKENS') !== 'true') rhLockForceFailure_ = null;
    else throw rhFail_('LOCK_TIMEOUT', 'Another gift card operation is in progress. Try again.');
  }
  var lock = LockService.getScriptLock();
  var acquired = false;
  try {
    acquired = lock.tryLock(rhLockTimeoutMs_());
    if (!acquired) {
      throw rhFail_('LOCK_TIMEOUT', 'Another gift card operation is in progress. Try again.');
    }
    var ctx = rhOpenContext_();
    var result = fn(ctx);
    return result;
  } finally {
    try {
      SpreadsheetApp.flush();
    } catch (flushErr) {
      // The lock must still be released. Reconciliation treats a missing
      // flush as a possible partial write.
    }
    if (acquired) {
      try {
        lock.releaseLock();
      } catch (releaseErr) {
        // Apps Script also releases the lock when the execution ends.
      }
    }
  }
}

function rhMaybeFailWrite_(stage) {
  if (!rhWriteFailurePlan_) return;
  if (rhProps_().getProperty('ALLOW_TEST_TOKENS') !== 'true') {
    rhWriteFailurePlan_ = null;
    return;
  }
  if (rhWriteFailurePlan_.stage === stage) {
    rhWriteFailurePlan_ = null;
    throw rhFail_('PARTIAL_FAILURE', 'Spreadsheet write did not finish (' + stage + ')');
  }
}

function rhSheet_(ctx, name) {
  var sheet = ctx.db.getSheetByName(name);
  if (!sheet) throw rhFail_('CONFIG', 'Missing sheet ' + name + '. Run initializeDatabase().');
  return sheet;
}

function rhInvalidate_(ctx, name) {
  if (ctx && ctx.cache) delete ctx.cache[name];
}

function rhRowEmpty_(row) {
  for (var i = 0; i < row.length; i++) {
    if (row[i] !== '' && row[i] !== null && row[i] !== undefined) return false;
  }
  return true;
}

function rhNormalizeInbound_(field, value) {
  if (value === '' || value === null || value === undefined) {
    if (RH_MONEY_FIELDS[field]) return 0;
    if (RH_BOOL_FIELDS[field]) return false;
    return '';
  }
  if (RH_MONEY_FIELDS[field]) {
    if (typeof value === 'number' && isFinite(value) && Math.floor(value) === value) return value;
    throw rhFail_('RECONCILIATION', 'Money column ' + field + ' contains a non-integer value');
  }
  if (RH_BOOL_FIELDS[field]) {
    if (value === true || value === false) return value;
    if (value === 'TRUE' || value === 'true') return true;
    if (value === 'FALSE' || value === 'false') return false;
    throw rhFail_('RECONCILIATION', 'Boolean column ' + field + ' contains an invalid value');
  }
  if (Object.prototype.toString.call(value) === '[object Date]') {
    if (isNaN(value.getTime())) return '';
    return value.toISOString();
  }
  return value;
}

function rhSanitizeOutbound_(field, value) {
  if (RH_MONEY_FIELDS[field]) {
    if (typeof value !== 'number' || !isFinite(value) || Math.floor(value) !== value) {
      throw rhFail_('VALIDATION', 'Refusing to write a non-integer money value');
    }
    if (value < 0) throw rhFail_('INSUFFICIENT_FUNDS', 'The gift card balance cannot go negative');
    return value;
  }
  if (RH_BOOL_FIELDS[field]) {
    if (typeof value !== 'boolean') throw rhFail_('VALIDATION', 'Refusing to write an invalid boolean');
    return value;
  }
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(value)) {
    return "'" + value;
  }
  return value;
}

function rhRecordToRow_(sheetName, record) {
  var headers = RH_HEADERS[sheetName];
  var row = [];
  for (var i = 0; i < headers.length; i++) {
    var value = record[headers[i]];
    if (value === undefined || value === null) value = '';
    row.push(rhSanitizeOutbound_(headers[i], value));
  }
  return row;
}

function rhReadSheet_(ctx, name) {
  if (ctx.cache[name]) return ctx.cache[name];
  var sheet = rhSheet_(ctx, name);
  var values = sheet.getDataRange().getValues();
  var headers = RH_HEADERS[name];
  if (!values.length) throw rhFail_('CONFIG', 'Sheet ' + name + ' has no header row');
  for (var h = 0; h < headers.length; h++) {
    if (values[0][h] !== headers[h]) {
      throw rhFail_('CONFIG', 'Sheet ' + name + ' headers do not match the schema');
    }
  }
  var records = [];
  for (var r = 1; r < values.length; r++) {
    if (rhRowEmpty_(values[r])) continue;
    var rec = { _row: r + 1, _sheet: name };
    for (var c = 0; c < headers.length; c++) {
      rec[headers[c]] = rhNormalizeInbound_(headers[c], values[r][c]);
    }
    records.push(rec);
  }
  var parsed = { records: records };
  ctx.cache[name] = parsed;
  return parsed;
}

function rhFindBy_(ctx, sheetName, field, value) {
  var records = rhReadSheet_(ctx, sheetName).records;
  var matches = [];
  for (var i = 0; i < records.length; i++) {
    if (records[i][field] === value) matches.push(records[i]);
  }
  return matches;
}

function rhAppendRecord_(ctx, sheetName, record) {
  var sheet = rhSheet_(ctx, sheetName);
  if (sheet.getLastRow() < 1) throw rhFail_('CONFIG', 'Sheet ' + sheetName + ' has no header row');
  var rowNumber = sheet.getLastRow() + 1;
  var row = rhRecordToRow_(sheetName, record);
  sheet.getRange(rowNumber, 1, 1, row.length).setValues([row]);
  record._row = rowNumber;
  record._sheet = sheetName;
  rhInvalidate_(ctx, sheetName);
  return record;
}

function rhUpdateRecord_(ctx, sheetName, rowNumber, original, patch) {
  var headers = RH_HEADERS[sheetName];
  var updated = { _row: rowNumber, _sheet: sheetName };
  for (var i = 0; i < headers.length; i++) {
    var key = headers[i];
    if (Object.prototype.hasOwnProperty.call(patch, key)) updated[key] = patch[key];
    else updated[key] = original[key];
  }
  var row = rhRecordToRow_(sheetName, updated);
  rhSheet_(ctx, sheetName).getRange(rowNumber, 1, 1, row.length).setValues([row]);
  rhInvalidate_(ctx, sheetName);
  return updated;
}

function rhHeaderColumn_(sheetName, field) {
  var index = RH_HEADERS[sheetName].indexOf(field);
  if (index === -1) throw rhFail_('CONFIG', 'Unknown column ' + field);
  return index + 1;
}

function rhEnsureSheet_(ss, name) {
  var sheet = ss.getSheetByName(name);
  var created = false;
  if (!sheet) {
    sheet = ss.insertSheet(name);
    created = true;
  }
  var headers = RH_HEADERS[name];
  var width = headers.length;
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, width).setValues([headers]);
  } else {
    var current = sheet.getRange(1, 1, 1, width).getValues()[0];
    for (var i = 0; i < width; i++) {
      if (current[i] !== headers[i]) {
        throw rhFail_('CONFIG', 'Sheet ' + name + ' already exists with a different header row');
      }
    }
  }
  sheet.setFrozenRows(1);
  if (sheet.getRange(1, 1).setFontWeight) sheet.getRange(1, 1, 1, width).setFontWeight('bold');
  rhApplyColumnNotes_(sheet, name);
  rhApplyEnumValidation_(sheet, name);
  var protectedOk = rhProtectSheet_(sheet);
  return { name: name, created: created, protected: protectedOk };
}

function rhApplyColumnNotes_(sheet, name) {
  var notes = {
    initial_amount: 'Integer cents. 2500 means $25.00. Do not enter dollars.',
    current_balance: 'Integer cents. 2500 means $25.00. Do not enter dollars.',
    amount_cents: 'Integer cents. Never enter a dollar amount in this column.',
    balance_before_cents: 'Integer cents immediately before this transaction.',
    balance_after_cents: 'Integer cents immediately after this transaction.',
    qr_token: 'Secret card identifier. Do not publish this column.',
    customer_email: 'Customer information. Do not export this column to unsecured reports.',
    metadata_json: 'System recovery data. Do not edit. May contain a QR token for an in-flight card issue.'
  };
  var headers = RH_HEADERS[name];
  for (var i = 0; i < headers.length; i++) {
    if (!notes[headers[i]] || !sheet.getRange(1, i + 1).setNote) continue;
    sheet.getRange(1, i + 1).setNote(notes[headers[i]]);
  }
  if (name === RH_SHEET.GIFT_CARDS || name === RH_SHEET.TRANSACTIONS) {
    headers.forEach(function (header, index) {
      if (!RH_MONEY_FIELDS[header] || !sheet.getRange(2, index + 1).setNumberFormat) return;
      var rows = Math.max(1, sheet.getMaxRows() - 1);
      sheet.getRange(2, index + 1, rows, 1).setNumberFormat('0');
    });
  }
}

function rhApplyEnumValidation_(sheet, name) {
  var columns = RH_ENUM_COLUMNS[name];
  if (!columns || !SpreadsheetApp.newDataValidation) return;
  var fields = Object.keys(columns);
  for (var i = 0; i < fields.length; i++) {
    var column = rhHeaderColumn_(name, fields[i]);
    var rule = SpreadsheetApp.newDataValidation()
      .requireValueInList(columns[fields[i]], true)
      .setAllowInvalid(false)
      .build();
    var rows = Math.max(1, sheet.getMaxRows() - 1);
    sheet.getRange(2, column, rows, 1).setDataValidation(rule);
  }
}

function rhProtectSheet_(sheet) {
  try {
    if (!sheet.protect) return false;
    var protection = sheet.protect();
    protection.setDescription('Restoring Hope gift cards. Change records through the Apps Script service.');
    protection.setWarningOnly(false);
    if (protection.canDomainEdit && protection.canDomainEdit()) protection.setDomainEdit(false);
    var me = Session.getEffectiveUser();
    protection.addEditor(me);
    if (protection.getEditors && protection.removeEditors) {
      var editors = protection.getEditors();
      var remove = [];
      var myEmail = me && me.getEmail ? me.getEmail() : '';
      for (var i = 0; i < editors.length; i++) {
        var editorEmail = editors[i].getEmail ? editors[i].getEmail() : '';
        if (editorEmail !== myEmail) remove.push(editors[i]);
      }
      if (remove.length) protection.removeEditors(remove);
    }
    return true;
  } catch (err) {
    return false;
  }
}

function rhUpsertMeta_(ctx, key, value) {
  var existing = rhFindBy_(ctx, RH_SHEET.META, 'key', key);
  if (existing.length) return existing[0];
  return rhAppendRecord_(ctx, RH_SHEET.META, { key: key, value: value });
}

function rhDeleteDefaultSheet_(ss) {
  var leftover = ss.getSheetByName('Sheet1');
  if (leftover && ss.getSheets().length > 1) ss.deleteSheet(leftover);
}

function rhSeedLocations_(ctx) {
  var existing = rhReadSheet_(ctx, RH_SHEET.LOCATIONS).records;
  var byName = {};
  for (var i = 0; i < existing.length; i++) byName[existing[i].location_name] = existing[i];
  var seeded = [];
  for (var s = 0; s < RH_SEED_LOCATIONS.length; s++) {
    var spec = RH_SEED_LOCATIONS[s];
    if (byName[spec.location_name]) {
      seeded.push(rhPublicLocation_(byName[spec.location_name]));
      continue;
    }
    var now = rhNowIso_();
    var created = rhAppendRecord_(ctx, RH_SHEET.LOCATIONS, {
      location_id: rhNewId_(),
      location_name: spec.location_name,
      location_type: spec.location_type,
      address: spec.address,
      phone: spec.phone,
      is_active: true,
      created_at: now,
      updated_at: now
    });
    seeded.push(rhPublicLocation_(created));
  }
  return seeded;
}

function rhPublicLocation_(location) {
  return {
    location_id: location.location_id,
    location_name: location.location_name,
    location_type: location.location_type,
    address: location.address,
    phone: location.phone,
    is_active: location.is_active,
    created_at: location.created_at,
    updated_at: location.updated_at
  };
}

/** Editor helper. Returns the Google account that clicked Run, or fails closed. */
function showSignedInEmail() {
  var email = rhInteractiveEmail_();
  if (!email) {
    throw new Error('Google did not provide an email for this execution. Refusing to guess an identity.');
  }
  Logger.log(email);
  return email;
}

function rhInteractiveEmail_() {
  try {
    var email = Session.getActiveUser().getEmail();
    if (!email) return '';
    return String(email).trim().toLowerCase();
  } catch (err) {
    return '';
  }
}

/**
 * Creates the workbook schema and seeds the participating locations.
 * Safe to run again. When bootstrapAdmin is present, its email must match
 * the Google account that clicked Run. A blank active-user email is denied.
 * This function is not exposed through the web app.
 */
function initializeDatabase(request) {
  request = request || {};
  return rhWithLock_(function (ctx) {
    var ss = ctx.db;
    var sheets = [
      rhEnsureSheet_(ss, RH_SHEET.META),
      rhEnsureSheet_(ss, RH_SHEET.LOCATIONS),
      rhEnsureSheet_(ss, RH_SHEET.EMPLOYEES),
      rhEnsureSheet_(ss, RH_SHEET.GIFT_CARDS),
      rhEnsureSheet_(ss, RH_SHEET.TRANSACTIONS),
      rhEnsureSheet_(ss, RH_SHEET.AUDIT_LOG)
    ];
    rhDeleteDefaultSheet_(ss);
    rhUpsertMeta_(ctx, 'schema_version', String(RH_SCHEMA_VERSION));
    rhUpsertMeta_(ctx, 'money_unit', RH_MONEY_UNIT);
    rhUpsertMeta_(ctx, 'initialized_at', rhNowIso_());
    rhUpsertMeta_(
      ctx,
      'financial_limitations',
      'Sheets writes are not atomic and Sheets does not enforce unique keys. ' +
        'The service uses a script lock, pending financial intents, append-only completed amounts, and reconciliation. ' +
        'The lock does not prevent manual edits.'
    );
    var locations = rhSeedLocations_(ctx);
    var bootstrapAdmin = null;
    if (request.bootstrapAdmin) bootstrapAdmin = rhBootstrapAdmin_(ctx, request.bootstrapAdmin);
    return {
      schemaVersion: RH_SCHEMA_VERSION,
      moneyUnit: RH_MONEY_UNIT,
      sheets: sheets,
      locations: locations,
      bootstrapAdmin: bootstrapAdmin
    };
  });
}

function rhBootstrapAdmin_(ctx, spec) {
  rhRequireObject_(spec, 'bootstrapAdmin');
  var email = rhNormalizeEmail_(spec.email);
  var fullName = rhRequireText_(spec.fullName, 'bootstrapAdmin.fullName', 2, 120);
  var active = rhInteractiveEmail_();
  if (!active) {
    throw rhFail_(
      'UNAUTHENTICATED',
      'The Google account running initialization did not provide an email. Refusing to create an admin.'
    );
  }
  if (active !== email) {
    throw rhFail_('FORBIDDEN', 'Bootstrap admin email must match the Google account running initialization.');
  }
  var existing = rhFindBy_(ctx, RH_SHEET.EMPLOYEES, 'email', email);
  if (existing.length > 1) throw rhFail_('RECONCILIATION', 'Duplicate employee email found. Refusing to continue.');
  if (existing.length === 1) {
    if (existing[0].role !== 'ADMIN' || existing[0].is_active !== true) {
      throw rhFail_('CONFLICT', 'That Google account already exists and is not an active admin.');
    }
    return rhPublicEmployee_(existing[0]);
  }
  var now = rhNowIso_();
  var admin = rhAppendRecord_(ctx, RH_SHEET.EMPLOYEES, {
    employee_id: rhNewId_(),
    full_name: fullName,
    email: email,
    role: 'ADMIN',
    location_id: '',
    is_active: true,
    created_at: now,
    updated_at: now
  });
  rhAudit_(ctx, {
    employee_id: admin.employee_id,
    action: 'EMPLOYEE_CREATED',
    entity_type: 'EMPLOYEE',
    entity_id: admin.employee_id,
    details: { role: 'ADMIN', location_id: '', is_active: true, bootstrap: true }
  });
  return rhPublicEmployee_(admin);
}
