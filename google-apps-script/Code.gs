// ==========================================
// GOOGLE APPS SCRIPT (Backend Code)
// ==========================================
//
// This is the script behind GOOGLE_SHEET_API in index.html. It is kept in the
// repo for version history only — Apps Script does not deploy from here. To
// apply a change: open the Sheet -> Extensions -> Apps Script, paste this file
// over the existing script, then Deploy -> Manage deployments -> Edit (pencil)
// -> Version: New version -> Deploy. That keeps the same web app URL.
//
// The "Purchase Requests" sheet is created automatically the first time
// createPurchaseRequest runs — no manual spreadsheet setup needed.
//
// PERMISSION NOTE: saving photos uses DriveApp. After deploying, run any
// function once from the Apps Script editor (Run -> getOrCreatePhotoFolder) so
// Google prompts for Drive access; otherwise the first photo upload fails
// silently (the request still saves, just without a photo).
//
// ------------------------------------------------------------------------
// WORKING WITH THE SHEET'S FORMULAS
// ------------------------------------------------------------------------
// Two columns in "Inventory Master" are formulas, pre-filled down ~1000 rows:
//
//   Current Stock  =IF(A2="", "", IFERROR(N2, 0)
//                     + SUMIFS('Transaction Log'!E:E, 'Transaction Log'!C:C, A2, 'Transaction Log'!D:D, "In")
//                     - SUMIFS('Transaction Log'!E:E, 'Transaction Log'!C:C, A2, 'Transaction Log'!D:D, "Out"))
//   QR Code        =IMAGE("https://quickchart.io/qr?text=" & ENCODEURL(A2))
//
// Two consequences this script has to respect:
//
//  1. A formula counts as content even when it evaluates to "". So
//     getLastRow()/appendRow() see ~1000 used rows and a new part lands at row
//     1001, far below the real data. New rows are therefore written to the
//     first row with no Part Number instead of appended.
//
//  2. Writing a value into either column destroys that row's formula. Current
//     Stock already derives itself from Initial Stock plus the Transaction Log,
//     so stock movements only need a Transaction Log row — the number updates
//     itself. Anywhere this script would previously setValue() on Current
//     Stock, it now only does so if the cell has no formula (for sheets or rows
//     where the formula was never filled in).

function generateAllIds() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Inventory Master");
  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();

  if (lastRow < 2) return;

  var dataRange = sheet.getRange(2, 1, lastRow - 1, lastCol);
  var dataValues = dataRange.getValues();

  var idRange = sheet.getRange(2, 1, lastRow - 1, 1);
  var idValues = idRange.getValues();

  var counterNum = 1;

  for (var i = 0; i < dataValues.length; i++) {
    var rowHasData = false;

    for (var col = 1; col < lastCol; col++) {
      if (dataValues[i][col] !== "") {
        rowHasData = true;
        break;
      }
    }

    if (rowHasData) {
      if (!idValues[i][0] || idValues[i][0] === "") {
        idValues[i][0] = "PART-" + ("0000" + counterNum).slice(-4);
      }
      counterNum++;
    } else {
      idValues[i][0] = "";
    }
  }

  idRange.setValues(idValues);
  SpreadsheetApp.getUi().alert('Success! IDs generated safely for active component rows.');
}

// Returns an existing sheet, or creates it with the given header row if it doesn't exist yet.
function getOrCreateSheet(ss, name, headers) {
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(headers);
  }
  return sheet;
}

var PURCHASE_REQUEST_HEADERS = [
  "Request ID", "Timestamp", "Requested By", "Job ID", "Part ID", "Part Name",
  "New Part", "Qty Requested", "Notes", "Status", "Purchaser", "Platform",
  "Tracking Number", "Tracking Link", "Purchase Link", "Photo URL", "Last Updated"
];

// Columns in "Inventory Master" that hold formulas and must never be written to.
var FORMULA_COLUMNS = ["Current Stock", "QR Code"];

