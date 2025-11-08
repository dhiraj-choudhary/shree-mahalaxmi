const fs = require('fs').promises;
const path = require('path');
const nodemailer = require('nodemailer');
const os = require('os');

const INQUIRIES_FILE = path.join(process.cwd(), 'server', 'data', 'inquiries.json');
const FALLBACK_INQUIRIES_FILE = path.join(os.tmpdir(), 'inquiries.json');

async function readJson(file) {
  // try primary file first
  try {
    const raw = await fs.readFile(file, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      // primary doesn't exist — try fallback
      try {
        const raw2 = await fs.readFile(FALLBACK_INQUIRIES_FILE, 'utf8');
        return JSON.parse(raw2);
      } catch (err2) {
        if (err2 && err2.code === 'ENOENT') return [];
        // other error reading fallback — surface
        throw err2;
      }
    }
    // If primary exists but can't be read for another reason, try fallback
    try {
      const raw2 = await fs.readFile(FALLBACK_INQUIRIES_FILE, 'utf8');
      return JSON.parse(raw2);
    } catch (err2) {
      // If both fail, if primary was ENOENT we returned above — otherwise rethrow original
      if (err && err.code === 'ENOENT') return [];
      throw err;
    }
  }
}

async function writeJson(file, data) {
  const json = JSON.stringify(data, null, 2);
  // First try to write to the intended file (useful for local/dev servers)
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, json, 'utf8');
    return;
  } catch (err) {
    // If filesystem is read-only (common on serverless platforms) or the target
    // path can't be created (ENOENT on some serverless images), fallback to tmp
    if (err && (err.code === 'EROFS' || err.code === 'EPERM' || err.code === 'EACCES' || err.code === 'ENOENT')) {
      try {
        console.warn(`Unable to write to ${file} (${err && err.code}); falling back to ${FALLBACK_INQUIRIES_FILE}`);
        await fs.mkdir(path.dirname(FALLBACK_INQUIRIES_FILE), { recursive: true });
        await fs.writeFile(FALLBACK_INQUIRIES_FILE, json, 'utf8');
        console.warn(`Wrote inquiries to fallback file ${FALLBACK_INQUIRIES_FILE} due to filesystem restrictions or missing path`);
        return;
      } catch (err2) {
        console.error('Failed to write fallback inquiries file', err2);
        throw err2;
      }
    }
    // Other errors: rethrow
    throw err;
  }
}

function createTransporter(overrides = {}) {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_PORT) return null;
  const auth = SMTP_USER && SMTP_PASS ? { user: SMTP_USER, pass: SMTP_PASS } : undefined;
  const cfg = Object.assign({
    host: SMTP_HOST,
    port: parseInt(SMTP_PORT, 10),
    secure: String(SMTP_PORT) === '465',
    auth,
    // reasonable defaults
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 10_000
  }, overrides);
  return nodemailer.createTransport(cfg);
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
    // use native https to avoid fetch/node-fetch dependency
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

    // If running on Vercel (serverless) and no SendGrid key, avoid long SMTP timeouts — do one short attempt and then persist failure
    const isServerless = Boolean(process.env.VERCEL || process.env.NOW);
    if (isServerless && !process.env.SENDGRID_API_KEY) {
      console.warn('Running on serverless platform without SendGrid API key; SMTP ports may be blocked. Will attempt a short SMTP try then persist on failure.');
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

module.exports = async (req, res) => {
  try {
    if (req.method === 'GET') {
      const inquiries = await readJson(INQUIRIES_FILE);
      return res.status(200).json(inquiries);
    }

    if (req.method === 'POST') {
      const { name, phone, email, message, productId, product } = req.body || {};
      if (!name || !phone || !email || !message) {
        return res.status(400).json({ error: 'name, phone, email and message are required' });
      }
      const inquiries = await readJson(INQUIRIES_FILE);
      const id = inquiries.length > 0 ? inquiries[inquiries.length - 1].id + 1 : 1;
      const inquiry = { id, name, phone, email, message, productId: productId || null, createdAt: new Date().toISOString() };
      // include product only when provided (avoid storing null/empty product)
      if (product) {
        inquiry.product = product;
      }
      await writeJson(INQUIRIES_FILE, [...inquiries, inquiry]);
      console.log('Stored new inquiry:', inquiry);

      // send email notification
      try {
        await sendInquiryEmail(inquiry);
        return res.status(201).json(inquiry);
      } catch (err) {
        console.error('Failed to send inquiry email', err);
        return res.status(201).json(inquiry); // respond with inquiry data even if email fails
      }
    }

    return res.status(405).end(); // Method Not Allowed
  } catch (err) {
    console.error('Unexpected error in API handler', err);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
};
