require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const { Pool } = require('pg');
const multer   = require('multer');
const { v4: uuidv4 } = require('uuid');
const QRCode   = require('qrcode');
const path     = require('path');
const https    = require('https');
const http     = require('http');
const crypto   = require('crypto');
const jwt      = require('jsonwebtoken');

const app  = express();
const PORT = process.env.PORT || 3000;
const BASE_URL   = process.env.BASE_URL   || 'https://qr-se-resume.onrender.com';
// SECURITY: hardcoded secret source/GitHub par public tha — koi bhi apna
// superadmin token sign kar sakta tha. Env nahi mila to random per-boot.
const crypto2 = require('crypto');
const JWT_SECRET = process.env.JWT_SECRET || crypto2.randomBytes(32).toString('hex');
if (!process.env.JWT_SECRET) console.log('⚠️  JWT_SECRET env set karo — abhi har restart par logins invalid honge');
const ADMIN_USER = process.env.SUPER_ADMIN_ID;
const ADMIN_PASS = process.env.SUPER_ADMIN_PASS;
if (!ADMIN_USER || !ADMIN_PASS) console.log('⚠️  SUPER_ADMIN_ID / SUPER_ADMIN_PASS env set nahi — admin login DISABLED');

// Razorpay — SUPER ADMIN (Rupesh) ke liye setup fee collection
// SECURITY: pehle LIVE Razorpay key+secret yahin hardcoded the — source
// dekhne wala koi bhi account par API calls kar sakta tha. Env-only ab.
// (Purani key Razorpay dashboard se REGENERATE karna zaroori hai — git
// history mein leak ho chuki hai.)
const ADMIN_RZP_KEY_ID  = process.env.ADMIN_RAZORPAY_KEY_ID  || '';
const ADMIN_RZP_SECRET  = process.env.ADMIN_RAZORPAY_KEY_SECRET || '';
if (!ADMIN_RZP_KEY_ID || !ADMIN_RZP_SECRET) console.log('⚠️  ADMIN_RAZORPAY_KEY_ID/SECRET env set nahi — setup fee payment DISABLED');

// App version — agents check this for auto-update
const APP_VERSION = process.env.APP_VERSION || '2.1.0';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static('public'));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20*1024*1024 } });