// The first row with no Part Number — i.e. the first genuinely unused row, ignoring
// the formulas filled down below the real data. Falls back to column E to match how
// doGet decides whether a row counts as a real component.
function firstFreeInventoryRow(sheet, headers) {
  var partNoCol = headers.indexOf("Part Number");
  if (partNoCol === -1) partNoCol = 4;

  var maxRows = sheet.getMaxRows();
  if (maxRows < 2) return 2;

  var values = sheet.getRange(2, partNoCol + 1, maxRows - 1, 1).getValues();
  for (var i = 0; i < values.length; i++) {
    if (String(values[i][0]).trim() === "") return i + 2;
  }
  return maxRows + 1;
}

// Carries the Current Stock / QR Code formulas down into a row that doesn't have them
// yet, for when a new part lands past the pre-filled block.
function ensureRowFormulas(sheet, headers, rowNum) {
  if (rowNum <= 2) return;
  for (var f = 0; f < FORMULA_COLUMNS.length; f++) {
    var idx = headers.indexOf(FORMULA_COLUMNS[f]);
    if (idx === -1) continue;
    var cell = sheet.getRange(rowNum, idx + 1);
    if (cell.getFormula()) continue;
    var above = sheet.getRange(rowNum - 1, idx + 1);
    if (above.getFormula()) above.copyTo(cell);
  }
}

// A raw base64 photo won't fit a Sheets cell (50,000-char limit) for anything but a tiny
// image, so it's saved to Drive instead and only the resulting view link goes in the sheet.
// First call creates a "TCS Part Request Photos" folder in the script owner's Drive; this
// requires Drive access, which will prompt for an extra permission on first authorization.
function getOrCreatePhotoFolder() {
  var folders = DriveApp.getFoldersByName("TCS Part Request Photos");
  if (folders.hasNext()) return folders.next();
  return DriveApp.createFolder("TCS Part Request Photos");
}

function savePhotoToDrive(dataUrl, filenameHint) {
  if (!dataUrl || dataUrl.indexOf("base64,") === -1) return "";
  var mimeType = dataUrl.substring(5, dataUrl.indexOf(";"));
  var base64 = dataUrl.substring(dataUrl.indexOf("base64,") + 7);
  var ext = (mimeType.split("/")[1] || "jpg").split("+")[0];
  var bytes = Utilities.base64Decode(base64);
  var blob = Utilities.newBlob(bytes, mimeType, (filenameHint || "photo") + "." + ext);
  var file = getOrCreatePhotoFolder().createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return "https://drive.google.com/uc?export=view&id=" + file.getId();
}

