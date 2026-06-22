require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const QRCode = require('qrcode');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || 'https://qr-se-resume.onrender.com';

const CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME || '';
const CLD_KEY    = process.env.CLOUDINARY_API_KEY    || '';
const CLD_SECRET = process.env.CLOUDINARY_API_SECRET || '';
const RZP_KEY_ID = process.env.RAZORPAY_KEY_ID       || '';
const RZP_SECRET = process.env.RAZORPAY_KEY_SECRET   || '';

// ── DB ────────────────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static('public'));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }
});

// ── DB Init ───────────────────────────────────────────────────────────────────
async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS resume_shops (
        id          VARCHAR(50) PRIMARY KEY,
        name        VARCHAR(200) NOT NULL,
        address     TEXT,
        phone       VARCHAR(20),
        price_bw    INTEGER DEFAULT 20,
        price_color INTEGER DEFAULT 30,
        qr_code     TEXT,
        created_at  TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS resume_jobs (
        id                VARCHAR(50) PRIMARY KEY,
        shop_id           VARCHAR(50),
        customer_name     VARCHAR(200),
        file_url          TEXT,
        file_public_id    VARCHAR(500),
        color_mode        VARCHAR(10) DEFAULT 'bw',
        amount            INTEGER,
        status            VARCHAR(20) DEFAULT 'pending',
        payment_status    VARCHAR(20) DEFAULT 'pending',
        payment_method    VARCHAR(20) DEFAULT 'counter',
        payment_id        VARCHAR(200),
        razorpay_order_id VARCHAR(200),
        created_at        TIMESTAMP DEFAULT NOW(),
        printed_at        TIMESTAMP
      );
    `);
    console.log('✅ DB ready');
  } catch (err) {
    console.error('❌ DB error:', err.message);
  }
}

// ── Cloudinary Upload (multipart — works with all key types) ──────────────────
async function uploadToCloudinary(fileBuffer) {
  return new Promise((resolve, reject) => {
    const ts  = Math.round(Date.now() / 1000);
    const pid = 'resume_' + uuidv4().replace(/-/g,'').substring(0, 10);

    // Signature string — alphabetical order
    const sigStr = `public_id=${pid}&resource_type=raw&timestamp=${ts}${CLD_SECRET}`;
    const sig = crypto.createHash('sha256').update(sigStr).digest('hex');

    // Build multipart manually
    const boundary = 'X' + crypto.randomBytes(16).toString('hex');
    const parts = [];

    function addField(name, value) {
      parts.push(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`
      );
    }

    addField('api_key',       CLD_KEY);
    addField('timestamp',     String(ts));
    addField('public_id',     pid);
    addField('resource_type', 'raw');
    addField('signature',     sig);

    // File part
    const filePart = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="resume.pdf"\r\nContent-Type: application/pdf\r\n\r\n`
      ),
      fileBuffer,
      Buffer.from('\r\n')
    ]);

    const endPart = Buffer.from(`--${boundary}--\r\n`);
    const textParts = Buffer.from(parts.join(''), 'utf8');
    const body = Buffer.concat([textParts, filePart, endPart]);

    const options = {
      hostname: 'api.cloudinary.com',
      path: `/v1_1/${CLOUD_NAME}/raw/upload`,
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length
      }
    };

    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const r = JSON.parse(data);
          console.log('Cloudinary:', r.secure_url ? '✅ OK' : '❌ ' + JSON.stringify(r));
          if (r.secure_url) {
            resolve({ url: r.secure_url, publicId: r.public_id });
          } else {
            reject(new Error('Cloudinary upload failed: ' + JSON.stringify(r)));
          }
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Cloudinary Delete ─────────────────────────────────────────────────────────
async function deleteFromCloudinary(publicId) {
  return new Promise(resolve => {
    const ts  = Math.round(Date.now() / 1000);
    const sig = crypto.createHash('sha256')
      .update(`public_id=${publicId}&timestamp=${ts}${CLD_SECRET}`)
      .digest('hex');
    const body = new URLSearchParams({
      public_id: publicId,
      api_key: CLD_KEY,
      timestamp: String(ts),
      signature: sig
    }).toString();
    const opts = {
      hostname: 'api.cloudinary.com',
      path: `/v1_1/${CLOUD_NAME}/raw/destroy`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body)
      }
    };
    const req = https.request(opts, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { console.log('🗑 Deleted from Cloudinary:', publicId); resolve(); });
    });
    req.on('error', () => resolve());
    req.write(body); req.end();
  });
}

// ── Razorpay ──────────────────────────────────────────────────────────────────
async function createRazorpayOrder(amountPaise, receipt) {
  const auth = Buffer.from(`${RZP_KEY_ID}:${RZP_SECRET}`).toString('base64');
  const body = JSON.stringify({ amount: amountPaise, currency: 'INR', receipt });
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'api.razorpay.com', path: '/v1/orders', method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Basic ' + auth,
        'Content-Length': Buffer.byteLength(body)
      }
    };
    const req = https.request(opts, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
    });
    req.on('error', reject); req.write(body); req.end();
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// SHOP APIs
// ═══════════════════════════════════════════════════════════════════════════════
app.post('/api/shop/register', async (req, res) => {
  try {
    const { name, address, phone, price_bw, price_color } = req.body;
    if (!name) return res.status(400).json({ error: 'Shop name required' });
    const shopId = 'RSHOP_' + uuidv4().substring(0,8).toUpperCase();
    await pool.query(
      'INSERT INTO resume_shops (id,name,address,phone,price_bw,price_color) VALUES ($1,$2,$3,$4,$5,$6)',
      [shopId, name, address||'', phone||'', price_bw||20, price_color||30]
    );
    const qrUrl  = `${BASE_URL}/resume/${shopId}`;
    const qrCode = await QRCode.toDataURL(qrUrl, { width:300, margin:2 });
    await pool.query('UPDATE resume_shops SET qr_code=$1 WHERE id=$2', [qrCode, shopId]);
    res.json({ success:true, shopId, qrCode, qrUrl });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/shop/:shopId', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM resume_shops WHERE id=$1', [req.params.shopId]);
    if (!r.rows.length) return res.status(404).json({ error: 'Shop not found' });
    res.json(r.rows[0]);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/shops', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM resume_shops ORDER BY created_at DESC');
    res.json(r.rows);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/shop/update-price', async (req, res) => {
  try {
    const { shopId, price_bw, price_color } = req.body;
    if (!shopId) return res.status(400).json({ error: 'shopId required' });
    await pool.query(
      'UPDATE resume_shops SET price_bw=$1, price_color=$2 WHERE id=$3',
      [price_bw, price_color, shopId]
    );
    console.log(`✅ Price updated: ${shopId} — BW ₹${price_bw} | Color ₹${price_color}`);
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/shop/:shopId/stats', async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const r = await pool.query(`
      SELECT
        COUNT(*) as total_orders,
        COALESCE(SUM(amount),0) as total_earnings,
        COUNT(CASE WHEN DATE(created_at)=$1 THEN 1 END) as today_orders,
        COALESCE(SUM(CASE WHEN DATE(created_at)=$1 THEN amount ELSE 0 END),0) as today_earnings
      FROM resume_jobs WHERE shop_id=$2 AND payment_status='paid'
    `, [today, req.params.shopId]);
    res.json(r.rows[0]);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// UPLOAD
// ═══════════════════════════════════════════════════════════════════════════════
app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const { shopId, colorMode, customerName } = req.body;
    if (!shopId) return res.status(400).json({ error: 'shopId required' });

    const shopR = await pool.query('SELECT * FROM resume_shops WHERE id=$1', [shopId]);
    if (!shopR.rows.length) return res.status(404).json({ error: 'Shop not found' });
    const shop = shopR.rows[0];

    console.log(`📤 Uploading PDF for shop ${shopId}, size: ${req.file.buffer.length} bytes`);
    const { url, publicId } = await uploadToCloudinary(req.file.buffer);

    const finalColor = colorMode === 'color' ? 'color' : 'bw';
    const price      = finalColor === 'color' ? shop.price_color : shop.price_bw;
    const jobId      = 'RJOB_' + uuidv4().substring(0,12).toUpperCase();

    await pool.query(
      `INSERT INTO resume_jobs
        (id,shop_id,customer_name,file_url,file_public_id,color_mode,amount,status,payment_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'pending','pending')`,
      [jobId, shopId, customerName||'Customer', url, publicId, finalColor, price]
    );

    console.log(`✅ Job created: ${jobId}`);
    res.json({ success:true, jobId, amount:price });
  } catch(err) {
    console.error('Upload error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// PAYMENT
// ═══════════════════════════════════════════════════════════════════════════════
app.post('/api/payment/razorpay/create', async (req, res) => {
  try {
    const { jobId } = req.body;
    if (!RZP_KEY_ID) return res.status(400).json({ error: 'Razorpay not configured' });
    const jobR = await pool.query('SELECT * FROM resume_jobs WHERE id=$1', [jobId]);
    if (!jobR.rows.length) return res.status(404).json({ error: 'Job not found' });
    const job = jobR.rows[0];
    const order = await createRazorpayOrder(job.amount * 100, jobId);
    if (!order.id) return res.status(400).json({ error: 'Razorpay failed', details: order });
    await pool.query(
      'UPDATE resume_jobs SET razorpay_order_id=$1,payment_method=$2 WHERE id=$3',
      [order.id, 'online', jobId]
    );
    res.json({ success:true, orderId:order.id, amount:job.amount*100, keyId:RZP_KEY_ID, jobId });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/payment/razorpay/verify', async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, jobId } = req.body;
    const expected = crypto.createHmac('sha256', RZP_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`).digest('hex');
    if (expected !== razorpay_signature)
      return res.status(400).json({ error: 'Signature mismatch' });
    await pool.query(
      `UPDATE resume_jobs SET payment_status='paid',status='queued',payment_id=$1 WHERE id=$2`,
      [razorpay_payment_id, jobId]
    );
    res.json({ success:true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/payment/counter', async (req, res) => {
  try {
    const { jobId } = req.body;
    const jobR = await pool.query('SELECT amount FROM resume_jobs WHERE id=$1', [jobId]);
    if (!jobR.rows.length) return res.status(404).json({ error: 'Job not found' });
    const txnId = 'COUNTER_' + uuidv4().substring(0,10).toUpperCase();
    await pool.query(
      `UPDATE resume_jobs SET payment_status='paid',status='queued',payment_id=$1,payment_method='counter' WHERE id=$2`,
      [txnId, jobId]
    );
    console.log(`💵 Counter payment: ${jobId} ₹${jobR.rows[0].amount}`);
    res.json({ success:true, txnId, amount:jobR.rows[0].amount });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// PRINT AGENT
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/api/jobs/pending/:shopId', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id,customer_name,file_url,file_public_id,color_mode,amount
       FROM resume_jobs
       WHERE shop_id=$1 AND status='queued' AND payment_status='paid'
       ORDER BY created_at ASC LIMIT 5`,
      [req.params.shopId]
    );
    res.json({ jobs: r.rows });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/jobs/complete/:jobId', async (req, res) => {
  try {
    const r = await pool.query(
      `UPDATE resume_jobs SET status='printed',printed_at=NOW() WHERE id=$1 RETURNING file_public_id`,
      [req.params.jobId]
    );
    if (r.rows.length && r.rows[0].file_public_id) {
      await deleteFromCloudinary(r.rows[0].file_public_id);
    }
    res.json({ success:true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/jobs/failed/:jobId', async (req, res) => {
  try {
    await pool.query(`UPDATE resume_jobs SET status='failed' WHERE id=$1`, [req.params.jobId]);
    res.json({ success:true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/razorpay/config', (req, res) => {
  res.json({ enabled: !!(RZP_KEY_ID && RZP_SECRET), keyId: RZP_KEY_ID || null });
});

// ── Pages ─────────────────────────────────────────────────────────────────────
app.get('/',               (req,res) => res.sendFile(path.join(__dirname,'public','index.html')));
app.get('/dashboard',      (req,res) => res.sendFile(path.join(__dirname,'public','dashboard.html')));
app.get('/resume/:shopId', (req,res) => res.sendFile(path.join(__dirname,'public','resume.html')));

initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`🚀 QR Se Resume — Port ${PORT}`);
    console.log(`🌐 ${BASE_URL}`);
    console.log(`☁️  Cloudinary: ${CLOUD_NAME || '❌ NOT SET'}`);
    console.log(`💳 Razorpay: ${RZP_KEY_ID ? '✅' : '❌ Not set'}`);
  });
});
