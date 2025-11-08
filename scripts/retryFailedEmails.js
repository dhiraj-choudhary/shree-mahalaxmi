// Retry failed inquiry emails saved to the OS temp directory
const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const nodemailer = require('nodemailer');

const failedFile = path.join(os.tmpdir(), 'failed-inquiry-emails.json');

function createTransporter() {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_PORT) return null;
  const auth = SMTP_USER && SMTP_PASS ? { user: SMTP_USER, pass: SMTP_PASS } : undefined;
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: parseInt(SMTP_PORT, 10),
    secure: String(SMTP_PORT) === '465',
    auth,
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 10000
  });
}

async function loadFailed() {
  try {
    const raw = await fs.readFile(failedFile, 'utf8');
    return JSON.parse(raw) || [];
  } catch (e) {
    if (e && e.code === 'ENOENT') return [];
    throw e;
  }
}

async function saveFailed(arr) {
  await fs.writeFile(failedFile, JSON.stringify(arr, null, 2), 'utf8');
}

async function retryAll() {
  const entries = await loadFailed();
  if (!entries || entries.length === 0) {
    console.log('No failed inquiry emails to retry.');
    return;
  }
  console.log('Retrying', entries.length, 'failed emails from', failedFile);

  const transporter = createTransporter();
  if (!transporter) {
    console.error('No SMTP configuration found in environment. Set SMTP_HOST/SMTP_PORT etc.');
    return;
  }

  const remaining = [];
  for (const rec of entries) {
    const { inquiry, subject, body } = rec;
    let sent = false;
    // try up to 3 attempts per record
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await transporter.sendMail({ from: process.env.FROM_EMAIL || process.env.SMTP_USER || 'no-reply@example.com', to: process.env.TO_EMAIL || 'abc@gmail.com', subject, text: body });
        console.log(`Sent failed inquiry id=${inquiry && inquiry.id} on attempt ${attempt}`);
        sent = true;
        break;
      } catch (err) {
        console.error(`Retry failed for id=${inquiry && inquiry.id} attempt=${attempt}:`, err && err.message ? err.message : err);
        const backoff = 500 * Math.pow(2, attempt - 1);
        await new Promise(r => setTimeout(r, backoff));
      }
    }
    if (!sent) remaining.push(rec);
  }

  if (remaining.length === 0) {
    console.log('All failed emails retried successfully — removing file.');
    try { await fs.unlink(failedFile); } catch (e) { console.warn('Failed to delete failed file', e && e.message ? e.message : e); }
  } else {
    console.log('Some emails still failed; saving remaining', remaining.length);
    await saveFailed(remaining);
  }
}

if (require.main === module) {
  retryAll().catch(err => { console.error('Retry script failed', err); process.exit(1); });
}

