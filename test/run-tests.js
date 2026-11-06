/**
 * Loads the Apps Script sources into an in-memory Google services mock
 * and runs Tests.gs. This does not contact Google and cannot modify a
 * production spreadsheet.
 */

var fs = require('fs');
var path = require('path');
var vm = require('vm');
var createGasMocks = require('./gas-mocks').createGasMocks;

var files = [
  'Config.gs',
  'Validation.gs',
  'Database.gs',
  'Audit.gs',
  'Auth.gs',
  'Locations.gs',
  'Employees.gs',
  'GiftCards.gs',
  'Transactions.gs',
  'Reports.gs',
  'WebApp.gs',
  'Tests.gs'
];

var sandbox = createGasMocks();
sandbox.encodeURIComponent = encodeURIComponent;
sandbox.decodeURIComponent = decodeURIComponent;
sandbox.parseInt = parseInt;
sandbox.isFinite = isFinite;
sandbox.isNaN = isNaN;
sandbox.Date = Date;
sandbox.JSON = JSON;
sandbox.Math = Math;
sandbox.Object = Object;
sandbox.Array = Array;
sandbox.Error = Error;
sandbox.RegExp = RegExp;
sandbox.Number = Number;
sandbox.String = String;
sandbox.Boolean = Boolean;

vm.createContext(sandbox);
files.forEach(function (file) {
  var code = fs.readFileSync(path.join(__dirname, '..', 'src', file), 'utf8');
  vm.runInContext(code, sandbox, { filename: file });
});

var props = sandbox.PropertiesService.getScriptProperties();
props.setProperty('ALLOW_TEST_TOKENS', 'true');
props.setProperty('GOOGLE_CLIENT_ID', 'test-client-id');
props.setProperty('TEST_SPREADSHEET_ID', 'test-spreadsheet-id');
props.setProperty('SPREADSHEET_ID', sandbox.SpreadsheetApp.__productionId);

var outcome = sandbox.runAllTests();
var failed = outcome.results.filter(function (result) { return !result.passed; });
failed.forEach(function (result) {
  console.error('\nFAIL ' + result.name);
  console.error(result.message);
  if (result.stack) console.error(result.stack);
});
console.log(outcome.passed + ' passed, ' + outcome.failed + ' failed');
if (outcome.failed > 0) process.exit(1);