function doGet(e) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  var masterSheet = ss.getSheetByName("Inventory Master");
  var masterRows = masterSheet.getDataRange().getValues();
  var masterHeaders = masterRows[0].map(function(h) { return String(h).trim(); });
  var inventoryData = [];

  for (var i = 1; i < masterRows.length; i++) {
    var partNumber = String(masterRows[i][4] || "").trim();
    if (partNumber !== "") {
      var obj = {};
      for (var j = 0; j < masterHeaders.length; j++) {
        obj[masterHeaders[j]] = masterRows[i][j];
      }
      inventoryData.push(obj);
    }
  }

  var logSheet = ss.getSheetByName("Transaction Log");
  var logData = [];
  if (logSheet && logSheet.getLastRow() > 1) {
    var logRows = logSheet.getDataRange().getValues();
    var logHeaders = logRows[0].map(function(h) { return String(h).trim(); });
    for (var k = 1; k < logRows.length; k++) {
      var logObj = {};
      for (var l = 0; l < logHeaders.length; l++) {
        logObj[logHeaders[l]] = logRows[k][l];
      }
      logData.push(logObj);
    }
  }

  var prSheet = ss.getSheetByName("Purchase Requests");
  var purchaseRequestsData = [];
  if (prSheet && prSheet.getLastRow() > 1) {
    var prRows = prSheet.getDataRange().getValues();
    var prHeaders = prRows[0].map(function(h) { return String(h).trim(); });
    for (var p = 1; p < prRows.length; p++) {
      var prObj = {};
      for (var q = 0; q < prHeaders.length; q++) {
        prObj[prHeaders[q]] = prRows[p][q];
      }
      purchaseRequestsData.push(prObj);
    }
  }

  var payload = {
    inventory: inventoryData,
    transactions: logData,
    purchaseRequests: purchaseRequestsData
  };

  return ContentService.createTextOutput(JSON.stringify(payload))
              .setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.tryLock(10000);
  try {
    var data = JSON.parse(e.postData.contents);
    var ss = SpreadsheetApp.getActiveSpreadsheet();

    if (data.action === "deductStock") {
      var logSheet = ss.getSheetByName("Transaction Log");
      var masterSheet = ss.getSheetByName("Inventory Master");
      var rows = masterSheet.getDataRange().getValues();
      var headers = rows[0].map(function(h) { return String(h).trim(); });

      var stockColIndex = -1;
      for (var h = 0; h < headers.length; h++) {
        if (headers[h].toLowerCase() === "current stock") {
          stockColIndex = h;
          break;
        }
      }

      var parts = data.parts;
      var engineer = data.engineerName || "Muhammad Haziq Fikri";
      var jobId = data.jobId || "Web-Service";
      var purpose = data.purpose || "Repair BOM Allocation";

      for (var p = 0; p < parts.length; p++) {
        var targetId = String(parts[p].partId).trim();
        var deductQty = Number(parts[p].qty) || 0;

        if (targetId && deductQty > 0) {
          var matchedRowIndex = -1;

          for (var i = 1; i < rows.length; i++) {
            var colA_Id = String(rows[i][0] || "").trim();
            var colE_Part = String(rows[i][4] || "").trim();

            if (colA_Id === targetId || colE_Part === targetId) {
              matchedRowIndex = i + 1;
              break;
            }
          }

          if (matchedRowIndex !== -1 && stockColIndex !== -1) {
            var currentStockCell = masterSheet.getRange(matchedRowIndex, stockColIndex + 1);

            // With the Current Stock formula in place the Transaction Log row below is
            // the whole update — writing a number here would both overwrite the formula
            // and double-count against the "Out" row being logged.
            if (!currentStockCell.getFormula()) {
              var existingStock = Number(currentStockCell.getValue()) || 0;
              var updatedStock = Math.max(0, existingStock - deductQty);
              currentStockCell.setValue(updatedStock);
              rows[matchedRowIndex - 1][stockColIndex] = updatedStock;
            }

            var timestamp = new Date();
            var transId = "TXN-" + Math.floor(100000 + Math.random() * 900000);

            logSheet.appendRow([
              timestamp,
              transId,
              targetId,
              "Out",
              Number(deductQty),
              engineer,
              jobId,
              purpose
            ]);
          }
        }
      }

      return ContentService.createTextOutput(JSON.stringify({status: "success"}))
                  .setMimeType(ContentService.MimeType.JSON);
    }

    if (data.action === "createPart") {
      var masterSheet = ss.getSheetByName("Inventory Master");
      var mHeaders = masterSheet.getDataRange().getValues()[0].map(function(h) { return String(h).trim(); });

      var fieldMap = {
        "Component ID": data.id || "",
        "Type": data.type || "",
        "Brand": data.brand || "",
        "Part Number": data.partNumber || "",
        "Package Type": data.packageType || "",
        "Size": data.size || "",
        "Description": data.description || "",
        "Location": data.location || "",
        "Initial Stock": Number(data.initialStock) || 0
      };

      // Write into the first unused row rather than appending past the formula block,
      // and set only the data columns so this row's Current Stock / QR Code formulas
      // survive (see the note at the top of this file).
      var targetRow = firstFreeInventoryRow(masterSheet, mHeaders);
      for (var c = 0; c < mHeaders.length; c++) {
        var header = mHeaders[c];
        if (FORMULA_COLUMNS.indexOf(header) !== -1) continue;
        if (!fieldMap.hasOwnProperty(header)) continue;
        masterSheet.getRange(targetRow, c + 1).setValue(fieldMap[header]);
      }
      ensureRowFormulas(masterSheet, mHeaders, targetRow);

      return ContentService.createTextOutput(JSON.stringify({status: "success", id: data.id, row: targetRow}))
                  .setMimeType(ContentService.MimeType.JSON);
    }

    if (data.action === "createPurchaseRequest") {
      var prSheet = getOrCreateSheet(ss, "Purchase Requests", PURCHASE_REQUEST_HEADERS);
      var ts = new Date();
      var items = data.items || [];

      for (var it = 0; it < items.length; it++) {
        var photoUrl = savePhotoToDrive(items[it].photo, data.requestId + "-" + (it + 1));
        prSheet.appendRow([
          data.requestId,
          ts,
          data.requestedBy || "",
          data.jobId || "",
          items[it].partId,
          items[it].partName || items[it].partId,
          items[it].isNewPart ? "Yes" : "No",
          Number(items[it].qty) || 0,
          data.notes || "",
          "Requested",
          "", "", "", "",
          items[it].purchaseLink || "",
          photoUrl,
          ts
        ]);
      }

      return ContentService.createTextOutput(JSON.stringify({status: "success", requestId: data.requestId}))
                  .setMimeType(ContentService.MimeType.JSON);
    }

    if (data.action === "updatePurchaseRequestStatus") {
      var prSheet = ss.getSheetByName("Purchase Requests");
      if (!prSheet) {
        return ContentService.createTextOutput(JSON.stringify({status: "error", message: "Purchase Requests sheet not found"}))
                    .setMimeType(ContentService.MimeType.JSON);
      }
      var prRows = prSheet.getDataRange().getValues();
      var prHeaders = prRows[0].map(function(h) { return String(h).trim(); });
      var col = {};
      prHeaders.forEach(function(h, i) { col[h] = i; });

      var masterSheet = ss.getSheetByName("Inventory Master");
      var mRows = masterSheet.getDataRange().getValues();
      var mHeaders = mRows[0].map(function(h) { return String(h).trim(); });
      var mStockCol = -1;
      for (var mh = 0; mh < mHeaders.length; mh++) {
        if (mHeaders[mh].toLowerCase() === "current stock") mStockCol = mh;
      }

      var logSheet = ss.getSheetByName("Transaction Log");
      var ts = new Date();

      for (var r = 1; r < prRows.length; r++) {
        if (String(prRows[r][col["Request ID"]]).trim() !== String(data.requestId).trim()) continue;

        var rowNum = r + 1;
        var wasDelivered = String(prRows[r][col["Status"]]).trim() === "Delivered";

        if (data.status) prSheet.getRange(rowNum, col["Status"] + 1).setValue(data.status);
        if (data.purchaser !== undefined) prSheet.getRange(rowNum, col["Purchaser"] + 1).setValue(data.purchaser);
        if (data.platform !== undefined) prSheet.getRange(rowNum, col["Platform"] + 1).setValue(data.platform);
        if (data.trackingNumber !== undefined) prSheet.getRange(rowNum, col["Tracking Number"] + 1).setValue(data.trackingNumber);
        if (data.trackingLink !== undefined) prSheet.getRange(rowNum, col["Tracking Link"] + 1).setValue(data.trackingLink);
        prSheet.getRange(rowNum, col["Last Updated"] + 1).setValue(ts);

        if (data.status === "Delivered" && !wasDelivered && mStockCol !== -1) {
          var partId = String(prRows[r][col["Part ID"]]).trim();
          var qty = Number(prRows[r][col["Qty Requested"]]) || 0;

          for (var m = 1; m < mRows.length; m++) {
            if (String(mRows[m][0]).trim() === partId) {
              var stockCell = masterSheet.getRange(m + 1, mStockCol + 1);

              // Same reasoning as deductStock: the "In" row logged below is what moves
              // the number when Current Stock is a formula.
              if (!stockCell.getFormula()) {
                var newQty = (Number(stockCell.getValue()) || 0) + qty;
                stockCell.setValue(newQty);
                mRows[m][mStockCol] = newQty;
              }

              logSheet.appendRow([
                ts,
                "TXN-" + Math.floor(100000 + Math.random() * 900000),
                partId,
                "In",
                qty,
                data.purchaser || "",
                prRows[r][col["Job ID"]] || "",
                "Purchase Delivery (" + data.requestId + ")"
              ]);
              break;
            }
          }
        }
      }

      return ContentService.createTextOutput(JSON.stringify({status: "success"}))
                  .setMimeType(ContentService.MimeType.JSON);
    }

    return ContentService.createTextOutput(JSON.stringify({status: "error", message: "Unknown action"}))
                .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({status: "error", message: err.toString()}))
                .setMimeType(ContentService.MimeType.JSON);
  } finally {
    lock.releaseLock();
  }
}
