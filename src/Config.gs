/**
 * Configuration, schema, and money units for Restoring Hope gift cards.
 * Cross-file symbols use `var` and `function` because the Apps Script V8
 * runtime does not share top-level let, const, or class bindings.
 */

var RH_SCHEMA_VERSION = 1;
var RH_MONEY_UNIT = 'integer_cents';
var RH_DEFAULT_LOCK_TIMEOUT_MS = 30000;
var RH_DEFAULT_MAX_SINGLE_AMOUNT_CENTS = 100000;
var RH_DEFAULT_MAX_BALANCE_CENTS = 500000;
var RH_BLANK_BATCH_LIMIT = 25;
var RH_QR_PAYLOAD_PREFIX = 'rhgc:v1:';

var RH_SHEET = {
  LOCATIONS: 'LOCATIONS',
  EMPLOYEES: 'EMPLOYEES',
  GIFT_CARDS: 'GIFT_CARDS',
  TRANSACTIONS: 'TRANSACTIONS',
  AUDIT_LOG: 'AUDIT_LOG',
  META: 'META'
};

var RH_LOCATION_TYPES = ['THRIFT', 'BOUTIQUE', 'CAFE', 'OTHER'];
var RH_ROLES = ['ADMIN', 'MANAGER', 'EMPLOYEE'];
var RH_CARD_STATUSES = ['PENDING', 'ACTIVE', 'SUSPENDED', 'DEPLETED', 'CANCELLED'];
var RH_CARD_TYPES = ['PHYSICAL', 'DIGITAL'];
var RH_TX_TYPES = ['ISSUE', 'ACTIVATE', 'REDEEM', 'RELOAD', 'REFUND', 'ADJUSTMENT', 'VOID'];
var RH_TX_STATUSES = ['PENDING', 'COMPLETED', 'FAILED', 'VOIDED'];

var RH_HEADERS = {};
RH_HEADERS[RH_SHEET.LOCATIONS] = [
  'location_id', 'location_name', 'location_type', 'address', 'phone',
  'is_active', 'created_at', 'updated_at'
];
RH_HEADERS[RH_SHEET.EMPLOYEES] = [
  'employee_id', 'full_name', 'email', 'role', 'location_id',
  'is_active', 'created_at', 'updated_at'
];
RH_HEADERS[RH_SHEET.GIFT_CARDS] = [
  'card_id', 'card_number', 'qr_token', 'initial_amount', 'current_balance',
  'status', 'card_type', 'issued_at', 'activated_at', 'issued_location_id',
  'issued_by_employee_id', 'customer_name', 'customer_email', 'created_at', 'updated_at'
];
RH_HEADERS[RH_SHEET.TRANSACTIONS] = [
  'transaction_id', 'card_id', 'transaction_type', 'amount_cents',
  'balance_before_cents', 'balance_after_cents', 'location_id', 'employee_id',
  'register_reference', 'idempotency_key', 'related_transaction_id',
  'transaction_status', 'notes', 'created_at', 'metadata_json'
];
RH_HEADERS[RH_SHEET.AUDIT_LOG] = [
  'audit_id', 'employee_id', 'action', 'entity_type', 'entity_id', 'details', 'timestamp'
];
RH_HEADERS[RH_SHEET.META] = ['key', 'value'];

var RH_MONEY_FIELDS = {
  initial_amount: true,
  current_balance: true,
  amount_cents: true,
  balance_before_cents: true,
  balance_after_cents: true
};

var RH_BOOL_FIELDS = {
  is_active: true
};

var RH_SEED_LOCATIONS = [
  { location_name: 'Restoring Hope Thrift Store', location_type: 'THRIFT', address: '', phone: '' },
  { location_name: 'Restoring Hope Boutique', location_type: 'BOUTIQUE', address: '', phone: '' },
  { location_name: 'Honor Grounds Café', location_type: 'CAFE', address: '', phone: '' }
];

