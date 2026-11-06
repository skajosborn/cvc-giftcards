/**
 * Automated coverage for issuance, activation, redemption, concurrency,
 * authorization, partial writes, and ledger reconciliation.
 *
 * runAllTests refuses to touch the production spreadsheet. npm test runs
 * this file against an in-memory spreadsheet. In Apps Script, point
 * TEST_SPREADSHEET_ID at a disposable workbook and set ALLOW_TEST_TOKENS
 * only on that test project.
 */

function runAllTests() {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty('ALLOW_TEST_TOKENS') !== 'true') {
    throw new Error('ALLOW_TEST_TOKENS must be true on the test project. Do not enable it in production.');
  }
  var testId = props.getProperty('TEST_SPREADSHEET_ID');
  if (!testId) throw new Error('Set TEST_SPREADSHEET_ID to a disposable spreadsheet before running tests.');
  if (!props.getProperty('GOOGLE_CLIENT_ID')) throw new Error('Set GOOGLE_CLIENT_ID before running tests.');
  var productionId = props.getProperty('SPREADSHEET_ID') || rhActiveSpreadsheetId_();
  if (productionId && productionId === testId) {
    throw new Error('TEST_SPREADSHEET_ID must not be the production spreadsheet.');
  }
  rhTestHmacKey_ = Utilities.getUuid() + Utilities.getUuid();
  var tests = [
    testInitializeSeedsLocations,
    testInitializeIsIdempotent,
    testBootstrapAdminRequiresMatchingGoogleIdentity,
    testBootstrapAdminRejectsMismatchedEmail,
    testCreateGiftCardIsPendingWithZeroBalance,
    testBlankSeriesGetsNumbersAndABalanceAtPurchase,
    testActivationRequiresPaymentConfirmation,
    testSuccessfulRedemption,
    testInsufficientFundsLeavesBalanceUnchanged,
    testDuplicateRedemptionIsIdempotent,
    testIdempotencyKeyRejectsADifferentPayload,
    testReloadRevivesDepletedCard,
    testRefundRestoresRedeemedValue,
    testRefundCannotExceedOriginal,
    testSuspendedCardCannotBeRedeemed,
    testUnauthorizedAccessIsDenied,
    testSpoofedEmailIsIgnored,
    testSessionUsesVerifiedEmployee,
    testRejectedGoogleTokenCannotSpoofEmail,
    testVerifiedGoogleTokenMapsToEmployee,
    testEmployeeCannotOperateAtAnotherLocation,
    testGiftCardWorksAcrossLocations,
    testConcurrentFullRedeemsOnlyOneSucceeds,
    testLockTimeoutWritesNothing,
    testPartialFailureBeforeCardUpdateIsRepaired,
    testPartialFailureAfterCardUpdateIsRepaired,
    testAmbiguousPartialWriteIsNotGuessed,
    testTamperedBalanceIsDetectedAndRestored,
    testReportsDoNotDoubleCountIssueAndActivation,
    testRefundOfActivationReducesSales,
    testVoidRedeemNetsOutOfRedemptionReport,
    testQrTokenIsUnpredictableAndAbsentFromAudit,
    testFractionalCentsAndNegativeBalancesAreRejected,
    testWebRequestRejectsUnverifiedCaller
  ];
  var results = [];
  try {
    for (var i = 0; i < tests.length; i++) {
      rhTestPrepareEmpty_();
      try {
        tests[i]();
        results.push({ name: tests[i].name, passed: true });
      } catch (err) {
        results.push({
          name: tests[i].name,
          passed: false,
          message: err && err.message ? err.message : String(err),
          code: err && err.code ? err.code : '',
          stack: err && err.stack ? String(err.stack) : ''
        });
      }
    }
  } finally {
    rhDisarmTestHooks_();
  }
  var failed = 0;
  for (var r = 0; r < results.length; r++) if (!results[r].passed) failed++;
  return { passed: results.length - failed, failed: failed, results: results };
}

function rhTestAssert_(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

function rhTestAssertEqual_(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(
      (message || 'Expected equal values') +
      '\nexpected: ' + JSON.stringify(expected) +
      '\nactual:   ' + JSON.stringify(actual)
    );
  }
}

function rhTestAssertThrows_(fn, code) {
  try {
    fn();
  } catch (err) {
    if (code && (!err || err.code !== code)) {
      throw new Error(
        'Expected ' + code + ' but got ' + (err && err.code ? err.code : 'no code') +
        ': ' + (err && err.message ? err.message : err)
      );
    }
    return err;
  }
  throw new Error('Expected ' + (code || 'an error') + ' to be thrown');
}

function rhTestPrepareEmpty_() {
  rhWriteFailurePlan_ = null;
  rhLockForceFailure_ = null;
  if (LockService.__reset) LockService.__reset();
  if (UrlFetchApp.__reset) UrlFetchApp.__reset();
  var testId = PropertiesService.getScriptProperties().getProperty('TEST_SPREADSHEET_ID');
  rhExecutionSpreadsheetOverride_ = testId;
  if (!rhTestHmacKey_) rhTestHmacKey_ = Utilities.getUuid() + Utilities.getUuid();
  rhTestWipe_();
  return rhTestEnsureAdminIdentity_();
}

function rhTestEnsureAdminIdentity_() {
  if (Session.__setActiveUser) {
    Session.__setActiveUser('admin@restoringhope.test');
    return 'admin@restoringhope.test';
  }
  var email = String(Session.getActiveUser().getEmail() || '').toLowerCase();
  if (!email) throw new Error('The active Google account did not provide an email.');
  return email;
}

function rhTestWipe_() {
  var ss = SpreadsheetApp.openById(rhGetSpreadsheetId_());
  var sheets = ss.getSheets();
  var keeper = sheets[0];
  for (var i = 1; i < sheets.length; i++) ss.deleteSheet(sheets[i]);
  keeper.clear();
  keeper.setName('Sheet1');
}

function rhTestBoot_() {
  var adminEmail = rhTestPrepareEmpty_();
  initializeDatabase({ bootstrapAdmin: { fullName: 'Ada Admin', email: adminEmail } });
  var locations = {
    THRIFT: rhTestLocationByType_('THRIFT'),
    BOUTIQUE: rhTestLocationByType_('BOUTIQUE'),
    CAFE: rhTestLocationByType_('CAFE')
  };
  var adminToken = rhIssueTestToken_(adminEmail);
  createEmployee({
    idToken: adminToken,
    fullName: 'Mia Manager',
    email: 'manager@restoringhope.test',
    role: 'MANAGER',
    locationId: locations.THRIFT.location_id
  });
  createEmployee({
    idToken: adminToken,
    fullName: 'Evan Employee',
    email: 'employee@restoringhope.test',
    role: 'EMPLOYEE',
    locationId: locations.THRIFT.location_id
  });
  createEmployee({
    idToken: adminToken,
    fullName: 'Casey Cafe',
    email: 'cafe@restoringhope.test',
    role: 'EMPLOYEE',
    locationId: locations.CAFE.location_id
  });
  return {
    adminEmail: adminEmail,
    adminToken: adminToken,
    managerToken: rhIssueTestToken_('manager@restoringhope.test'),
    employeeToken: rhIssueTestToken_('employee@restoringhope.test'),
    cafeToken: rhIssueTestToken_('cafe@restoringhope.test'),
    locations: locations
  };
}

