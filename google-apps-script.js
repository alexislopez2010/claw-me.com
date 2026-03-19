// ─────────────────────────────────────────────────────────────
//  claw-me.com — Waitlist Google Apps Script
//
//  SETUP INSTRUCTIONS:
//  1. Go to https://sheets.google.com and create a new spreadsheet
//  2. Name it "claw-me.com Waitlist"
//  3. In row 1, add headers: "Timestamp" in A1, "Email" in B1
//  4. Go to Extensions → Apps Script
//  5. Delete any existing code, paste this entire file in
//  6. Click Save (floppy disk icon)
//  7. Click Deploy → New deployment
//  8. Click the gear icon next to "Type" → select "Web app"
//  9. Set "Execute as" → Me
//     Set "Who has access" → Anyone
//  10. Click Deploy → Authorize → Allow
//  11. Copy the Web App URL shown
//  12. Paste that URL into index.html where it says YOUR_APPS_SCRIPT_URL_HERE
// ─────────────────────────────────────────────────────────────

const SHEET_NAME = 'Sheet1'; // Change if your sheet tab has a different name

function doPost(e) {
  try {
    // Reads URL-encoded form params (compatible with no-cors fetch)
    const email     = (e.parameter.email     || '').trim();
    const timestamp =  e.parameter.timestamp || new Date().toISOString();

    // Basic email validation server-side
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return jsonResponse({ success: false, error: 'Invalid email' });
    }

    const sheet = SpreadsheetApp
      .getActiveSpreadsheet()
      .getSheetByName(SHEET_NAME);

    // Add headers if this is the very first entry
    if (sheet.getLastRow() === 0) {
      sheet.appendRow(['Timestamp', 'Email']);
    }

    // Check for duplicate emails
    const existingEmails = sheet.getRange(2, 2, Math.max(sheet.getLastRow() - 1, 1), 1)
      .getValues()
      .flat();
    if (existingEmails.includes(email)) {
      return jsonResponse({ success: true, message: 'Already registered' });
    }

    // Append the new signup
    sheet.appendRow([timestamp, email]);

    // Optional: send yourself a notification email
    // MailApp.sendEmail('your@email.com', 'New claw-me.com signup!', email);

    return jsonResponse({ success: true });

  } catch (err) {
    return jsonResponse({ success: false, error: err.message });
  }
}

// Handle GET requests (useful for testing the endpoint is live)
function doGet(e) {
  return jsonResponse({ status: 'claw-me.com waitlist endpoint is live 🦞' });
}

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
