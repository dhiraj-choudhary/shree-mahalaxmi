const express = require('express');
const path = require('path');
const fs = require('fs').promises;
const nodemailer = require('nodemailer');
const XLSX = require('xlsx');
const multer = require('multer');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 3000;

const DATA_DIR = path.join(__dirname, 'data');
const PRODUCTS_FILE = path.join(DATA_DIR, 'products.json');
const PRODUCTS_XLSX = path.join(DATA_DIR, 'products.xlsx');
const INQUIRIES_FILE = path.join(DATA_DIR, 'inquiries.json');

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// Add missing JSON helpers used by routes
async function readJson(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
}

async function writeJson(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
}

// multer setup (store uploads in memory then write atomically)
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// Admin endpoint to upload products XLSX
app.post('/api/admin/upload-products', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'file is required' });
    const origName = req.file.originalname || '';
    if (!/\.xlsx?$/.test(origName.toLowerCase())) {
      return res.status(400).json({ error: 'only .xlsx/.xls files allowed' });
    }

    // validate workbook can be parsed
    let workbook;
    try {
      workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    } catch (e) {
      return res.status(400).json({ error: 'invalid xlsx file' });
    }

    // write buffer to PRODUCTS_XLSX
    await fs.mkdir(path.dirname(PRODUCTS_XLSX), { recursive: true });
    await fs.writeFile(PRODUCTS_XLSX, req.file.buffer);

    // also update products.json for compatibility: read sheet -> json
    const sheetName = workbook.SheetNames[0];
    if (sheetName) {
      const sheet = workbook.Sheets[sheetName];
      const data = XLSX.utils.sheet_to_json(sheet, { defval: null });
      // parse tags if they look like JSON strings
      const parsed = data.map(row => {
        const item = { ...row };
        if (item.tags && typeof item.tags === 'string') {
          try { item.tags = JSON.parse(item.tags); } catch (e) { item.tags = String(item.tags).split(',').map(s=>s.trim()).filter(Boolean); }
        }
        if (item.id != null) item.id = Number(item.id);
        if (item.price != null && item.price !== '') item.price = Number(item.price);
        return item;
      });
      await writeJson(PRODUCTS_FILE, parsed);
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error('upload error', err);
    return res.status(500).json({ error: 'upload failed' });
  }
});

// Read products preferring XLSX. If XLSX missing but JSON exists, migrate JSON -> XLSX.
async function readProducts() {
  // try XLSX first
  try {
    await fs.access(PRODUCTS_XLSX);
    const workbook = XLSX.readFile(PRODUCTS_XLSX, { cellDates: true });
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) return [];
    const sheet = workbook.Sheets[sheetName];
    const data = XLSX.utils.sheet_to_json(sheet, { defval: null });
    // parse stringified fields (tags) and normalize types
    return data.map((row) => {
      const item = { ...row };
      if (item.tags && typeof item.tags === 'string') {
        try {
          item.tags = JSON.parse(item.tags);
        } catch (e) {
          // fallback: comma-separated
          item.tags = String(item.tags).split(',').map(s => s.trim()).filter(Boolean);
        }
      }
      if (item.id != null) item.id = Number(item.id);
      if (item.price != null && item.price !== '') item.price = Number(item.price);
      return item;
    });
  } catch (xlsxErr) {
    // XLSX not available, fallback to JSON and migrate if possible
    const products = await readJson(PRODUCTS_FILE);
    if (!products) return [];

    try {
      const wb = XLSX.utils.book_new();
      // stringify complex fields for XLSX storage
      const sheetData = products.map(p => ({ ...p, tags: p.tags ? JSON.stringify(p.tags) : '' }));
      const ws = XLSX.utils.json_to_sheet(sheetData);
      XLSX.utils.book_append_sheet(wb, ws, 'Products');
      await fs.mkdir(path.dirname(PRODUCTS_XLSX), { recursive: true });
      // write XLSX to a buffer then atomically write the file via fs
      const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' });
      await fs.writeFile(PRODUCTS_XLSX, buf);
      console.log('Migrated products.json -> products.xlsx');
    } catch (mErr) {
      console.error('Failed to migrate JSON -> XLSX', mErr);
    }

    return products;
  }
}