function rhTestLocationByType_(type) {
  var records = rhReadSheet_(rhOpenContext_(), RH_SHEET.LOCATIONS).records;
  for (var i = 0; i < records.length; i++) {
    if (records[i].location_type === type) return records[i];
  }
  throw new Error('Missing location type ' + type);
}

function rhTestKey_(prefix) {
  return prefix + '-' + Utilities.getUuid();
}

function rhTestSell_(fx, amountCents) {
  var issued = createGiftCard({
    idToken: fx.employeeToken,
    locationId: fx.locations.THRIFT.location_id,
    initialAmountCents: amountCents,
    cardType: 'PHYSICAL',
    idempotencyKey: rhTestKey_('issue'),
    customerName: 'Jordan Customer',
    customerEmail: 'jordan@example.com'
  });
  var activated = activateGiftCard({
    idToken: fx.employeeToken,
    cardId: issued.card.card_id,
    locationId: fx.locations.THRIFT.location_id,
    paymentConfirmed: true,
    idempotencyKey: rhTestKey_('activate')
  });
  activated.qrToken = issued.card.qr_token;
  return activated;
}

function rhTestCount_(sheetName) {
  return rhReadSheet_(rhOpenContext_(), sheetName).records.length;
}

function rhTestAuditText_() {
  var records = rhReadSheet_(rhOpenContext_(), RH_SHEET.AUDIT_LOG).records;
  var chunks = [];
  for (var i = 0; i < records.length; i++) chunks.push(records[i].details);
  return chunks.join('\n');
}

function testInitializeSeedsLocations() {
  var email = rhTestEnsureAdminIdentity_();
  var result = initializeDatabase({ bootstrapAdmin: { fullName: 'Ada Admin', email: email } });
  rhTestAssertEqual_(result.moneyUnit, 'integer_cents');
  rhTestAssertEqual_(result.locations.length, 3);
  var types = result.locations.map(function (location) { return location.location_type; }).sort();
  rhTestAssertEqual_(types.join(','), 'BOUTIQUE,CAFE,THRIFT');
  rhTestAssertEqual_(result.locations[0].address, '');
  rhTestAssertEqual_(result.bootstrapAdmin.role, 'ADMIN');
  rhTestAssertEqual_(result.bootstrapAdmin.email, email);
}

function testInitializeIsIdempotent() {
  initializeDatabase();
  initializeDatabase();
  rhTestAssertEqual_(rhTestCount_(RH_SHEET.LOCATIONS), 3);
}

function testBootstrapAdminRequiresMatchingGoogleIdentity() {
  var email = rhTestEnsureAdminIdentity_();
  var result = initializeDatabase({ bootstrapAdmin: { fullName: 'Ada Admin', email: email } });
  rhTestAssertEqual_(result.bootstrapAdmin.email, email);
  var again = initializeDatabase({ bootstrapAdmin: { fullName: 'Ada Admin', email: email } });
  rhTestAssertEqual_(again.bootstrapAdmin.employee_id, result.bootstrapAdmin.employee_id);
  rhTestAssertEqual_(rhTestCount_(RH_SHEET.EMPLOYEES), 1);
}

function testBootstrapAdminRejectsMismatchedEmail() {
  if (Session.__setActiveUser) Session.__setActiveUser('someoneelse@restoringhope.test');
  rhTestAssertThrows_(function () {
    initializeDatabase({ bootstrapAdmin: { fullName: 'Ada Admin', email: 'admin@restoringhope.test' } });
  }, 'FORBIDDEN');
  rhTestAssertEqual_(rhTestCount_(RH_SHEET.EMPLOYEES), 0);
}

