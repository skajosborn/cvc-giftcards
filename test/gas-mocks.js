/**
 * In-memory stand-in for the Apps Script services used by the gift card
 * backend. The suite never opens a real Google spreadsheet.
 */

var crypto = require('crypto');

function createGasMocks() {
  var spreadsheets = {};
  var productionId = 'prod-spreadsheet-should-never-be-used';
  var lockDepth = 0;
  var fetchQueue = [];
  var activeEmail = '';
  var scriptStore = {};

  function uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    var bytes = crypto.randomBytes(16);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    var hex = bytes.toString('hex');
    return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' +
      hex.slice(16, 20) + '-' + hex.slice(20);
  }

  function unsigned(bytes) {
    var out = [];
    for (var i = 0; i < bytes.length; i++) out.push(bytes[i] < 0 ? bytes[i] + 256 : bytes[i]);
    return out;
  }

  function MockRange(sheet, row, col, numRows, numCols) {
    this.sheet = sheet;
    this.row = row;
    this.col = col;
    this.numRows = numRows;
    this.numCols = numCols;
  }

  MockRange.prototype.getValues = function () {
    var values = [];
    for (var r = 0; r < this.numRows; r++) {
      var row = [];
      var stored = this.sheet.values[this.row - 1 + r] || [];
      for (var c = 0; c < this.numCols; c++) {
        var value = stored[this.col - 1 + c];
        if (value === undefined || value === null) value = '';
        if (typeof value === 'string' && value.charAt(0) === "'") value = value.substring(1);
        row.push(value);
      }
      values.push(row);
    }
    return values;
  };

  MockRange.prototype.setValues = function (rows) {
    if (rows.length !== this.numRows) throw new Error('setValues row count mismatch');
    for (var r = 0; r < rows.length; r++) {
      if (rows[r].length !== this.numCols) throw new Error('setValues column count mismatch');
      var index = this.row - 1 + r;
      if (!this.sheet.values[index]) this.sheet.values[index] = [];
      for (var c = 0; c < rows[r].length; c++) {
        this.sheet.values[index][this.col - 1 + c] = rows[r][c];
      }
    }
    return this;
  };

  MockRange.prototype.setNumberFormat = function () { return this; };
  MockRange.prototype.setDataValidation = function () { return this; };
  MockRange.prototype.setFontWeight = function () { return this; };
  MockRange.prototype.setNote = function () { return this; };

  function MockSheet(name) {
    this.name = name;
    this.values = [];
    this.frozen = 0;
  }

  MockSheet.prototype.getName = function () { return this.name; };
  MockSheet.prototype.setName = function (name) { this.name = name; return this; };
  MockSheet.prototype.getMaxRows = function () { return 100; };
  MockSheet.prototype.setFrozenRows = function (count) { this.frozen = count; return this; };
  MockSheet.prototype.clear = function () { this.values = []; return this; };
  MockSheet.prototype.getLastRow = function () {
    var last = 0;
    for (var i = 0; i < this.values.length; i++) {
      var row = this.values[i] || [];
      for (var c = 0; c < row.length; c++) {
        if (row[c] !== '' && row[c] !== null && row[c] !== undefined) {
          last = i + 1;
          break;
        }
      }
    }
    return last;
  };
  MockSheet.prototype.getLastColumn = function () {
    var max = 0;
    for (var i = 0; i < this.values.length; i++) {
      if (this.values[i] && this.values[i].length > max) max = this.values[i].length;
    }
    return max;
  };
  MockSheet.prototype.getRange = function (row, col, numRows, numCols) {
    return new MockRange(this, row, col, numRows === undefined ? 1 : numRows, numCols === undefined ? 1 : numCols);
  };
  MockSheet.prototype.getDataRange = function () {
    return this.getRange(1, 1, Math.max(1, this.getLastRow()), Math.max(1, this.getLastColumn()));
  };
  MockSheet.prototype.protect = function () {
    return {
      setDescription: function () { return this; },
      setWarningOnly: function () { return this; },
      addEditor: function () { return this; },
      removeEditors: function () { return this; },
      getEditors: function () { return []; },
      canDomainEdit: function () { return false; },
      setDomainEdit: function () { return this; }
    };
  };

  function MockSpreadsheet(id) {
    this.id = id;
    this.sheets = [new MockSheet('Sheet1')];
  }

  MockSpreadsheet.prototype.getId = function () { return this.id; };
  MockSpreadsheet.prototype.getSheetByName = function (name) {
    for (var i = 0; i < this.sheets.length; i++) {
      if (this.sheets[i].name === name) return this.sheets[i];
    }
    return null;
  };
  MockSpreadsheet.prototype.insertSheet = function (name) {
    if (this.getSheetByName(name)) throw new Error('Sheet already exists: ' + name);
    var sheet = new MockSheet(name);
    this.sheets.push(sheet);
    return sheet;
  };
  MockSpreadsheet.prototype.getSheets = function () { return this.sheets.slice(); };
  MockSpreadsheet.prototype.deleteSheet = function (sheet) {
    if (this.sheets.length <= 1) throw new Error('Cannot delete the last sheet');
    this.sheets = this.sheets.filter(function (item) { return item !== sheet; });
  };

  function validationBuilder() {
    var builder = {
      requireValueInList: function () { return builder; },
      setAllowInvalid: function () { return builder; },
      build: function () { return {}; }
    };
    return builder;
  }

  var SpreadsheetApp = {
    __productionId: productionId,
    openById: function (id) {
      if (id === productionId) {
        throw new Error('Refusing to open the production spreadsheet from the test suite');
      }
      if (!spreadsheets[id]) spreadsheets[id] = new MockSpreadsheet(id);
      return spreadsheets[id];
    },
    getActive: function () { return null; },
    flush: function () {},
    newDataValidation: function () { return validationBuilder(); }
  };

  var LockService = {
    __deny: false,
    __stats: { acquisitions: 0, releases: 0, denials: 0 },
    __reset: function () {
      lockDepth = 0;
      LockService.__deny = false;
      LockService.__stats = { acquisitions: 0, releases: 0, denials: 0 };
    },
    getScriptLock: function () {
      return {
        tryLock: function () {
          if (LockService.__deny) {
            LockService.__stats.denials++;
            return false;
          }
          if (lockDepth > 0) throw new Error('Nested LockService lock');
          lockDepth = 1;
          LockService.__stats.acquisitions++;
          return true;
        },
        releaseLock: function () {
          lockDepth = 0;
          LockService.__stats.releases++;
        }
      };
    },
    getDocumentLock: function () { return null; }
  };

  var PropertiesService = {
    getScriptProperties: function () {
      return {
        getProperty: function (key) {
          return Object.prototype.hasOwnProperty.call(scriptStore, key) ? scriptStore[key] : null;
        },
        setProperty: function (key, value) { scriptStore[key] = String(value); },
        deleteProperty: function (key) { delete scriptStore[key]; },
        getProperties: function () {
          var copy = {};
          Object.keys(scriptStore).forEach(function (key) { copy[key] = scriptStore[key]; });
          return copy;
        }
      };
    }
  };

  var Utilities = {
    Charset: { UTF_8: 'UTF_8' },
    DigestAlgorithm: { SHA_256: 'SHA_256' },
    getUuid: uuid,
    computeDigest: function (algorithm, value) {
      return Array.from(crypto.createHash('sha256').update(String(value), 'utf8').digest());
    },
    computeHmacSha256Signature: function (value, key) {
      return Array.from(crypto.createHmac('sha256', String(key)).update(String(value), 'utf8').digest());
    },
    base64EncodeWebSafe: function (data) {
      var buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(unsigned(data));
      return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    },
    base64DecodeWebSafe: function (value) {
      var b64 = String(value).replace(/-/g, '+').replace(/_/g, '/');
      while (b64.length % 4) b64 += '=';
      return Array.from(Buffer.from(b64, 'base64'));
    },
    newBlob: function (data) {
      var buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(unsigned(data));
      return { getDataAsString: function () { return buf.toString('utf8'); } };
    },
    formatDate: function (date, timeZone, pattern) {
      if (pattern !== 'yyyy-MM-dd') throw new Error('Unsupported date pattern ' + pattern);
      var parts = new Intl.DateTimeFormat('en-US', {
        timeZone: timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
      }).formatToParts(date);
      var map = {};
      for (var i = 0; i < parts.length; i++) map[parts[i].type] = parts[i].value;
      return map.year + '-' + map.month + '-' + map.day;
    }
  };

  var Session = {
    getActiveUser: function () { return { getEmail: function () { return activeEmail; } }; },
    getEffectiveUser: function () { return { getEmail: function () { return 'owner@restoringhope.test'; } }; },
    getScriptTimeZone: function () { return 'America/Chicago'; },
    __setActiveUser: function (email) { activeEmail = email; }
  };

  var UrlFetchApp = {
    __queue: function (item) { fetchQueue.push(item); },
    __reset: function () { fetchQueue = []; },
    fetch: function (url) {
      if (!fetchQueue.length) throw new Error('Unexpected UrlFetchApp.fetch ' + url);
      var next = fetchQueue.shift();
      return {
        getResponseCode: function () { return next.code; },
        getContentText: function () { return JSON.stringify(next.body); }
      };
    }
  };

  var ContentService = {
    MimeType: { JSON: 'JSON' },
    createTextOutput: function (text) {
      return {
        _text: text,
        setMimeType: function () { return this; },
        getContent: function () { return text; }
      };
    }
  };

  var Logger = { log: function () {} };
  var ScriptApp = { getScriptId: function () { return 'test-script'; } };

  return {
    SpreadsheetApp: SpreadsheetApp,
    LockService: LockService,
    PropertiesService: PropertiesService,
    Utilities: Utilities,
    Session: Session,
    UrlFetchApp: UrlFetchApp,
    ContentService: ContentService,
    Logger: Logger,
    ScriptApp: ScriptApp,
    console: console
  };
}

module.exports = { createGasMocks: createGasMocks };