var RH_ENUM_COLUMNS = {};
RH_ENUM_COLUMNS[RH_SHEET.LOCATIONS] = { location_type: RH_LOCATION_TYPES };
RH_ENUM_COLUMNS[RH_SHEET.EMPLOYEES] = { role: RH_ROLES };
RH_ENUM_COLUMNS[RH_SHEET.GIFT_CARDS] = { status: RH_CARD_STATUSES, card_type: RH_CARD_TYPES };
RH_ENUM_COLUMNS[RH_SHEET.TRANSACTIONS] = { transaction_type: RH_TX_TYPES, transaction_status: RH_TX_STATUSES };

/** In-memory only. Production web requests clear this. */
var rhExecutionSpreadsheetOverride_ = null;
var rhTestHmacKey_ = null;
var rhWriteFailurePlan_ = null;
var rhLockForceFailure_ = null;

function rhProps_() {
  return PropertiesService.getScriptProperties();
}

function rhLockTimeoutMs_() {
  return rhPositiveIntProperty_('LOCK_TIMEOUT_MS', RH_DEFAULT_LOCK_TIMEOUT_MS);
}

function rhMaxSingleAmount_() {
  return rhPositiveIntProperty_('MAX_SINGLE_AMOUNT_CENTS', RH_DEFAULT_MAX_SINGLE_AMOUNT_CENTS);
}

function rhMaxBalance_() {
  return rhPositiveIntProperty_('MAX_BALANCE_CENTS', RH_DEFAULT_MAX_BALANCE_CENTS);
}

function rhPositiveIntProperty_(key, fallback) {
  var raw = rhProps_().getProperty(key);
  if (raw === null || raw === undefined || raw === '') return fallback;
  var value = Number(raw);
  if (!isFinite(value) || Math.floor(value) !== value || value <= 0) return fallback;
  return value;
}

function rhNowIso_() {
  return new Date().toISOString();
}

function rhNewId_() {
  return Utilities.getUuid();
}

function rhActiveSpreadsheetId_() {
  try {
    if (SpreadsheetApp.getActive) {
      var active = SpreadsheetApp.getActive();
      if (active) return active.getId();
    }
  } catch (err) {
    return '';
  }
  return '';
}

/**
 * Production reads SPREADSHEET_ID, or the container-bound spreadsheet when
 * the script is bound to it. The test override is honored only for the
 * disposable TEST_SPREADSHEET_ID while ALLOW_TEST_TOKENS is explicitly true.
 */
function rhGetSpreadsheetId_() {
  var props = rhProps_();
  var productionId = props.getProperty('SPREADSHEET_ID') || rhActiveSpreadsheetId_();
  if (rhExecutionSpreadsheetOverride_) {
    if (props.getProperty('ALLOW_TEST_TOKENS') !== 'true') {
      throw rhFail_('CONFIG', 'Test database access is disabled');
    }
    var testId = props.getProperty('TEST_SPREADSHEET_ID');
    if (!testId || rhExecutionSpreadsheetOverride_ !== testId) {
      throw rhFail_('CONFIG', 'Test database override does not match TEST_SPREADSHEET_ID');
    }
    if (productionId && productionId === testId) {
      throw rhFail_('CONFIG', 'TEST_SPREADSHEET_ID must be a different spreadsheet from production');
    }
    return testId;
  }
  if (!productionId) {
    throw rhFail_('CONFIG', 'SPREADSHEET_ID is not configured');
  }
  return productionId;
}

function rhDisarmTestHooks_() {
  rhTestHmacKey_ = null;
  rhWriteFailurePlan_ = null;
  rhLockForceFailure_ = null;
  rhExecutionSpreadsheetOverride_ = null;
}

function rhEnterWebRequest_() {
  rhWriteFailurePlan_ = null;
  rhLockForceFailure_ = null;
  rhExecutionSpreadsheetOverride_ = null;
  if (rhProps_().getProperty('ALLOW_TEST_TOKENS') !== 'true') {
    rhTestHmacKey_ = null;
  }
}