function testCreateGiftCardIsPendingWithZeroBalance() {
  var fx = rhTestBoot_();
  var first = createGiftCard({
    idToken: fx.employeeToken,
    email: fx.adminEmail,
    locationId: fx.locations.THRIFT.location_id,
    initialAmountCents: 2500,
    cardType: 'DIGITAL',
    idempotencyKey: 'create-card-same-key',
    customerName: 'Jordan Customer',
    customerEmail: 'jordan@example.com',
    qrToken: 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
    cardNumber: 'RH-AAAA-AAAA-AAAA'
  });
  rhTestAssertEqual_(first.card.status, 'PENDING');
  rhTestAssertEqual_(first.card.current_balance, 0);
  rhTestAssertEqual_(first.card.initial_amount, 2500);
  rhTestAssertEqual_(first.card.money_unit, 'integer_cents');
  rhTestAssertEqual_(first.transaction.transaction_type, 'ISSUE');
  rhTestAssertEqual_(first.transaction.balance_before_cents, 0);
  rhTestAssertEqual_(first.transaction.balance_after_cents, 0);
  rhTestAssert_(first.card.qr_token && first.card.qr_token.length === 64, 'QR token should be 64 hex characters');
  rhTestAssert_(first.card.qr_token !== 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff', 'Client cannot choose the QR token');
  rhTestAssert_(first.card.card_number !== 'RH-AAAA-AAAA-AAAA', 'Client cannot choose the card number');
  rhTestAssert_(first.card.qr_payload.indexOf('rhgc:v1:') === 0, 'QR payload is an opaque token');
  rhTestAssert_(first.card.qr_payload.indexOf('Jordan') === -1, 'QR payload contains customer data');
  var replay = createGiftCard({
    idToken: fx.employeeToken,
    locationId: fx.locations.THRIFT.location_id,
    initialAmountCents: 2500,
    cardType: 'DIGITAL',
    idempotencyKey: 'create-card-same-key',
    customerName: 'Jordan Customer',
    customerEmail: 'jordan@example.com'
  });
  rhTestAssertEqual_(replay.replayed, true);
  rhTestAssertEqual_(replay.card.card_id, first.card.card_id);
  rhTestAssertEqual_(replay.card.qr_token, first.card.qr_token);
  rhTestAssertEqual_(rhTestCount_(RH_SHEET.GIFT_CARDS), 1);
}

function testBlankSeriesGetsNumbersAndABalanceAtPurchase() {
  var fx = rhTestBoot_();
  rhTestAssertThrows_(function () {
    createBlankGiftCards({
      idToken: fx.employeeToken,
      locationId: fx.locations.THRIFT.location_id,
      count: 2,
      idempotencyKey: 'blank-series-employee'
    });
  }, 'FORBIDDEN');
  rhTestAssertThrows_(function () {
    createBlankGiftCards({
      idToken: fx.managerToken,
      locationId: fx.locations.THRIFT.location_id,
      count: 0,
      idempotencyKey: 'blank-series-zero'
    });
  }, 'VALIDATION');
  var series = createBlankGiftCards({
    idToken: fx.managerToken,
    locationId: fx.locations.THRIFT.location_id,
    count: 3,
    cardType: 'PHYSICAL',
    idempotencyKey: 'blank-series-once',
    cardNumber: 'RH-AAAA-AAAA-AAAA',
    qrToken: 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
  });
  rhTestAssertEqual_(series.count, 3);
  rhTestAssertEqual_(series.replayed, false);
  rhTestAssertEqual_(series.cards.length, 3);
  var seen = {};
  for (var i = 0; i < series.cards.length; i++) {
    var blank = series.cards[i];
    rhTestAssertEqual_(blank.status, 'PENDING');
    rhTestAssertEqual_(blank.current_balance, 0);
    rhTestAssertEqual_(blank.initial_amount, 0);
    rhTestAssertEqual_(blank.card_number === 'RH-AAAA-AAAA-AAAA', false);
    rhTestAssert_(blank.qr_payload.indexOf('rhgc:v1:') === 0, 'Blank card should carry a printable payload');
    rhTestAssertEqual_(seen[blank.card_number], undefined);
    rhTestAssertEqual_(seen[blank.qr_token], undefined);
    seen[blank.card_number] = true;
    seen[blank.qr_token] = true;
  }
  rhTestAssert_(rhTestAuditText_().indexOf(series.cards[0].qr_token) === -1, 'Audit log contains a QR token');
  var beforeSale = getOutstandingGiftCardBalance({ idToken: fx.adminToken });
  rhTestAssertEqual_(beforeSale.outstanding_liability_cents, 0);
  var unsold = getGiftCardSalesReport({ idToken: fx.adminToken });
  rhTestAssertEqual_(unsold.issued_count, 3);
  rhTestAssertEqual_(unsold.value_sold_cents, 0);
  rhTestAssertThrows_(function () {
    activateGiftCard({
      idToken: fx.employeeToken,
      cardId: series.cards[0].card_id,
      locationId: fx.locations.THRIFT.location_id,
      paymentConfirmed: true,
      idempotencyKey: 'blank-activate-no-amount'
    });
  }, 'VALIDATION');
  rhTestAssertEqual_(checkGiftCardBalance({ idToken: fx.employeeToken, cardId: series.cards[0].card_id }).current_balance, 0);
  var sold = activateGiftCard({
    idToken: fx.employeeToken,
    cardId: series.cards[0].card_id,
    locationId: fx.locations.THRIFT.location_id,
    paymentConfirmed: true,
    amountCents: 2500,
    idempotencyKey: 'blank-activate-once'
  });
  rhTestAssertEqual_(sold.card.status, 'ACTIVE');
  rhTestAssertEqual_(sold.card.current_balance, 2500);
  rhTestAssertEqual_(sold.card.initial_amount, 2500);
  rhTestAssertEqual_(sold.transaction.balance_before_cents, 0);
  rhTestAssertEqual_(sold.transaction.balance_after_cents, 2500);
  var replaySale = activateGiftCard({
    idToken: fx.employeeToken,
    cardId: series.cards[0].card_id,
    locationId: fx.locations.THRIFT.location_id,
    paymentConfirmed: true,
    amountCents: 2500,
    idempotencyKey: 'blank-activate-once'
  });
  rhTestAssertEqual_(replaySale.replayed, true);
  rhTestAssertEqual_(replaySale.card.current_balance, 2500);
  rhTestAssertThrows_(function () {
    activateGiftCard({
      idToken: fx.employeeToken,
      cardId: series.cards[0].card_id,
      locationId: fx.locations.THRIFT.location_id,
      paymentConfirmed: true,
      amountCents: 1000,
      idempotencyKey: 'blank-activate-once'
    });
  }, 'VALIDATION');
  rhTestAssertEqual_(checkGiftCardBalance({ idToken: fx.employeeToken, cardId: series.cards[1].card_id }).current_balance, 0);
  var afterSale = getOutstandingGiftCardBalance({ idToken: fx.adminToken });
  rhTestAssertEqual_(afterSale.outstanding_liability_cents, 2500);
  var sales = getGiftCardSalesReport({ idToken: fx.adminToken });
  rhTestAssertEqual_(sales.issued_count, 3);
  rhTestAssertEqual_(sales.activated_count, 1);
  rhTestAssertEqual_(sales.value_sold_cents, 2500);
  var replay = createBlankGiftCards({
    idToken: fx.managerToken,
    locationId: fx.locations.THRIFT.location_id,
    count: 3,
    cardType: 'PHYSICAL',
    idempotencyKey: 'blank-series-once'
  });
  rhTestAssertEqual_(replay.replayed, true);
  rhTestAssertEqual_(replay.cards[0].card_number, series.cards[0].card_number);
  rhTestAssertEqual_(replay.cards[2].qr_token, series.cards[2].qr_token);
  rhTestAssertEqual_(rhTestCount_(RH_SHEET.GIFT_CARDS), 3);
  rhTestAssertThrows_(function () {
    createBlankGiftCards({
      idToken: fx.managerToken,
      locationId: fx.locations.THRIFT.location_id,
      count: 2,
      cardType: 'PHYSICAL',
      idempotencyKey: 'blank-series-once'
    });
  }, 'IDEMPOTENCY_CONFLICT');
  var priced = createGiftCard({
    idToken: fx.employeeToken,
    locationId: fx.locations.THRIFT.location_id,
    initialAmountCents: 5000,
    cardType: 'PHYSICAL',
    idempotencyKey: rhTestKey_('priced')
  });
  rhTestAssertThrows_(function () {
    activateGiftCard({
      idToken: fx.employeeToken,
      cardId: priced.card.card_id,
      locationId: fx.locations.THRIFT.location_id,
      paymentConfirmed: true,
      amountCents: 1000,
      idempotencyKey: rhTestKey_('priced-activate')
    });
  }, 'VALIDATION');
  rhTestAssertEqual_(checkGiftCardBalance({ idToken: fx.employeeToken, cardId: priced.card.card_id }).current_balance, 0);
}

function testActivationRequiresPaymentConfirmation() {
  var fx = rhTestBoot_();
  var issued = createGiftCard({
    idToken: fx.employeeToken,
    locationId: fx.locations.THRIFT.location_id,
    initialAmountCents: 5000,
    cardType: 'PHYSICAL',
    idempotencyKey: rhTestKey_('issue')
  });
  rhTestAssertThrows_(function () {
    activateGiftCard({
      idToken: fx.employeeToken,
      cardId: issued.card.card_id,
      locationId: fx.locations.THRIFT.location_id,
      paymentConfirmed: false,
      idempotencyKey: rhTestKey_('activate-no')
    });
  }, 'VALIDATION');
  rhTestAssertThrows_(function () {
    activateGiftCard({
      idToken: fx.employeeToken,
      cardId: issued.card.card_id,
      locationId: fx.locations.THRIFT.location_id,
      paymentConfirmed: 'true',
      idempotencyKey: rhTestKey_('activate-string')
    });
  }, 'VALIDATION');
  var balance = checkGiftCardBalance({ idToken: fx.employeeToken, cardId: issued.card.card_id });
  rhTestAssertEqual_(balance.current_balance, 0);
  rhTestAssertEqual_(balance.status, 'PENDING');
  var activated = activateGiftCard({
    idToken: fx.employeeToken,
    cardId: issued.card.card_id,
    locationId: fx.locations.THRIFT.location_id,
    paymentConfirmed: true,
    idempotencyKey: 'activate-once'
  });
  rhTestAssertEqual_(activated.card.status, 'ACTIVE');
  rhTestAssertEqual_(activated.card.current_balance, 5000);
  rhTestAssertEqual_(activated.transaction.balance_before_cents, 0);
  rhTestAssertEqual_(activated.transaction.balance_after_cents, 5000);
  var replay = activateGiftCard({
    idToken: fx.employeeToken,
    cardId: issued.card.card_id,
    locationId: fx.locations.THRIFT.location_id,
    paymentConfirmed: true,
    idempotencyKey: 'activate-once'
  });
  rhTestAssertEqual_(replay.replayed, true);
  rhTestAssertEqual_(replay.card.current_balance, 5000);
}

function testSuccessfulRedemption() {
  var fx = rhTestBoot_();
  var sold = rhTestSell_(fx, 5000);
  var redeemed = redeemGiftCard({
    idToken: fx.employeeToken,
    cardId: sold.card.card_id,
    amountCents: 1250,
    locationId: fx.locations.THRIFT.location_id,
    idempotencyKey: rhTestKey_('redeem'),
    registerReference: 'REG-1'
  });
  rhTestAssertEqual_(redeemed.card.current_balance, 3750);
  rhTestAssertEqual_(redeemed.card.status, 'ACTIVE');
  rhTestAssertEqual_(redeemed.transaction.balance_before_cents, 5000);
  rhTestAssertEqual_(redeemed.transaction.balance_after_cents, 3750);
  rhTestAssertEqual_(redeemed.transaction.transaction_status, 'COMPLETED');
  rhTestAssertEqual_(redeemed.transaction.register_reference, 'REG-1');
}

function testInsufficientFundsLeavesBalanceUnchanged() {
  var fx = rhTestBoot_();
  var sold = rhTestSell_(fx, 5000);
  var before = rhTestCount_(RH_SHEET.TRANSACTIONS);
  rhTestAssertThrows_(function () {
    redeemGiftCard({
      idToken: fx.employeeToken,
      cardId: sold.card.card_id,
      amountCents: 5001,
      locationId: fx.locations.THRIFT.location_id,
      idempotencyKey: rhTestKey_('redeem-short')
    });
  }, 'INSUFFICIENT_FUNDS');
  var balance = checkGiftCardBalance({ idToken: fx.employeeToken, cardId: sold.card.card_id });
  rhTestAssertEqual_(balance.current_balance, 5000);
  rhTestAssertEqual_(rhTestCount_(RH_SHEET.TRANSACTIONS), before);
}

function testDuplicateRedemptionIsIdempotent() {
  var fx = rhTestBoot_();
  var sold = rhTestSell_(fx, 4000);
  var request = {
    idToken: fx.employeeToken,
    cardId: sold.card.card_id,
    amountCents: 1500,
    locationId: fx.locations.THRIFT.location_id,
    idempotencyKey: 'redeem-duplicate-key'
  };
  var first = redeemGiftCard(request);
  var second = redeemGiftCard(request);
  rhTestAssertEqual_(first.replayed, false);
  rhTestAssertEqual_(second.replayed, true);
  rhTestAssertEqual_(second.transaction.transaction_id, first.transaction.transaction_id);
  rhTestAssertEqual_(second.card.current_balance, 2500);
  var history = getTransactionHistory({ idToken: fx.employeeToken, cardId: sold.card.card_id });
  var redeems = history.transactions.filter(function (txn) { return txn.transaction_type === 'REDEEM'; });
  rhTestAssertEqual_(redeems.length, 1);
}

function testIdempotencyKeyRejectsADifferentPayload() {
  var fx = rhTestBoot_();
  var sold = rhTestSell_(fx, 4000);
  redeemGiftCard({
    idToken: fx.employeeToken,
    cardId: sold.card.card_id,
    amountCents: 1000,
    locationId: fx.locations.THRIFT.location_id,
    idempotencyKey: 'redeem-conflict-key'
  });
  rhTestAssertThrows_(function () {
    redeemGiftCard({
      idToken: fx.employeeToken,
      cardId: sold.card.card_id,
      amountCents: 2000,
      locationId: fx.locations.THRIFT.location_id,
      idempotencyKey: 'redeem-conflict-key'
    });
  }, 'IDEMPOTENCY_CONFLICT');
  rhTestAssertEqual_(checkGiftCardBalance({ idToken: fx.employeeToken, cardId: sold.card.card_id }).current_balance, 3000);
}

function testReloadRevivesDepletedCard() {
  var fx = rhTestBoot_();
  var sold = rhTestSell_(fx, 2000);
  redeemGiftCard({
    idToken: fx.employeeToken,
    cardId: sold.card.card_id,
    amountCents: 2000,
    locationId: fx.locations.THRIFT.location_id,
    idempotencyKey: rhTestKey_('redeem-all')
  });
  rhTestAssertEqual_(checkGiftCardBalance({ idToken: fx.employeeToken, cardId: sold.card.card_id }).status, 'DEPLETED');
  rhTestAssertThrows_(function () {
    reloadGiftCard({
      idToken: fx.employeeToken,
      cardId: sold.card.card_id,
      amountCents: 500,
      locationId: fx.locations.THRIFT.location_id,
      paymentConfirmed: false,
      idempotencyKey: rhTestKey_('reload-unpaid')
    });
  }, 'VALIDATION');
  var reloaded = reloadGiftCard({
    idToken: fx.employeeToken,
    cardId: sold.card.card_id,
    amountCents: 750,
    locationId: fx.locations.THRIFT.location_id,
    paymentConfirmed: true,
    idempotencyKey: rhTestKey_('reload')
  });
  rhTestAssertEqual_(reloaded.card.status, 'ACTIVE');
  rhTestAssertEqual_(reloaded.card.current_balance, 750);
  rhTestAssertEqual_(reloaded.transaction.transaction_type, 'RELOAD');
}

function testRefundRestoresRedeemedValue() {
  var fx = rhTestBoot_();
  var sold = rhTestSell_(fx, 5000);
  var redeemed = redeemGiftCard({
    idToken: fx.cafeToken,
    cardId: sold.card.card_id,
    amountCents: 2000,
    locationId: fx.locations.CAFE.location_id,
    idempotencyKey: rhTestKey_('redeem')
  });
  var refunded = refundGiftCardTransaction({
    idToken: fx.managerToken,
    transactionId: redeemed.transaction.transaction_id,
    amountCents: 500,
    locationId: fx.locations.THRIFT.location_id,
    idempotencyKey: rhTestKey_('refund')
  });
  rhTestAssertEqual_(refunded.card.current_balance, 3500);
  rhTestAssertEqual_(refunded.transaction.transaction_type, 'REFUND');
  rhTestAssertEqual_(refunded.transaction.related_transaction_id, redeemed.transaction.transaction_id);
  rhTestAssertEqual_(refunded.transaction.balance_before_cents, 3000);
  rhTestAssertEqual_(refunded.transaction.balance_after_cents, 3500);
  var outstanding = getOutstandingGiftCardBalance({ idToken: fx.adminToken });
  rhTestAssertEqual_(outstanding.outstanding_liability_cents, 3500);
  rhTestAssertEqual_(outstanding.computed_from_transactions_cents, 3500);
  rhTestAssertEqual_(outstanding.in_sync, true);
}

function testRefundCannotExceedOriginal() {
  var fx = rhTestBoot_();
  var sold = rhTestSell_(fx, 5000);
  var redeemed = redeemGiftCard({
    idToken: fx.employeeToken,
    cardId: sold.card.card_id,
    amountCents: 2000,
    locationId: fx.locations.THRIFT.location_id,
    idempotencyKey: rhTestKey_('redeem')
  });
  refundGiftCardTransaction({
    idToken: fx.adminToken,
    transactionId: redeemed.transaction.transaction_id,
    amountCents: 1500,
    locationId: fx.locations.THRIFT.location_id,
    idempotencyKey: rhTestKey_('refund-part')
  });
  rhTestAssertThrows_(function () {
    refundGiftCardTransaction({
      idToken: fx.adminToken,
      transactionId: redeemed.transaction.transaction_id,
      amountCents: 600,
      locationId: fx.locations.THRIFT.location_id,
      idempotencyKey: rhTestKey_('refund-over')
    });
  }, 'VALIDATION');
  rhTestAssertEqual_(checkGiftCardBalance({ idToken: fx.employeeToken, cardId: sold.card.card_id }).current_balance, 4500);
}

function testSuspendedCardCannotBeRedeemed() {
  var fx = rhTestBoot_();
  var sold = rhTestSell_(fx, 5000);
  rhTestAssertThrows_(function () {
    suspendGiftCard({ idToken: fx.employeeToken, cardId: sold.card.card_id });
  }, 'FORBIDDEN');
  var suspended = suspendGiftCard({ idToken: fx.managerToken, cardId: sold.card.card_id });
  rhTestAssertEqual_(suspended.card.status, 'SUSPENDED');
  rhTestAssertThrows_(function () {
    redeemGiftCard({
      idToken: fx.employeeToken,
      cardId: sold.card.card_id,
      amountCents: 100,
      locationId: fx.locations.THRIFT.location_id,
      idempotencyKey: rhTestKey_('redeem-suspended')
    });
  }, 'INVALID_STATE');
  rhTestAssertEqual_(checkGiftCardBalance({ idToken: fx.employeeToken, cardId: sold.card.card_id }).current_balance, 5000);
  var liability = getOutstandingGiftCardBalance({ idToken: fx.managerToken });
  rhTestAssertEqual_(liability.suspended_balance_cents, 5000);
  rhTestAssertEqual_(liability.outstanding_liability_cents, 5000);
}

function testUnauthorizedAccessIsDenied() {
  var fx = rhTestBoot_();
  rhTestAssertThrows_(function () {
    createGiftCard({
      locationId: fx.locations.THRIFT.location_id,
      initialAmountCents: 1000,
      cardType: 'PHYSICAL',
      idempotencyKey: rhTestKey_('no-auth'),
      email: fx.adminEmail
    });
  }, 'UNAUTHENTICATED');
  rhTestAssertThrows_(function () {
    createLocation({
      idToken: fx.employeeToken,
      locationName: 'Not Allowed',
      locationType: 'OTHER'
    });
  }, 'FORBIDDEN');
  rhTestAssertThrows_(function () {
    refundGiftCardTransaction({
      idToken: fx.employeeToken,
      transactionId: Utilities.getUuid(),
      amountCents: 100,
      locationId: fx.locations.THRIFT.location_id,
      idempotencyKey: rhTestKey_('refund-denied')
    });
  }, 'FORBIDDEN');
  rhTestAssertThrows_(function () {
    getGiftCardSalesReport({ idToken: fx.employeeToken });
  }, 'FORBIDDEN');
  rhTestAssertThrows_(function () {
    updateEmployeeAccess({
      idToken: fx.adminToken,
      employeeId: rhReadSheet_(rhOpenContext_(), RH_SHEET.EMPLOYEES).records.filter(function (employee) {
        return employee.role === 'ADMIN';
      })[0].employee_id,
      isActive: false
    });
  }, 'INVALID_STATE');
  var failed = rhReadSheet_(rhOpenContext_(), RH_SHEET.AUDIT_LOG).records.filter(function (row) {
    return row.action === 'AUTH_FAILED' || row.action === 'AUTH_FORBIDDEN';
  });
  rhTestAssert_(failed.length >= 1, 'Failed authorization should be audited');
}

function testSpoofedEmailIsIgnored() {
  var fx = rhTestBoot_();
  rhTestAssertThrows_(function () {
    createLocation({
      idToken: fx.employeeToken,
      email: fx.adminEmail,
      employeeId: Utilities.getUuid(),
      locationName: 'Spoofed Store',
      locationType: 'OTHER'
    });
  }, 'FORBIDDEN');
  var names = rhReadSheet_(rhOpenContext_(), RH_SHEET.LOCATIONS).records.map(function (location) {
    return location.location_name;
  });
  rhTestAssert_(names.indexOf('Spoofed Store') === -1, 'Spoofed identity created a location');
}

function testSessionUsesVerifiedEmployee() {
  var fx = rhTestBoot_();
  var session = getSession({
    idToken: fx.employeeToken,
    email: fx.adminEmail,
    employeeId: Utilities.getUuid()
  });
  rhTestAssertEqual_(session.employee.role, 'EMPLOYEE');
  rhTestAssertEqual_(session.employee.email, 'employee@restoringhope.test');
  rhTestAssertEqual_(session.location.location_type, 'THRIFT');
  rhTestAssertEqual_(session.money_unit, 'integer_cents');
  var admin = getSession({ idToken: fx.adminToken, email: 'employee@restoringhope.test' });
  rhTestAssertEqual_(admin.employee.role, 'ADMIN');
  rhTestAssertEqual_(admin.location, null);
  rhTestAssertThrows_(function () {
    getSession({ email: fx.adminEmail });
  }, 'UNAUTHENTICATED');
}

function testRejectedGoogleTokenCannotSpoofEmail() {
  var fx = rhTestBoot_();
  UrlFetchApp.__queue({ code: 400, body: { error: 'invalid_token' } });
  rhTestAssertThrows_(function () {
    createLocation({
      idToken: 'aaa.bbb.ccc',
      email: fx.adminEmail,
      locationName: 'Forged Store',
      locationType: 'OTHER'
    });
  }, 'UNAUTHENTICATED');
  UrlFetchApp.__queue({
    code: 200,
    body: {
      aud: 'test-client-id',
      email: fx.adminEmail,
      email_verified: 'false',
      iss: 'https://accounts.google.com',
      exp: String(Math.floor(Date.now() / 1000) + 600),
      sub: 'unverified'
    }
  });
  rhTestAssertThrows_(function () {
    createLocation({
      idToken: 'unverified.google.token',
      email: fx.adminEmail,
      locationName: 'Unverified Store',
      locationType: 'OTHER'
    });
  }, 'UNAUTHENTICATED');
}

function testVerifiedGoogleTokenMapsToEmployee() {
  var fx = rhTestBoot_();
  UrlFetchApp.__queue({
    code: 200,
    body: {
      aud: 'test-client-id',
      email: 'employee@restoringhope.test',
      email_verified: 'true',
      iss: 'accounts.google.com',
      exp: String(Math.floor(Date.now() / 1000) + 600),
      sub: 'employee-sub'
    }
  });
  rhTestAssertThrows_(function () {
    createLocation({
      idToken: 'real.google.token',
      email: fx.adminEmail,
      locationName: 'Should Stay Employee',
      locationType: 'OTHER'
    });
  }, 'FORBIDDEN');
}

function testEmployeeCannotOperateAtAnotherLocation() {
  var fx = rhTestBoot_();
  var sold = rhTestSell_(fx, 3000);
  rhTestAssertThrows_(function () {
    redeemGiftCard({
      idToken: fx.employeeToken,
      cardId: sold.card.card_id,
      amountCents: 500,
      locationId: fx.locations.CAFE.location_id,
      idempotencyKey: rhTestKey_('wrong-store')
    });
  }, 'FORBIDDEN');
  rhTestAssertEqual_(checkGiftCardBalance({ idToken: fx.employeeToken, cardId: sold.card.card_id }).current_balance, 3000);
}

function testGiftCardWorksAcrossLocations() {
  var fx = rhTestBoot_();
  var sold = rhTestSell_(fx, 3000);
  var redeemed = redeemGiftCard({
    idToken: fx.cafeToken,
    qrToken: sold.qrToken,
    amountCents: 800,
    locationId: fx.locations.CAFE.location_id,
    idempotencyKey: rhTestKey_('cafe-redeem')
  });
  rhTestAssertEqual_(redeemed.card.current_balance, 2200);
  rhTestAssertEqual_(redeemed.transaction.location_id, fx.locations.CAFE.location_id);
  rhTestAssertEqual_(redeemed.card.issued_location_id, fx.locations.THRIFT.location_id);
}

function testConcurrentFullRedeemsOnlyOneSucceeds() {
  var fx = rhTestBoot_();
  var sold = rhTestSell_(fx, 1000);
  var beforeLocks = LockService.__stats ? LockService.__stats.acquisitions : 0;
  var first = redeemGiftCard({
    idToken: fx.employeeToken,
    cardId: sold.card.card_id,
    amountCents: 1000,
    locationId: fx.locations.THRIFT.location_id,
    idempotencyKey: 'concurrent-redeem-a'
  });
  rhTestAssertThrows_(function () {
    redeemGiftCard({
      idToken: fx.cafeToken,
      cardId: sold.card.card_id,
      amountCents: 1000,
      locationId: fx.locations.CAFE.location_id,
      idempotencyKey: 'concurrent-redeem-b'
    });
  }, 'INSUFFICIENT_FUNDS');
  rhTestAssertEqual_(first.card.current_balance, 0);
  rhTestAssertEqual_(first.card.status, 'DEPLETED');
  rhTestAssertEqual_(checkGiftCardBalance({ idToken: fx.adminToken, cardId: sold.card.card_id }).current_balance, 0);
  var redeems = getTransactionHistory({ idToken: fx.adminToken, cardId: sold.card.card_id }).transactions.filter(function (txn) {
    return txn.transaction_type === 'REDEEM' && txn.transaction_status === 'COMPLETED';
  });
  rhTestAssertEqual_(redeems.length, 1);
  if (LockService.__stats) {
    rhTestAssert_(LockService.__stats.acquisitions > beforeLocks, 'Redemption did not acquire the script lock');
    rhTestAssertEqual_(LockService.__stats.acquisitions, LockService.__stats.releases);
  }
}

function testLockTimeoutWritesNothing() {
  var fx = rhTestBoot_();
  var sold = rhTestSell_(fx, 2500);
  var before = rhTestCount_(RH_SHEET.TRANSACTIONS);
  LockService.__deny = true;
  rhTestAssertThrows_(function () {
    redeemGiftCard({
      idToken: fx.employeeToken,
      cardId: sold.card.card_id,
      amountCents: 100,
      locationId: fx.locations.THRIFT.location_id,
      idempotencyKey: rhTestKey_('locked')
    });
  }, 'LOCK_TIMEOUT');
  LockService.__deny = false;
  rhTestAssertEqual_(rhTestCount_(RH_SHEET.TRANSACTIONS), before);
  rhTestAssertEqual_(checkGiftCardBalance({ idToken: fx.employeeToken, cardId: sold.card.card_id }).current_balance, 2500);
}

function testPartialFailureBeforeCardUpdateIsRepaired() {
  var fx = rhTestBoot_();
  var sold = rhTestSell_(fx, 5000);
  rhWriteFailurePlan_ = { stage: 'after_pending_append' };
  rhTestAssertThrows_(function () {
    redeemGiftCard({
      idToken: fx.employeeToken,
      cardId: sold.card.card_id,
      amountCents: 2000,
      locationId: fx.locations.THRIFT.location_id,
      idempotencyKey: 'partial-before-card'
    });
  }, 'PARTIAL_FAILURE');
  var detected = detectBalanceMismatches({ idToken: fx.adminToken });
  rhTestAssertEqual_(detected.pending.length, 1);
  rhTestAssertEqual_(checkGiftCardBalance({ idToken: fx.employeeToken, cardId: sold.card.card_id }).current_balance, 5000);
  rhTestAssertThrows_(function () {
    redeemGiftCard({
      idToken: fx.employeeToken,
      cardId: sold.card.card_id,
      amountCents: 100,
      locationId: fx.locations.THRIFT.location_id,
      idempotencyKey: rhTestKey_('blocked-while-pending')
    });
  }, 'PARTIAL_FAILURE');
  var repair = repairUnambiguousPendingTransactions({ idToken: fx.adminToken });
  rhTestAssertEqual_(repair.repaired.length, 1);
  rhTestAssertEqual_(repair.repaired[0].result, 'FAILED');
  rhTestAssertEqual_(repair.ambiguous.length, 0);
  rhTestAssertThrows_(function () {
    redeemGiftCard({
      idToken: fx.employeeToken,
      cardId: sold.card.card_id,
      amountCents: 2000,
      locationId: fx.locations.THRIFT.location_id,
      idempotencyKey: 'partial-before-card'
    });
  }, 'IDEMPOTENCY_EXHAUSTED');
  var retried = redeemGiftCard({
    idToken: fx.employeeToken,
    cardId: sold.card.card_id,
    amountCents: 2000,
    locationId: fx.locations.THRIFT.location_id,
    idempotencyKey: 'partial-before-card-retry'
  });
  rhTestAssertEqual_(retried.card.current_balance, 3000);
  rhTestAssertEqual_(detectBalanceMismatches({ idToken: fx.adminToken }).in_sync, true);
}

function testPartialFailureAfterCardUpdateIsRepaired() {
  var fx = rhTestBoot_();
  var sold = rhTestSell_(fx, 5000);
  rhWriteFailurePlan_ = { stage: 'after_card_update' };
  rhTestAssertThrows_(function () {
    redeemGiftCard({
      idToken: fx.employeeToken,
      cardId: sold.card.card_id,
      amountCents: 2000,
      locationId: fx.locations.THRIFT.location_id,
      idempotencyKey: 'partial-after-card'
    });
  }, 'PARTIAL_FAILURE');
  var midway = detectBalanceMismatches({ idToken: fx.adminToken });
  rhTestAssertEqual_(midway.pending.length, 1);
  rhTestAssert_(midway.mismatch_count >= 1, 'Applied card write should disagree with the completed ledger until repair');
  rhTestAssertThrows_(function () {
    repairUnambiguousPendingTransactions({ idToken: fx.employeeToken });
  }, 'FORBIDDEN');
  var repair = repairUnambiguousPendingTransactions({ idToken: fx.adminToken });
  rhTestAssertEqual_(repair.repaired.length, 1);
  rhTestAssertEqual_(repair.repaired[0].result, 'COMPLETED');
  rhTestAssertEqual_(checkGiftCardBalance({ idToken: fx.employeeToken, cardId: sold.card.card_id }).current_balance, 3000);
  var clean = detectBalanceMismatches({ idToken: fx.adminToken });
  rhTestAssertEqual_(clean.in_sync, true);
  rhTestAssertEqual_(clean.mismatch_count, 0);
  rhTestAssertEqual_(clean.pending.length, 0);
}

function testAmbiguousPartialWriteIsNotGuessed() {
  var fx = rhTestBoot_();
  var sold = rhTestSell_(fx, 5000);
  rhWriteFailurePlan_ = { stage: 'after_card_update' };
  rhTestAssertThrows_(function () {
    redeemGiftCard({
      idToken: fx.employeeToken,
      cardId: sold.card.card_id,
      amountCents: 2000,
      locationId: fx.locations.THRIFT.location_id,
      idempotencyKey: rhTestKey_('ambiguous')
    });
  }, 'PARTIAL_FAILURE');
  rhTestSetBalance_(sold.card.card_id, 1111);
  var repair = repairUnambiguousPendingTransactions({ idToken: fx.adminToken });
  rhTestAssertEqual_(repair.repaired.length, 0);
  rhTestAssertEqual_(repair.ambiguous.length, 1);
  rhTestAssertEqual_(checkGiftCardBalance({ idToken: fx.adminToken, cardId: sold.card.card_id }).current_balance, 1111);
  rhTestAssertThrows_(function () {
    restoreCardBalanceFromLedger({ idToken: fx.adminToken, cardId: sold.card.card_id });
  }, 'PARTIAL_FAILURE');
}

function testTamperedBalanceIsDetectedAndRestored() {
  var fx = rhTestBoot_();
  var sold = rhTestSell_(fx, 5000);
  var beforeTxns = rhTestCount_(RH_SHEET.TRANSACTIONS);
  rhTestSetBalance_(sold.card.card_id, 9999);
  var detected = detectBalanceMismatches({ idToken: fx.managerToken });
  rhTestAssertEqual_(detected.in_sync, false);
  rhTestAssertEqual_(detected.cards.length, 1);
  rhTestAssertEqual_(detected.cards[0].current_balance, 9999);
  rhTestAssertEqual_(detected.cards[0].computed_balance, 5000);
  rhTestAssertThrows_(function () {
    restoreCardBalanceFromLedger({ idToken: fx.employeeToken, cardId: sold.card.card_id });
  }, 'FORBIDDEN');
  var restored = restoreCardBalanceFromLedger({ idToken: fx.adminToken, cardId: sold.card.card_id });
  rhTestAssertEqual_(restored.changed, true);
  rhTestAssertEqual_(restored.card.current_balance, 5000);
  rhTestAssertEqual_(restored.card.status, 'ACTIVE');
  rhTestAssertEqual_(rhTestCount_(RH_SHEET.TRANSACTIONS), beforeTxns);
  rhTestAssertEqual_(detectBalanceMismatches({ idToken: fx.adminToken }).in_sync, true);
  rhTestAssert_(rhTestAuditText_().indexOf('BALANCE_RESTORED') === -1, 'Audit action is the action column, not the details');
  var actions = rhReadSheet_(rhOpenContext_(), RH_SHEET.AUDIT_LOG).records.map(function (row) { return row.action; });
  rhTestAssert_(actions.indexOf('BALANCE_RESTORED') !== -1, 'Balance restoration should be audited');
}

function testReportsDoNotDoubleCountIssueAndActivation() {
  var fx = rhTestBoot_();
  var sold = rhTestSell_(fx, 5000);
  redeemGiftCard({
    idToken: fx.cafeToken,
    cardId: sold.card.card_id,
    amountCents: 2000,
    locationId: fx.locations.CAFE.location_id,
    idempotencyKey: rhTestKey_('redeem-report')
  });
  var sales = getGiftCardSalesReport({ idToken: fx.adminToken });
  rhTestAssertEqual_(sales.issued_count, 1);
  rhTestAssertEqual_(sales.activated_count, 1);
  rhTestAssertEqual_(sales.value_sold_cents, 5000);
  rhTestAssert_(sales.daily.length >= 1, 'Sales report should include a daily total');
  rhTestAssert_(sales.employees.length >= 1, 'Sales report should include employee activity');
  var redemptions = getGiftCardRedemptionReport({ idToken: fx.adminToken });
  rhTestAssertEqual_(redemptions.value_redeemed_cents, 2000);
  var thriftRedemptions = getGiftCardRedemptionReport({ idToken: fx.managerToken });
  rhTestAssertEqual_(thriftRedemptions.location_id, fx.locations.THRIFT.location_id);
  rhTestAssertEqual_(thriftRedemptions.value_redeemed_cents, 0);
  rhTestAssertThrows_(function () {
    getGiftCardRedemptionReport({
      idToken: fx.managerToken,
      locationId: fx.locations.CAFE.location_id
    });
  }, 'FORBIDDEN');
  var outstanding = getOutstandingGiftCardBalance({ idToken: fx.adminToken });
  rhTestAssertEqual_(outstanding.outstanding_liability_cents, 3000);
  rhTestAssertEqual_(outstanding.computed_from_transactions_cents, 3000);
  rhTestAssertEqual_(outstanding.in_sync, true);
  var locationFeed = getLocationTransactions({
    idToken: fx.managerToken,
    locationId: fx.locations.THRIFT.location_id
  });
  rhTestAssert_(locationFeed.transactions.length >= 1, 'Location feed should include the sale');
}

function testRefundOfActivationReducesSales() {
  var fx = rhTestBoot_();
  var sold = rhTestSell_(fx, 5000);
  var history = getTransactionHistory({ idToken: fx.adminToken, cardId: sold.card.card_id });
  var activation = history.transactions.filter(function (txn) { return txn.transaction_type === 'ACTIVATE'; })[0];
  var refunded = refundGiftCardTransaction({
    idToken: fx.adminToken,
    transactionId: activation.transaction_id,
    amountCents: 1000,
    locationId: fx.locations.THRIFT.location_id,
    idempotencyKey: rhTestKey_('refund-sale')
  });
  rhTestAssertEqual_(refunded.card.current_balance, 4000);
  rhTestAssertEqual_(getGiftCardSalesReport({ idToken: fx.adminToken }).value_sold_cents, 4000);
  rhTestAssertEqual_(getOutstandingGiftCardBalance({ idToken: fx.adminToken }).outstanding_liability_cents, 4000);
  rhTestAssertThrows_(function () {
    voidGiftCardTransaction({
      idToken: fx.adminToken,
      transactionId: activation.transaction_id,
      locationId: fx.locations.THRIFT.location_id,
      idempotencyKey: rhTestKey_('void-after-refund'),
      notes: 'Cannot void a sale that was already refunded'
    });
  }, 'INVALID_STATE');
  rhTestAssertEqual_(checkGiftCardBalance({ idToken: fx.adminToken, cardId: sold.card.card_id }).current_balance, 4000);
}

function testVoidRedeemNetsOutOfRedemptionReport() {
  var fx = rhTestBoot_();
  var sold = rhTestSell_(fx, 5000);
  var redeemed = redeemGiftCard({
    idToken: fx.employeeToken,
    cardId: sold.card.card_id,
    amountCents: 1000,
    locationId: fx.locations.THRIFT.location_id,
    idempotencyKey: rhTestKey_('redeem-void')
  });
  rhTestAssertThrows_(function () {
    voidGiftCardTransaction({
      idToken: fx.managerToken,
      transactionId: redeemed.transaction.transaction_id,
      locationId: fx.locations.THRIFT.location_id,
      idempotencyKey: rhTestKey_('void-denied'),
      notes: 'Manager cannot void'
    });
  }, 'FORBIDDEN');
  var voided = voidGiftCardTransaction({
    idToken: fx.adminToken,
    transactionId: redeemed.transaction.transaction_id,
    locationId: fx.locations.THRIFT.location_id,
    idempotencyKey: rhTestKey_('void'),
    notes: 'Register posted the wrong card'
  });
  rhTestAssertEqual_(voided.card.current_balance, 5000);
  rhTestAssertEqual_(voided.transaction.transaction_type, 'VOID');
  rhTestAssertEqual_(voided.transaction.related_transaction_id, redeemed.transaction.transaction_id);
  var history = getTransactionHistory({ idToken: fx.adminToken, cardId: sold.card.card_id });
  var original = history.transactions.filter(function (txn) {
    return txn.transaction_id === redeemed.transaction.transaction_id;
  })[0];
  rhTestAssertEqual_(original.transaction_status, 'VOIDED');
  rhTestAssertEqual_(getGiftCardSalesReport({ idToken: fx.adminToken }).value_sold_cents, 5000);
  rhTestAssertEqual_(getGiftCardRedemptionReport({ idToken: fx.adminToken }).value_redeemed_cents, 0);
  var outstanding = getOutstandingGiftCardBalance({ idToken: fx.adminToken });
  rhTestAssertEqual_(outstanding.outstanding_liability_cents, 5000);
  rhTestAssertEqual_(outstanding.computed_from_transactions_cents, 5000);
  rhTestAssertEqual_(outstanding.in_sync, true);
}

function testQrTokenIsUnpredictableAndAbsentFromAudit() {
  var fx = rhTestBoot_();
  var first = createGiftCard({
    idToken: fx.employeeToken,
    locationId: fx.locations.THRIFT.location_id,
    initialAmountCents: 2500,
    cardType: 'PHYSICAL',
    idempotencyKey: rhTestKey_('qr-a'),
    customerName: 'Jordan Customer',
    customerEmail: 'jordan@example.com'
  });
  var second = createGiftCard({
    idToken: fx.employeeToken,
    locationId: fx.locations.THRIFT.location_id,
    initialAmountCents: 2500,
    cardType: 'PHYSICAL',
    idempotencyKey: rhTestKey_('qr-b')
  });
  rhTestAssert_(first.card.qr_token !== second.card.qr_token, 'QR tokens must be unique');
  rhTestAssert_(/^[0-9a-f]{64}$/.test(first.card.qr_token), 'QR token must be unpredictable hex');
  rhTestAssertEqual_(first.card.card_number === second.card.card_number, false);
  var audit = rhTestAuditText_();
  rhTestAssert_(audit.indexOf(first.card.qr_token) === -1, 'Audit log contains a QR token');
  rhTestAssert_(audit.indexOf('jordan@example.com') === -1, 'Audit log contains a customer email');
  var balance = checkGiftCardBalance({ idToken: fx.employeeToken, qrToken: first.card.qr_token });
  rhTestAssertEqual_(balance.qr_token, undefined);
  rhTestAssertEqual_(balance.customer_email, undefined);
  rhTestAssertEqual_(balance.current_balance, 0);
  var employeeView = getGiftCardById({
    idToken: fx.employeeToken,
    cardId: first.card.card_id,
    includeQrToken: true
  });
  rhTestAssertEqual_(employeeView.customer_email, undefined);
  rhTestAssertEqual_(employeeView.qr_token, first.card.qr_token);
  var adminView = getGiftCardById({ idToken: fx.adminToken, cardId: first.card.card_id });
  rhTestAssertEqual_(adminView.customer_email, 'jordan@example.com');
  rhTestAssertEqual_(adminView.qr_token, undefined);
  var scanned = getGiftCardByQRToken({ idToken: fx.cafeToken, qrToken: first.card.qr_token });
  rhTestAssertEqual_(scanned.card_id, first.card.card_id);
  rhTestAssertEqual_(scanned.qr_token, undefined);
  rhTestAssertEqual_(scanned.customer_email, undefined);
}

function testFractionalCentsAndNegativeBalancesAreRejected() {
  var fx = rhTestBoot_();
  rhTestAssertThrows_(function () {
    createGiftCard({
      idToken: fx.employeeToken,
      locationId: fx.locations.THRIFT.location_id,
      initialAmountCents: 10.5,
      cardType: 'PHYSICAL',
      idempotencyKey: rhTestKey_('float')
    });
  }, 'VALIDATION');
  rhTestAssertThrows_(function () {
    createGiftCard({
      idToken: fx.employeeToken,
      locationId: fx.locations.THRIFT.location_id,
      initialAmountCents: '2500',
      cardType: 'PHYSICAL',
      idempotencyKey: rhTestKey_('string-money')
    });
  }, 'VALIDATION');
  var sold = rhTestSell_(fx, 1000);
  rhTestAssertThrows_(function () {
    redeemGiftCard({
      idToken: fx.employeeToken,
      cardId: sold.card.card_id,
      amountCents: -100,
      locationId: fx.locations.THRIFT.location_id,
      idempotencyKey: rhTestKey_('negative')
    });
  }, 'VALIDATION');
  rhTestAssertEqual_(checkGiftCardBalance({ idToken: fx.employeeToken, cardId: sold.card.card_id }).current_balance, 1000);
}

function testWebRequestRejectsUnverifiedCaller() {
  var denied = doPost({
    postData: {
      contents: JSON.stringify({
        action: 'createGiftCard',
        email: 'admin@restoringhope.test',
        employeeId: 'not-proof',
        initialAmountCents: 2500,
        cardType: 'PHYSICAL',
        idempotencyKey: 'web-must-not-create-card'
      })
    }
  });
  var deniedBody = JSON.parse(denied.getContent());
  rhTestAssertEqual_(deniedBody.ok, false);
  rhTestAssertEqual_(deniedBody.code, 'UNAUTHENTICATED');
  var hidden = doPost({ postData: { contents: JSON.stringify({ action: 'initializeDatabase' }) } });
  rhTestAssertEqual_(JSON.parse(hidden.getContent()).code, 'VALIDATION');
  var tests = doPost({ postData: { contents: JSON.stringify({ action: 'runAllTests' }) } });
  rhTestAssertEqual_(JSON.parse(tests.getContent()).code, 'VALIDATION');
  var status = JSON.parse(doGet().getContent());
  rhTestAssertEqual_(status.ok, true);
  rhTestAssertEqual_(status.service, 'restoring-hope-gift-cards');
}

function rhTestSetBalance_(cardId, balance) {
  var ctx = rhOpenContext_();
  var card = rhRequireCardById_(ctx, cardId);
  rhUpdateRecord_(ctx, RH_SHEET.GIFT_CARDS, card._row, card, {
    current_balance: balance,
    updated_at: rhNowIso_()
  });
}