// setup nodemailer transporter if env vars present
function createTransporter() {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_PORT) return null;
  const auth = SMTP_USER && SMTP_PASS ? { user: SMTP_USER, pass: SMTP_PASS } : undefined;
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: parseInt(SMTP_PORT, 10),
    secure: String(SMTP_PORT) === '465',
    auth
  });
}

async function sendInquiryEmail(inquiry) {
  const failedFile = path.join(os.tmpdir(), 'failed-inquiry-emails.json');

  // helper: send via SendGrid HTTP API if API key is present (uses native https so no external deps)
  async function sendViaSendGrid(subject, body) {
    const key = process.env.SENDGRID_API_KEY;
    const to = process.env.TO_EMAIL || 'abc@gmail.com';
    const from = process.env.FROM_EMAIL || (process.env.SMTP_USER || 'no-reply@example.com');
    if (!key) throw new Error('No SendGrid API key');
    const payload = JSON.stringify({
      personalizations: [{ to: [{ email: to }] }],
      from: { email: from },
      subject,
      content: [{ type: 'text/plain', value: body }]
    });
    const https = require('https');
    const opts = {
      hostname: 'api.sendgrid.com',
      path: '/v3/mail/send',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      },
      timeout: 10000
    };
    return await new Promise((resolve, reject) => {
      const req = https.request(opts, (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const txt = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode >= 200 && res.statusCode < 300) return resolve(true);
          return reject(new Error(`SendGrid send failed: ${res.statusCode} ${res.statusMessage} ${txt}`));
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(new Error('SendGrid request timed out')); });
      req.write(payload);
      req.end();
    });
  }

  try {
    // If a SendGrid API key is configured, prefer it (fast HTTP) — especially important on serverless platforms like Vercel
    if (process.env.SENDGRID_API_KEY) {
      try {
        await sendViaSendGrid(`New inquiry (#${inquiry.id}) from ${inquiry.name}`, `Name: ${inquiry.name}\nPhone: ${inquiry.phone || ''}\nEmail: ${inquiry.email}\n\nMessage:\n${inquiry.message}\n\nReceived: ${inquiry.createdAt}`);
        console.log('Sent inquiry email via SendGrid (preferred path)');
        return;
      } catch (sgErr) {
        console.warn('SendGrid preferred send failed — will fall back to SMTP:', sgErr && sgErr.message ? sgErr.message : sgErr);
      }
    }

    const transporter = createTransporter();
    const to = process.env.TO_EMAIL || 'abc@gmail.com';
    const from = process.env.FROM_EMAIL || (process.env.SMTP_USER || 'no-reply@example.com');
    if (!transporter) {
      // SMTP not configured — try SendGrid fallback if available
      try {
        await sendViaSendGrid(`New inquiry (#${inquiry.id}) from ${inquiry.name}`, `Name: ${inquiry.name}\nPhone: ${inquiry.phone || ''}\nEmail: ${inquiry.email}\n\nMessage:\n${inquiry.message}`);
        console.log('Sent inquiry email via SendGrid fallback');
        return;
      } catch (sgErr) {
        console.warn('SendGrid fallback failed or not configured:', sgErr && sgErr.message ? sgErr.message : sgErr);
        console.log('SMTP not configured; skipping sending email. Inquiry:', inquiry);
        return;
      }
    }

    const subject = `New inquiry (#${inquiry.id}) from ${inquiry.name}`;
    let body = `Name: ${inquiry.name}\nPhone: ${inquiry.phone || ''}\nEmail: ${inquiry.email}\nProduct ID: ${inquiry.productId || ''}\n\nMessage:\n${inquiry.message}\n\nReceived: ${inquiry.createdAt}`;
    if (inquiry.product) {
      try {
        const p = inquiry.product;
        body += `\n\n--- Product Details ---\nName: ${p.name || ''}\nBrand: ${p.brand || ''}\nType: ${p.type || ''}\nPrice: ${p.price != null ? p.price : ''}\nImage: ${p.image || ''}\nTags: ${Array.isArray(p.tags) ? p.tags.join(', ') : (p.tags || '')}`;
      } catch (e) {
        body += `\n\nProduct: ${JSON.stringify(inquiry.product)}`;
      }
    }

    // Verify transporter quickly (best-effort)
    try {
      await transporter.verify();
    } catch (vErr) {
      console.warn('SMTP transporter verify failed (continuing):', vErr && vErr.message ? vErr.message : vErr);
    }

    // Attempt to send with retries and exponential backoff
    const maxAttempts = 3;
    let attempt = 0;
    let lastErr = null;
    while (attempt < maxAttempts) {
      attempt++;
      try {
        // create a fresh transporter for each attempt
        const t = createTransporter(attempt > 1 ? { pool: true, secure: false } : {});
        if (!t) throw new Error('No SMTP configuration');
        await t.sendMail({ from, to, subject, text: body });
        console.log(`Sent inquiry email to ${to} on attempt ${attempt}`);
        return;
      } catch (sendErr) {
        lastErr = sendErr;
        const msg = sendErr && (sendErr.message || String(sendErr));
        console.error(`Failed to send inquiry email (attempt ${attempt}):`, msg);
        // If the error indicates a connection closed unexpectedly or ECONNECTION, retry after backoff
        const shouldRetry = attempt < maxAttempts && (msg && (msg.includes('Connection closed unexpectedly') || msg.includes('ECONNECTION') || msg.includes('ETIMEDOUT') || msg.includes('ECONNRESET')));
        if (!shouldRetry) break;
        const backoff = 500 * Math.pow(2, attempt - 1); // 500ms, 1000ms, ...
        await new Promise(r => setTimeout(r, backoff));
      }
    }

    // All attempts failed — before persisting failed email, try SendGrid fallback if available
    try {
      await sendViaSendGrid(subject, body);
      console.log('Sent inquiry email via SendGrid fallback after SMTP failure');
      return;
    } catch (sgErr) {
      console.warn('SendGrid fallback also failed:', sgErr && sgErr.message ? sgErr.message : sgErr);
    }

    // All attempts failed and SendGrid fallback failed — persist failed email to fallback file for later retries
    try {
      const record = { inquiry, subject, body, error: (lastErr && (lastErr.message || String(lastErr))) || 'unknown', at: new Date().toISOString() };
      let arr = [];
      try { const raw = await fs.readFile(failedFile, 'utf8'); arr = JSON.parse(raw) || []; } catch (e) { if (!(e && e.code === 'ENOENT')) console.error('Failed reading failed-email file', e); }
      arr.push(record);
      await fs.writeFile(failedFile, JSON.stringify(arr, null, 2), 'utf8');
      console.warn('Saved failed inquiry email to', failedFile);
    } catch (saveErr) {
      console.error('Failed to persist failed inquiry email', saveErr);
    }
  } catch (err) {
    console.error('Unexpected error in sendInquiryEmail', err);
  }
}

// Mount API route handlers from the `api/` folder (these are Vercel-style handlers)
const productsApi = require(path.join(__dirname, '..', 'api', 'products.js'));
const inquiriesApi = require(path.join(__dirname, '..', 'api', 'inquiries.js'));

app.get('/api/products', (req, res) => productsApi(req, res));
app.all('/api/inquiries', (req, res) => inquiriesApi(req, res));

// Simple health endpoint for monitoring
app.get('/_health', (req, res) => res.status(200).send('ok'));

// Start the HTTP server
app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});

// Graceful error handlers
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err && (err.stack || err));
});
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason && (reason.stack || reason));
});