// ── DB Init ───────────────────────────────────────────────────────────────────
async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS resume_shops (
        id               VARCHAR(50)  PRIMARY KEY,
        name             VARCHAR(200) NOT NULL,
        address          TEXT,
        phone            VARCHAR(20),
        email            VARCHAR(200),
        price_bw         INTEGER      DEFAULT 10,
        price_color      INTEGER      DEFAULT 20,
        payment_mode     VARCHAR(20)  DEFAULT 'both',
        rzp_key_id       TEXT,
        rzp_key_secret   TEXT,
        phonepay_key     TEXT,
        password_hash    TEXT,
        qr_code          TEXT,
        setup_paid       BOOLEAN      DEFAULT FALSE,
        active           BOOLEAN      DEFAULT TRUE,
        created_at       TIMESTAMP    DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS resume_jobs (
        id                VARCHAR(50)  PRIMARY KEY,
        shop_id           VARCHAR(50),
        customer_name     VARCHAR(200),
        file_url          TEXT,
        color_mode        VARCHAR(10)  DEFAULT 'bw',
        amount            INTEGER,
        status            VARCHAR(20)  DEFAULT 'pending',
        payment_status    VARCHAR(20)  DEFAULT 'pending',
        payment_method    VARCHAR(20)  DEFAULT 'counter',
        payment_id        VARCHAR(200),
        razorpay_order_id VARCHAR(200),
        created_at        TIMESTAMP    DEFAULT NOW(),
        printed_at        TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS setup_orders (
        id          VARCHAR(50) PRIMARY KEY,
        shop_id     VARCHAR(50),
        amount      INTEGER DEFAULT 499,
        status      VARCHAR(20) DEFAULT 'pending',
        rzp_order_id VARCHAR(200),
        created_at  TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS app_settings (
        key   VARCHAR(100) PRIMARY KEY,
        value TEXT
      );

      INSERT INTO app_settings(key,value) VALUES
        ('setup_price','499'),('setup_offer_price','499'),
        ('app_version','2.1.0')
      ON CONFLICT(key) DO NOTHING;

      -- Add columns if not exist (safe migration)
      ALTER TABLE resume_shops ADD COLUMN IF NOT EXISTS password_hash TEXT;
      ALTER TABLE resume_shops ADD COLUMN IF NOT EXISTS email VARCHAR(200);
      ALTER TABLE resume_shops ADD COLUMN IF NOT EXISTS payment_mode VARCHAR(20) DEFAULT 'both';
      ALTER TABLE resume_shops ADD COLUMN IF NOT EXISTS rzp_key_id TEXT;
      ALTER TABLE resume_shops ADD COLUMN IF NOT EXISTS rzp_key_secret TEXT;
      ALTER TABLE resume_shops ADD COLUMN IF NOT EXISTS phonepay_key TEXT;
      ALTER TABLE resume_shops ADD COLUMN IF NOT EXISTS setup_paid BOOLEAN DEFAULT FALSE;
      ALTER TABLE resume_shops ADD COLUMN IF NOT EXISTS active BOOLEAN DEFAULT TRUE;
      ALTER TABLE resume_shops ADD COLUMN IF NOT EXISTS installed_printers TEXT DEFAULT '[]';
      ALTER TABLE resume_shops ADD COLUMN IF NOT EXISTS printer_selected TEXT DEFAULT '';
      ALTER TABLE resume_shops ADD COLUMN IF NOT EXISTS printer_bw TEXT DEFAULT '';
      ALTER TABLE resume_shops ADD COLUMN IF NOT EXISTS printer_color TEXT DEFAULT '';
      ALTER TABLE resume_shops ADD COLUMN IF NOT EXISTS advanced_status VARCHAR(20) DEFAULT 'locked';
      ALTER TABLE resume_shops ADD COLUMN IF NOT EXISTS printers_updated_at TIMESTAMP;
    `);
    console.log('✅ DB ready');
  } catch(err) { console.error('❌ DB:', err.message); }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function hashPass(p) { return crypto.createHash('sha256').update(p+'qrresume2026').digest('hex'); }

function authShop(req, res, next) {
  const token = req.headers['authorization']?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    req.shop = jwt.verify(token, JWT_SECRET);
    next();
  } catch { res.status(401).json({ error: 'Invalid token' }); }
}

function authAdmin(req, res, next) {
  const token = req.headers['authorization']?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    const d = jwt.verify(token, JWT_SECRET);
    if (d.role !== 'superadmin') return res.status(403).json({ error: 'Not admin' });
    req.admin = d;
    next();
  } catch { res.status(401).json({ error: 'Invalid token' }); }
}

async function razorpayOrder(amountPaise, receipt, keyId, secret) {
  const auth = Buffer.from(`${keyId}:${secret}`).toString('base64');
  const body = JSON.stringify({ amount: amountPaise, currency: 'INR', receipt });
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'api.razorpay.com', path: '/v1/orders', method: 'POST',
      headers: { 'Content-Type':'application/json', 'Authorization':'Basic '+auth, 'Content-Length':Buffer.byteLength(body) }
    };
    const req = https.request(opts, r => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>{ try{resolve(JSON.parse(d))}catch(e){reject(e)} }); });
    req.on('error',reject); req.write(body); req.end();
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// SUPER ADMIN AUTH
// ══════════════════════════════════════════════════════════════════════════════
app.post('/api/admin/login', (req, res) => {
  if (!ADMIN_USER || !ADMIN_PASS) return res.status(503).json({ error: 'Admin login configured nahi — server env mein SUPER_ADMIN_ID/SUPER_ADMIN_PASS set karo' });
  const { username, password } = req.body;
  if (username === ADMIN_USER && password === ADMIN_PASS) {
    const token = jwt.sign({ role:'superadmin', username }, JWT_SECRET, { expiresIn:'24h' });
    res.json({ success:true, token });
  } else {
    res.status(401).json({ error: 'Invalid credentials' });
  }
});

app.get('/api/admin/stats', authAdmin, async (req, res) => {
  try {
    const shops  = await pool.query('SELECT COUNT(*) as total, COUNT(CASE WHEN setup_paid THEN 1 END) as paid FROM resume_shops');
    const orders = await pool.query("SELECT COUNT(*) as total, COALESCE(SUM(amount),0) as revenue FROM resume_jobs WHERE payment_status='paid'");
    const setup  = await pool.query("SELECT COUNT(*) as total, COALESCE(SUM(amount),0) as revenue FROM setup_orders WHERE status='paid'");
    const settings = await pool.query('SELECT key,value FROM app_settings');
    const cfg = {};
    settings.rows.forEach(r => cfg[r.key] = r.value);
    res.json({ shops: shops.rows[0], orders: orders.rows[0], setup: setup.rows[0], settings: cfg });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/shops', authAdmin, async (req, res) => {
  try {
    const r = await pool.query('SELECT id,name,address,phone,email,price_bw,price_color,payment_mode,setup_paid,active,created_at,advanced_status FROM resume_shops ORDER BY created_at DESC');
    res.json(r.rows);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/settings', authAdmin, async (req, res) => {
  try {
    const { setup_price, setup_offer_price } = req.body;
    await pool.query(`INSERT INTO app_settings(key,value) VALUES('setup_price',$1),('setup_offer_price',$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`, [setup_price, setup_offer_price]);
    res.json({ success:true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/toggle-shop', authAdmin, async (req, res) => {
  try {
    const { shopId, active } = req.body;
    await pool.query('UPDATE resume_shops SET active=$1 WHERE id=$2', [active, shopId]);
    res.json({ success:true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════════════════════════════════
// SHOP OWNER AUTH
// ══════════════════════════════════════════════════════════════════════════════
app.post('/api/shop/login', async (req, res) => {
  try {
    const { shopId, password } = req.body;
    const r = await pool.query('SELECT * FROM resume_shops WHERE id=$1', [shopId]);
    if (!r.rows.length) return res.status(404).json({ error: 'Shop not found' });
    const shop = r.rows[0];
    if (!shop.setup_paid) return res.status(403).json({ error: 'Setup fee pending' });
    if (shop.password_hash !== hashPass(password)) return res.status(401).json({ error: 'Wrong password' });
    const token = jwt.sign({ shopId, role:'shop' }, JWT_SECRET, { expiresIn:'24h' });
    res.json({ success:true, token, shop: { id:shop.id, name:shop.name, address:shop.address, phone:shop.phone, price_bw:shop.price_bw, price_color:shop.price_color, payment_mode:shop.payment_mode } });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/shop/me', authShop, async (req, res) => {
  try {
    const r = await pool.query('SELECT id,name,address,phone,email,price_bw,price_color,payment_mode,rzp_key_id,phonepay_key,qr_code,setup_paid,active,installed_printers,printer_selected,printer_bw,printer_color,advanced_status,created_at FROM resume_shops WHERE id=$1', [req.shop.shopId]);
    if (!r.rows.length) return res.status(404).json({ error: 'Shop not found' });
    res.json(r.rows[0]);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/shop/update', authShop, async (req, res) => {
  try {
    const { name, address, phone, email, price_bw, price_color, payment_mode, rzp_key_id, rzp_key_secret, phonepay_key, password } = req.body;
    const shopId = req.shop.shopId;
    let q = 'UPDATE resume_shops SET name=$1,address=$2,phone=$3,email=$4,price_bw=$5,price_color=$6,payment_mode=$7,rzp_key_id=$8,phonepay_key=$9';
    const params = [name, address, phone, email, price_bw||10, price_color||20, payment_mode||'both', rzp_key_id||'', phonepay_key||''];
    if (rzp_key_secret) { q += ',rzp_key_secret=$'+(params.length+1); params.push(rzp_key_secret); }
    if (password) { q += ',password_hash=$'+(params.length+1); params.push(hashPass(password)); }
    params.push(shopId);
    q += ' WHERE id=$'+params.length;
    await pool.query(q, params);
    res.json({ success:true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/shop/:shopId/stats', async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const r = await pool.query(`SELECT COUNT(*) as total_orders,COALESCE(SUM(amount),0) as total_earnings,COUNT(CASE WHEN DATE(created_at)=$1 THEN 1 END) as today_orders,COALESCE(SUM(CASE WHEN DATE(created_at)=$1 THEN amount ELSE 0 END),0) as today_earnings FROM resume_jobs WHERE shop_id=$2 AND payment_status='paid'`, [today, req.params.shopId]);
    res.json(r.rows[0]);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════════════════════════════════
// SHOP SETUP (Registration + Fee Payment)
// ══════════════════════════════════════════════════════════════════════════════
app.get('/api/settings', async (req, res) => {
  try {
    const r = await pool.query('SELECT key,value FROM app_settings');
    const cfg = {};
    r.rows.forEach(row => cfg[row.key] = row.value);
    res.json(cfg);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/shop/register', async (req, res) => {
  try {
    const { name, address, phone, email, price_bw, price_color, payment_mode, rzp_key_id, rzp_key_secret, phonepay_key, password } = req.body;
    if (!name) return res.status(400).json({ error: 'Shop name required' });
    if (!password) return res.status(400).json({ error: 'Password required' });
    const shopId = 'RSHOP_' + uuidv4().substring(0,8).toUpperCase();
    const qrUrl  = `${BASE_URL}/resume/${shopId}`;
    const qrCode = await QRCode.toDataURL(qrUrl, { width:300, margin:2 });
    await pool.query(
      `INSERT INTO resume_shops(id,name,address,phone,email,price_bw,price_color,payment_mode,rzp_key_id,rzp_key_secret,phonepay_key,password_hash,qr_code,setup_paid)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,false)`,
      [shopId, name, address||'', phone||'', email||'', price_bw||10, price_color||20, payment_mode||'both', rzp_key_id||'', rzp_key_secret||'', phonepay_key||'', hashPass(password), qrCode]
    );
    res.json({ success:true, shopId, qrCode, qrUrl });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Setup fee payment — Rupesh ka Razorpay
app.post('/api/shop/setup-payment/create', async (req, res) => {
  try {
    const { shopId } = req.body;
    const priceR = await pool.query("SELECT value FROM app_settings WHERE key='setup_offer_price'");
    const price  = parseInt(priceR.rows[0]?.value || '499');
    const order  = await razorpayOrder(price*100, shopId, ADMIN_RZP_KEY_ID, ADMIN_RZP_SECRET);
    if (!order.id) return res.status(400).json({ error: 'Order create failed', details: order });
    const orderId = 'SETUP_' + uuidv4().substring(0,10).toUpperCase();
    await pool.query('INSERT INTO setup_orders(id,shop_id,amount,rzp_order_id) VALUES($1,$2,$3,$4)', [orderId, shopId, price, order.id]);
    res.json({ success:true, orderId:order.id, amount:price*100, keyId:ADMIN_RZP_KEY_ID, shopId });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/shop/setup-payment/verify', async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, shopId } = req.body;
    const expected = crypto.createHmac('sha256', ADMIN_RZP_SECRET).update(`${razorpay_order_id}|${razorpay_payment_id}`).digest('hex');
    if (expected !== razorpay_signature) return res.status(400).json({ error: 'Signature mismatch' });
    await pool.query('UPDATE resume_shops SET setup_paid=true WHERE id=$1', [shopId]);
    await pool.query("UPDATE setup_orders SET status='paid' WHERE rzp_order_id=$1", [razorpay_order_id]);
    // Get shop data for response
    const r = await pool.query('SELECT id,name,qr_code FROM resume_shops WHERE id=$1', [shopId]);
    const shop = r.rows[0];
    res.json({ success:true, shopId, qrCode:shop.qr_code, qrUrl:`${BASE_URL}/resume/${shopId}` });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════════════════════════════════
// PUBLIC SHOP INFO
// ══════════════════════════════════════════════════════════════════════════════
app.get('/api/shop/:shopId', async (req, res) => {
  try {
    const r = await pool.query('SELECT id,name,address,phone,price_bw,price_color,payment_mode,rzp_key_id,setup_paid,active FROM resume_shops WHERE id=$1', [req.params.shopId]);
    if (!r.rows.length) return res.status(404).json({ error: 'Shop not found' });
    const shop = r.rows[0];
    if (!shop.active) return res.status(403).json({ error: 'Shop inactive' });
    res.json(shop);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/shops', authAdmin, async (req, res) => {
  try {
    const r = await pool.query('SELECT id,name,address,phone,price_bw,price_color,payment_mode,setup_paid,active,created_at FROM resume_shops ORDER BY created_at DESC');
    res.json(r.rows);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════════════════════════════════
// PDF UPLOAD & JOBS
// ══════════════════════════════════════════════════════════════════════════════
app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    const { shopId, colorMode, customerName } = req.body;
    const shopR = await pool.query('SELECT * FROM resume_shops WHERE id=$1 AND setup_paid=true AND active=true', [shopId]);
    if (!shopR.rows.length) return res.status(404).json({ error: 'Shop not found or inactive' });
    const shop       = shopR.rows[0];
    const base64PDF  = req.file.buffer.toString('base64');
    const finalColor = colorMode === 'color' ? 'color' : 'bw';
    const price      = finalColor === 'color' ? shop.price_color : shop.price_bw;
    const jobId      = 'RJOB_' + uuidv4().substring(0,12).toUpperCase();
    await pool.query(
      `INSERT INTO resume_jobs(id,shop_id,customer_name,file_url,color_mode,amount,status,payment_status) VALUES($1,$2,$3,$4,$5,$6,'pending','pending')`,
      [jobId, shopId, customerName||'Customer', base64PDF, finalColor, price]
    );
    res.json({ success:true, jobId, amount:price });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════════════════════════════════
// PAYMENT — Shop ke Razorpay/PhonePe
// ══════════════════════════════════════════════════════════════════════════════
app.post('/api/payment/razorpay/create', async (req, res) => {
  try {
    const { jobId } = req.body;
    const jobR  = await pool.query('SELECT rj.*,rs.rzp_key_id,rs.rzp_key_secret FROM resume_jobs rj JOIN resume_shops rs ON rj.shop_id=rs.id WHERE rj.id=$1', [jobId]);
    if (!jobR.rows.length) return res.status(404).json({ error: 'Job not found' });
    const job   = jobR.rows[0];
    if (!job.rzp_key_id || !job.rzp_key_secret) return res.status(400).json({ error: 'Razorpay not configured for this shop' });
    const order = await razorpayOrder(job.amount*100, jobId, job.rzp_key_id, job.rzp_key_secret);
    if (!order.id) return res.status(400).json({ error: 'Razorpay order failed' });
    await pool.query('UPDATE resume_jobs SET razorpay_order_id=$1,payment_method=$2 WHERE id=$3', [order.id,'online',jobId]);
    res.json({ success:true, orderId:order.id, amount:job.amount*100, keyId:job.rzp_key_id, jobId });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/payment/razorpay/verify', async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, jobId } = req.body;
    const jobR = await pool.query('SELECT rj.*,rs.rzp_key_secret FROM resume_jobs rj JOIN resume_shops rs ON rj.shop_id=rs.id WHERE rj.id=$1', [jobId]);
    if (!jobR.rows.length) return res.status(404).json({ error: 'Job not found' });
    const expected = crypto.createHmac('sha256', jobR.rows[0].rzp_key_secret).update(`${razorpay_order_id}|${razorpay_payment_id}`).digest('hex');
    if (expected !== razorpay_signature) return res.status(400).json({ error: 'Signature mismatch' });
    await pool.query(`UPDATE resume_jobs SET payment_status='paid',status='queued',payment_id=$1 WHERE id=$2`, [razorpay_payment_id, jobId]);
    res.json({ success:true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/payment/counter', async (req, res) => {
  try {
    const { jobId } = req.body;
    const jobR = await pool.query('SELECT amount FROM resume_jobs WHERE id=$1', [jobId]);
    if (!jobR.rows.length) return res.status(404).json({ error: 'Job not found' });
    const txnId = 'CTR_' + uuidv4().substring(0,10).toUpperCase();
    await pool.query(`UPDATE resume_jobs SET payment_status='paid',status='queued',payment_id=$1,payment_method='counter' WHERE id=$2`, [txnId, jobId]);
    res.json({ success:true, txnId, amount:jobR.rows[0].amount });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════════════════════════════════
// PRINT AGENT APIs
// ══════════════════════════════════════════════════════════════════════════════
// Auto-update check
app.get('/api/agent/version', (req, res) => {
  res.json({ version: APP_VERSION, updateUrl: `${BASE_URL}/downloads/print_agent.py` });
});

app.get('/api/jobs/pending/:shopId', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id,customer_name,color_mode,amount FROM resume_jobs WHERE shop_id=$1 AND status='queued' AND payment_status='paid' ORDER BY created_at ASC LIMIT 5`,
      [req.params.shopId]
    );
    // Shop ki printer settings har poll mein — dashboard mein change hote
    // hi agent ko agle poll (5 sec) mein mil jati hai
    const sh = await pool.query(
      'SELECT printer_selected,printer_bw,printer_color,advanced_status FROM resume_shops WHERE id=$1',
      [req.params.shopId]
    );
    const sp = sh.rows[0] || {};
    res.json({ jobs: r.rows, settings: {
      printer: sp.printer_selected || '',
      printer_bw: sp.printer_bw || '',
      printer_color: sp.printer_color || '',
      advanced: sp.advanced_status === 'approved'
    }});
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── Agent: installed printers report (dashboard dropdown ke liye) ──
app.post('/api/agent/printers/:shopId', async (req, res) => {
  try {
    let { printers } = req.body;
    if (!Array.isArray(printers)) return res.status(400).json({ error: 'printers array chahiye' });
    printers = printers.filter(p => typeof p === 'string').slice(0, 20);
    const r = await pool.query(
      'UPDATE resume_shops SET installed_printers=$1, printers_updated_at=NOW() WHERE id=$2 RETURNING id',
      [JSON.stringify(printers), req.params.shopId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Shop not found' });
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── Shop: printer select (normal — ek printer sab ke liye) ──
app.post('/api/shop/printer', authShop, async (req, res) => {
  try {
    const { printer } = req.body;
    const sh = await pool.query('SELECT installed_printers FROM resume_shops WHERE id=$1', [req.shop.shopId]);
    const installed = JSON.parse(sh.rows[0]?.installed_printers || '[]');
    // Sirf agent ki report ki hui list mein se ('' = auto/default)
    if (printer && installed.length && !installed.includes(printer))
      return res.status(400).json({ error: 'Yeh printer installed list mein nahi — Print Agent chal raha hai?' });
    await pool.query('UPDATE resume_shops SET printer_selected=$1 WHERE id=$2', [printer || '', req.shop.shopId]);
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── Shop: advanced BW/Color printers (sirf approved shops) ──
app.post('/api/shop/printer-advanced', authShop, async (req, res) => {
  try {
    const { printer_bw, printer_color } = req.body;
    const sh = await pool.query('SELECT installed_printers,advanced_status FROM resume_shops WHERE id=$1', [req.shop.shopId]);
    if (!sh.rows.length) return res.status(404).json({ error: 'Shop not found' });
    if (sh.rows[0].advanced_status !== 'approved')
      return res.status(403).json({ error: 'Advanced feature abhi unlock nahi hua — Super Admin approval chahiye' });
    const installed = JSON.parse(sh.rows[0].installed_printers || '[]');
    for (const p of [printer_bw, printer_color]) {
      if (p && installed.length && !installed.includes(p))
        return res.status(400).json({ error: `"${p}" installed list mein nahi hai` });
    }
    await pool.query('UPDATE resume_shops SET printer_bw=$1, printer_color=$2 WHERE id=$3',
      [printer_bw || '', printer_color || '', req.shop.shopId]);
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── Shop: advanced unlock request ──
app.post('/api/shop/request-advanced', authShop, async (req, res) => {
  try {
    const sh = await pool.query('SELECT advanced_status FROM resume_shops WHERE id=$1', [req.shop.shopId]);
    const st = sh.rows[0]?.advanced_status || 'locked';
    if (st === 'approved') return res.json({ success: true, status: 'approved' });
    if (st === 'pending')  return res.json({ success: true, status: 'pending' });
    await pool.query("UPDATE resume_shops SET advanced_status='pending' WHERE id=$1", [req.shop.shopId]);
    res.json({ success: true, status: 'pending' });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── Shop: print logs (color/BW, earning) ──
app.get('/api/shop/print-logs', authShop, async (req, res) => {
  try {
    const logs = await pool.query(
      `SELECT id,customer_name,color_mode,amount,status,payment_status,created_at,printed_at
       FROM resume_jobs WHERE shop_id=$1 ORDER BY created_at DESC LIMIT 100`,
      [req.shop.shopId]);
    const sum = await pool.query(
      `SELECT COUNT(CASE WHEN status='printed' THEN 1 END) as total_printed,
              COUNT(CASE WHEN status='printed' AND color_mode='bw' THEN 1 END) as bw_printed,
              COUNT(CASE WHEN status='printed' AND color_mode='color' THEN 1 END) as color_printed,
              COALESCE(SUM(CASE WHEN status='printed' AND payment_status='paid' THEN amount ELSE 0 END),0) as earnings
       FROM resume_jobs WHERE shop_id=$1`, [req.shop.shopId]);
    res.json({ logs: logs.rows, summary: sum.rows[0] });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── Admin: unlock requests + decision ──
app.get('/api/admin/unlock-requests', authAdmin, async (req, res) => {
  try {
    const r = await pool.query(
      "SELECT id,name,phone,created_at FROM resume_shops WHERE advanced_status='pending' ORDER BY created_at DESC");
    res.json(r.rows);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/unlock-decision', authAdmin, async (req, res) => {
  try {
    const { shopId, action } = req.body; // 'approved' | 'denied'
    if (!['approved','denied'].includes(action)) return res.status(400).json({ error: 'Invalid action' });
    await pool.query('UPDATE resume_shops SET advanced_status=$1 WHERE id=$2', [action, shopId]);
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── Admin: shop delete (pending/junk registrations hatane ke liye) ──
app.delete('/api/admin/shops/:shopId', authAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM resume_jobs WHERE shop_id=$1', [req.params.shopId]);
    await pool.query('DELETE FROM setup_orders WHERE shop_id=$1', [req.params.shopId]);
    await pool.query('DELETE FROM resume_shops WHERE id=$1', [req.params.shopId]);
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/jobs/file/:jobId', async (req, res) => {
  try {
    const r = await pool.query('SELECT file_url FROM resume_jobs WHERE id=$1', [req.params.jobId]);
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    const buf = Buffer.from(r.rows[0].file_url, 'base64');
    res.set('Content-Type','application/pdf');
    res.set('Content-Disposition','attachment; filename="resume.pdf"');
    res.set('Content-Length', buf.length);
    res.send(buf);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/jobs/complete/:jobId', async (req, res) => {
  try {
    await pool.query(`UPDATE resume_jobs SET status='printed',printed_at=NOW(),file_url='done' WHERE id=$1`, [req.params.jobId]);
    res.json({ success:true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/jobs/failed/:jobId', async (req, res) => {
  try {
    await pool.query(`UPDATE resume_jobs SET status='failed' WHERE id=$1`, [req.params.jobId]);
    res.json({ success:true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});


// ══════════════════════════════════════════════════════════════════════════════
// INSTRUCTIONS (Super Admin → All Shop Owners)
// ══════════════════════════════════════════════════════════════════════════════
app.get('/api/instructions', async (req, res) => {
  try {
    const r = await pool.query('SELECT key,value FROM app_settings WHERE key LIKE $1 ORDER BY key', ['inst_%']);
    const items = r.rows.map(row => ({ id: row.key, text: row.value }));
    res.json({ items });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/instructions/add', authAdmin, async (req, res) => {
  try {
    const { text } = req.body;
    const id = 'inst_' + Date.now();
    await pool.query('INSERT INTO app_settings(key,value) VALUES($1,$2)', [id, text]);
    res.json({ success:true, id });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/instructions/delete', authAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM app_settings WHERE key=$1', [req.body.id]);
    res.json({ success:true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/version-update', authAdmin, async (req, res) => {
  try {
    const { version } = req.body;
    await pool.query("INSERT INTO app_settings(key,value) VALUES('app_version',$1) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value", [version]);
    res.json({ success:true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Dynamic print_agent.py download with shopId pre-filled
app.get('/downloads/print_agent.py', (req, res) => {
  const shopId = req.query.shopId || 'AAPKA_RSHOP_ID';
  const agentCode = generateAgentCode(shopId);
  res.set('Content-Type', 'text/x-python');
  res.set('Content-Disposition', `attachment; filename="print_agent.py"`);
  res.send(agentCode);
});

// README download
app.get('/downloads/README.txt', (req, res) => {
  const readme = `QR Se Resume — Print Agent Setup
=====================================

STEP 1: SumatraPDF Install Karo
- sumatrapdfreader.org pe jao
- Download karo aur install karo
- Agar install mein time lage to Google se "SumatraPDF download" search karo

STEP 2: Print Agent Run Karo
- print_agent.exe pe double click karo
- System tray mein icon aayega (neeche right corner)
- Band mat karo — background mein chalta rahega

STEP 3: QR Code Lagao
- Downloaded QR image print karo
- Dukaan pe prominently lagao

Auto-Update:
- Agent khud hi update hota rehega
- Koi manual update nahi karna

Support: instagram.com/rupeshkr73
`;
  res.set('Content-Type', 'text/plain; charset=utf-8');
  res.set('Content-Disposition', 'attachment; filename="README.txt"');
  res.send(readme);
});

function generateAgentCode(shopId) {
  return `# QR Se Resume - Print Agent (Auto-generated)
# Shop ID: ${shopId}
# Do NOT edit Shop ID manually

SHOP_ID = "${shopId}"
SERVER_URL = "https://qr-se-resume.onrender.com"

import requests, time, os, sys, tempfile, subprocess
from datetime import datetime

VERSION = "2.1.0"
CHECK_INTERVAL = 5
LOG_FILE = "agent_log.txt"

def log(msg, level="INFO"):
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    line = f"[{ts}] [{level}] {msg}"
    print(line)
    try:
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except: pass

def check_update():
    try:
        r = requests.get(f"{SERVER_URL}/api/agent/version", timeout=10)
        d = r.json()
        if d.get("version") != VERSION:
            log(f"🔄 New version {d['version']} available — updating...")
            new_code = requests.get(f"{SERVER_URL}/downloads/print_agent.py?shopId={SHOP_ID}", timeout=30).text
            script_path = os.path.abspath(sys.argv[0])
            with open(script_path, 'w', encoding='utf-8') as f:
                f.write(new_code)
            log("✅ Updated! Restarting...")
            os.execv(sys.executable, [sys.executable] + sys.argv)
    except Exception as e:
        log(f"Update check failed: {e}", "WARN")

def download_pdf(job_id):
    try:
        url = f"{SERVER_URL}/api/jobs/file/{job_id}"
        resp = requests.get(url, timeout=60)
        resp.raise_for_status()
        if not resp.content.startswith(b'%PDF'):
            log("❌ Not a valid PDF", "ERROR")
            return None
        tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".pdf")
        tmp.write(resp.content)
        tmp.close()
        return tmp.name
    except Exception as e:
        log(f"❌ Download failed: {e}", "ERROR")
        return None

def print_pdf(filepath, color_mode="bw"):
    sumatra_paths = [
        r"C:\\Program Files\\SumatraPDF\\SumatraPDF.exe",
        r"C:\\Program Files (x86)\\SumatraPDF\\SumatraPDF.exe",
        os.path.expanduser(r"~\\AppData\\Local\\SumatraPDF\\SumatraPDF.exe"),
    ]
    settings = f"copies=1,{'monochrome,' if color_mode=='bw' else ''}fit"
    for sumatra in sumatra_paths:
        if os.path.exists(sumatra):
            cmd = [sumatra, "-print-to-default", "-silent", "-print-settings", settings, filepath]
            result = subprocess.run(cmd, timeout=120, capture_output=True)
            if result.returncode == 0:
                log(f"✅ Printed! ({color_mode.upper()})")
                return True
    try:
        os.startfile(filepath, "print")
        time.sleep(5)
        return True
    except Exception as e:
        log(f"❌ Print failed: {e}", "ERROR")
        return False

def get_pending_jobs():
    try:
        r = requests.get(f"{SERVER_URL}/api/jobs/pending/{SHOP_ID}", timeout=15)
        return r.json().get("jobs", [])
    except: return []

def mark_complete(job_id):
    try: requests.post(f"{SERVER_URL}/api/jobs/complete/{job_id}", timeout=15)
    except: pass

def mark_failed(job_id, reason=""):
    try: requests.post(f"{SERVER_URL}/api/jobs/failed/{job_id}", json={"reason": reason}, timeout=10)
    except: pass

def process_job(job):
    job_id = job["id"]
    color  = job.get("color_mode", "bw")
    log(f"📄 Job: {job_id} | {job.get('customer_name')} | {color.upper()} | ₹{job.get('amount')}")
    fp = download_pdf(job_id)
    if not fp: mark_failed(job_id, "Download failed"); return
    success = print_pdf(fp, color)
    try:
        time.sleep(2)
        if os.path.exists(fp): os.unlink(fp)
    except: pass
    if success: mark_complete(job_id); log(f"🎉 Done: {job_id}")
    else: mark_failed(job_id, "Print failed")

def main():
    log(f"🚀 QR Se Resume Agent v{VERSION} | Shop: {SHOP_ID}")
    check_update()
    errors = 0
    chk = 0
    while True:
        try:
            jobs = get_pending_jobs()
            chk += 1
            if jobs:
                log(f"📬 {len(jobs)} job(s)!")
                for job in jobs: process_job(job)
                errors = 0
            elif chk % 60 == 0:
                log(f"👀 Waiting... ({chk*CHECK_INTERVAL//60} min)")
            time.sleep(CHECK_INTERVAL)
        except KeyboardInterrupt: break
        except Exception as e:
            errors += 1
            log(f"❌ {e}", "ERROR")
            time.sleep(CHECK_INTERVAL)

if __name__ == "__main__":
    main()
`;
}

// Serve downloads folder
app.use('/downloads', express.static(path.join(__dirname, 'public', 'downloads')));

// Dynamic INSTALL.bat with shopId
app.get('/downloads/INSTALL.bat', (req, res) => {
  const shopId = req.query.shopId || 'AAPKA_RSHOP_ID';
  const fs = require('fs');
  let bat = fs.readFileSync(path.join(__dirname, 'public', 'downloads', 'INSTALL.bat'), 'utf8');
  res.set('Content-Type', 'application/octet-stream');
  res.set('Content-Disposition', 'attachment; filename="INSTALL.bat"');
  res.send(bat);
});

// ── Pages ─────────────────────────────────────────────────────────────────────
app.get('/',               (_,res) => res.sendFile(path.join(__dirname,'public','index.html')));
app.get('/setup',          (_,res) => res.sendFile(path.join(__dirname,'public','setup.html')));
app.get('/shop-admin',     (_,res) => res.sendFile(path.join(__dirname,'public','shop-admin.html')));
app.get('/super-admin',    (_,res) => res.sendFile(path.join(__dirname,'public','super-admin.html')));
app.get('/resume/:shopId', (_,res) => res.sendFile(path.join(__dirname,'public','resume.html')));

initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`🚀 QR Se Resume v${APP_VERSION} — Port ${PORT}`);
    console.log(`🌐 ${BASE_URL}`);
  });
});
