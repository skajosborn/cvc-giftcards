/**
 * JSON adapter for a future React client. The web app runs as the deployer
 * so cashiers do not receive access to the spreadsheet. Identity is the
 * Google ID token in the body, never an email or employee id.
 */

function doGet() {
  rhEnterWebRequest_();
  return rhJsonResponse_({
    ok: true,
    service: 'restoring-hope-gift-cards',
    money_unit: RH_MONEY_UNIT
  });
}

function doPost(e) {
  rhEnterWebRequest_();
  try {
    if (!e || !e.postData || typeof e.postData.contents !== 'string') {
      return rhJsonResponse_({ ok: false, code: 'VALIDATION', message: 'Expected a JSON body' });
    }
    if (e.postData.contents.length > 100000) {
      return rhJsonResponse_({ ok: false, code: 'VALIDATION', message: 'Request is too large' });
    }
    var body = JSON.parse(e.postData.contents);
    if (!body || typeof body !== 'object' || Object.prototype.toString.call(body) === '[object Array]') {
      return rhJsonResponse_({ ok: false, code: 'VALIDATION', message: 'Expected a JSON object' });
    }
    if (typeof body.action !== 'string') {
      return rhJsonResponse_({ ok: false, code: 'VALIDATION', message: 'Expected an action' });
    }
    var handler = rhWebHandlers_()[body.action];
    if (!handler) return rhJsonResponse_({ ok: false, code: 'VALIDATION', message: 'Unknown action' });
    return rhJsonResponse_({ ok: true, result: handler(body) });
  } catch (err) {
    return rhJsonResponse_({
      ok: false,
      code: err && err.code ? err.code : 'INTERNAL',
      message: rhPublicErrorMessage_(err)
    });
  }
}

function rhWebHandlers_() {
  return {
    getSession: getSession,
    createLocation: createLocation,
    listLocations: listLocations,
    createEmployee: createEmployee,
    updateEmployeeAccess: updateEmployeeAccess,
    createGiftCard: createGiftCard,
    createBlankGiftCards: createBlankGiftCards,
    activateGiftCard: activateGiftCard,
    cancelGiftCard: cancelGiftCard,
    getGiftCardById: getGiftCardById,
    getGiftCardByQRToken: getGiftCardByQRToken,
    checkGiftCardBalance: checkGiftCardBalance,
    redeemGiftCard: redeemGiftCard,
    reloadGiftCard: reloadGiftCard,
    refundGiftCardTransaction: refundGiftCardTransaction,
    voidGiftCardTransaction: voidGiftCardTransaction,
    adjustGiftCardBalance: adjustGiftCardBalance,
    suspendGiftCard: suspendGiftCard,
    reinstateGiftCard: reinstateGiftCard,
    getTransactionHistory: getTransactionHistory,
    getLocationTransactions: getLocationTransactions,
    getOutstandingGiftCardBalance: getOutstandingGiftCardBalance,
    getGiftCardSalesReport: getGiftCardSalesReport,
    getGiftCardRedemptionReport: getGiftCardRedemptionReport,
    detectBalanceMismatches: detectBalanceMismatches,
    repairUnambiguousPendingTransactions: repairUnambiguousPendingTransactions,
    restoreCardBalanceFromLedger: restoreCardBalanceFromLedger
  };
}

function rhJsonResponse_(payload) {
  var output = ContentService.createTextOutput(JSON.stringify(payload));
  output.setMimeType(ContentService.MimeType.JSON);
  return output;
}

function rhPublicErrorMessage_(err) {
  if (!err || !err.code || err.code === 'INTERNAL') return 'The operation could not be completed';
  var message = String(err.message || '');
  if (!message || message.length > 300) return 'The operation could not be completed';
  if (message.indexOf('test.') !== -1 || message.indexOf('eyJ') !== -1) {
    return 'The operation could not be completed';
  }
  return message;
}
