import 'dotenv/config'
import express from 'express'
import { Telegraf, Markup } from 'telegraf'
import Database from 'better-sqlite3'
import { customAlphabet } from 'nanoid'
import crypto from 'crypto'

// ==== Config ====
const BOT_TOKEN = process.env.BOT_TOKEN || ''
if (!BOT_TOKEN) { console.error('Please set BOT_TOKEN in .env'); process.exit(1) }
const PORT = parseInt(process.env.PORT || '3000', 10)
const BASE_URL = process.env.BASE_URL || ('http://localhost:' + PORT)
const MIN_WITHDRAW = parseFloat(process.env.MIN_WITHDRAW || '1')
const REWARD_PER_TASK = parseFloat(process.env.REWARD_PER_TASK || '0.01')
const REF_BONUS_PCT = parseFloat(process.env.REF_BONUS_PCT || '10')
const VAST_TAG = process.env.VAST_TAG || ''                // Monetag VAST tag
const POSTBACK_TOKEN = process.env.POSTBACK_TOKEN || ''    // untuk /postback/monetag

const nanoid = customAlphabet('23456789ABCDEFGHJKLMNPQRSTUVWXYZ', 8)

// ==== Utils ====
function verifyInitData(initData) {
  if (!initData) return null
  const urlParams = new URLSearchParams(initData)
  const hash = urlParams.get('hash')
  urlParams.delete('hash')
  const data = []
  for (const [k, v] of Array.from(urlParams.entries()).sort((a, b) => a[0].localeCompare(b[0]))) {
    data.push(`${k}=${v}`)
  }
  const dataCheckString = data.join('\n')
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest()
  const hmac = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex')
  if (hmac !== hash) return null
  const user = JSON.parse(urlParams.get('user') || '{}')
  return user
}

// ==== DB ====
const db = new Database('data.sqlite')
db.pragma('journal_mode = WAL')
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  tg_id INTEGER UNIQUE,
  username TEXT,
  first_name TEXT,
  ref_code TEXT UNIQUE,
  referred_by TEXT,
  balance REAL DEFAULT 0,
  total_earned REAL DEFAULT 0,
  total_tasks INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS referrals (
  id INTEGER PRIMARY KEY,
  ref_code TEXT,
  invitee_tg_id INTEGER,
  bonus REAL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY,
  tg_id INTEGER,
  task_id TEXT,
  amount REAL,
  status TEXT, -- pending|completed
  created_at TEXT DEFAULT (datetime('now')),
  completed_at TEXT
);
CREATE TABLE IF NOT EXISTS withdrawals (
  id INTEGER PRIMARY KEY,
  tg_id INTEGER,
  amount REAL,
  address TEXT,
  status TEXT DEFAULT 'pending',
  created_at TEXT DEFAULT (datetime('now')),
  processed_at TEXT
);
CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY,
  tg_id INTEGER,
  type TEXT,
  amount REAL,
  meta TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS postbacks (
  id INTEGER PRIMARY KEY,
  reqid TEXT UNIQUE,        -- unik event dari Monetag
  tg_id INTEGER,            -- telegram user id
  is_paid INTEGER,          -- 1 kalau berbayar
  amount REAL,              -- estimated_price/reward
  raw TEXT,                 -- seluruh query utk debugging
  created_at TEXT DEFAULT (datetime('now'))
);
`)

function getOrCreateUserFromTG(user, referred_by_code = null) {
  let row = db.prepare('SELECT * FROM users WHERE tg_id=?').get(user.id)
  if (!row) {
    let code = nanoid()
    while (db.prepare('SELECT 1 FROM users WHERE ref_code=?').get(code)) code = nanoid()
    db.prepare('INSERT INTO users (tg_id, username, first_name, ref_code, referred_by) VALUES (?,?,?,?,?)')
      .run(user.id, user.username || null, user.first_name || null, code, referred_by_code)
    row = db.prepare('SELECT * FROM users WHERE tg_id=?').get(user.id)
  } else {
    db.prepare('UPDATE users SET username=?, first_name=? WHERE tg_id=?')
      .run(user.username || null, user.first_name || null, user.id)
  }
  return row
}

function credit(tg_id, amount, type = 'credit', meta = {}) {
  db.prepare('UPDATE users SET balance = balance + ?, total_earned = total_earned + ? WHERE tg_id=?')
    .run(amount, amount, tg_id)
  db.prepare('INSERT INTO transactions (tg_id, type, amount, meta) VALUES (?,?,?,?)')
    .run(tg_id, type, amount, JSON.stringify(meta))
}
function debit(tg_id, amount, meta = {}) {
  db.prepare('UPDATE users SET balance = balance - ? WHERE tg_id=?').run(amount, tg_id)
  db.prepare('INSERT INTO transactions (tg_id, type, amount, meta) VALUES (?,?,?,?)')
    .run(tg_id, 'debit', amount, JSON.stringify(meta))
}

// ==== Bot ====
const bot = new Telegraf(BOT_TOKEN)

bot.start(async (ctx) => {
  const payload = ctx.startPayload
  let refBy = null
  if (payload && payload.length >= 5) {
    const exists = db.prepare('SELECT ref_code FROM users WHERE ref_code=?').get(payload)
    if (exists) refBy = payload
  }
  const me = getOrCreateUserFromTG(ctx.from, refBy)
  const refLink = `https://t.me/${(await bot.telegram.getMe()).username}?start=${me.ref_code}`
  const webAppUrl = `${BASE_URL}/webapp/mini/index.html`
  await ctx.reply('Selamat datang! Buka Mini App untuk mulai.',
    Markup.inlineKeyboard([Markup.button.webApp('Open Mini App ▶️', webAppUrl)])
  )
  await ctx.reply(`Saldo: ${me.balance.toFixed(2)} USDT | Min WD: ${MIN_WITHDRAW} USDT\n/ref untuk link referral.\nVAST tag: ${VAST_TAG ? 'SET' : 'NOT SET'}`)
})

bot.command('ref', async (ctx) => {
  const me = getOrCreateUserFromTG(ctx.from)
  const refLink = `https://t.me/${(await bot.telegram.getMe()).username}?start=${me.ref_code}`
  const count = db.prepare('SELECT COUNT(*) as c FROM referrals WHERE ref_code=?').get(me.ref_code).c
  const bonus = db.prepare('SELECT COALESCE(SUM(bonus),0) as s FROM referrals WHERE ref_code=?').get(me.ref_code).s
  ctx.reply(`👥 Referral\nJumlah teman: ${count}\nBonus: ${Number(bonus).toFixed(2)} USDT\n${refLink}`)
})

bot.launch().then(() => console.log('Bot launched')).catch(e => console.error(e))

// ==== Web server ====
const app = express()
app.use(express.json())
app.use('/webapp', express.static('webapp'))

// Health (cek cepat)
app.get('/health', (req, res) => res.send('OK'))

// Config endpoint (returns VAST tag and reward settings)
app.post('/api/config', (req, res) => {
  const { initData } = req.body || {}
  const u = verifyInitData(initData)
  if (!u) return res.status(403).json({ ok: false, error: 'bad initData' })
  const me = getOrCreateUserFromTG(u, null)
  res.json({
    ok: true,
    vastTag: VAST_TAG,
    reward: REWARD_PER_TASK,
    min_withdraw: MIN_WITHDRAW,
    ref_bonus_pct: REF_BONUS_PCT,
    balance: me.balance,
    total_tasks: me.total_tasks
  })
})

// Start a Monetag pre-roll task
app.post('/api/task/start', (req, res) => {
  const { initData } = req.body || {}
  const u = verifyInitData(initData)
  if (!u) return res.status(403).json({ ok: false, error: 'bad initData' })
  const me = getOrCreateUserFromTG(u, null)
  const taskId = nanoid()
  db.prepare('INSERT INTO tasks (tg_id, task_id, amount, status) VALUES (?,?,?,?)')
    .run(me.tg_id, taskId, REWARD_PER_TASK, 'pending')
  res.json({ ok: true, task_id: taskId, min_watch_sec: 15 })
})

// Complete (client fallback / adEnded)
app.post('/api/task/complete', (req, res) => {
  const { initData, task_id } = req.body || {}
  const u = verifyInitData(initData)
  if (!u) return res.status(403).json({ ok: false, error: 'bad initData' })
  const me = getOrCreateUserFromTG(u, null)
  const t = db.prepare('SELECT * FROM tasks WHERE task_id=? AND tg_id=?').get(task_id, me.tg_id)
  if (!t || t.status !== 'pending') return res.status(400).json({ ok: false, error: 'task invalid' })

  credit(me.tg_id, t.amount, 'credit', { task_id })
  db.prepare('UPDATE users SET total_tasks = total_tasks + 1 WHERE tg_id=?').run(me.tg_id)
  db.prepare("UPDATE tasks SET status='completed', completed_at=datetime('now') WHERE id=?").run(t.id)

  // referral bonus
  const userRow = db.prepare('SELECT * FROM users WHERE tg_id=?').get(me.tg_id)
  if (userRow?.referred_by) {
    const inviter = db.prepare('SELECT * FROM users WHERE ref_code=?').get(userRow.referred_by)
    if (inviter) {
      const bonus = +(t.amount * (REF_BONUS_PCT / 100)).toFixed(6)
      credit(inviter.tg_id, bonus, 'ref_bonus', { from: me.tg_id, task_id })
      db.prepare('INSERT INTO referrals (ref_code, invitee_tg_id, bonus) VALUES (?,?,?)')
        .run(inviter.ref_code, me.tg_id, bonus)
    }
  }

  res.json({ ok: true, balance_delta: t.amount })
})

// Withdraw
app.post('/api/withdraw', (req, res) => {
  const { initData, address } = req.body || {}
  const u = verifyInitData(initData)
  if (!u) return res.status(403).json({ ok: false, error: 'bad initData' })
  const me = getOrCreateUserFromTG(u, null)

  const row = db.prepare('SELECT * FROM users WHERE tg_id=?').get(me.tg_id)
  if (row.balance < MIN_WITHDRAW) {
    return res.status(400).json({ ok: false, error: 'min withdraw not met', balance: row.balance })
  }
  const amt = row.balance
  debit(me.tg_id, amt, { reason: 'withdraw_request' })
  db.prepare('INSERT INTO withdrawals (tg_id, amount, address, status) VALUES (?,?,?,?)')
    .run(me.tg_id, amt, address, 'pending')
  res.json({ ok: true, amount: amt })
})

/** =========================
 *  Monetag S2S POSTBACK
 *  =========================
 * GET /postback/monetag?token=...&reqid=...&telegram_id=...&estimated_price=...&is_paid=1
 */
app.get('/postback/monetag', (req, res) => {
  try {
    // 1) token gate
    if (!POSTBACK_TOKEN || req.query.token !== POSTBACK_TOKEN) {
      return res.status(403).send('Forbidden')
    }

    // 2) params
    const reqid = String(req.query.reqid || '').trim()
    const tgId = parseInt(String(req.query.telegram_id || '').trim(), 10) || 0
    const amount = parseFloat(String(req.query.estimated_price || '0')) || 0
    const isPaid = String(req.query.is_paid || req.query.reward_event_type || '0').toLowerCase()
    const paid = (isPaid === '1' || isPaid === 'yes')

    if (!reqid || !tgId) return res.status(400).send('Missing params')

    // 3) dedup
    const seen = db.prepare('SELECT 1 FROM postbacks WHERE reqid = ?').get(reqid)
    if (seen) return res.status(200).send('Duplicate ignored')

    // 4) simpan log
    db.prepare('INSERT INTO postbacks (reqid, tg_id, is_paid, amount, raw) VALUES (?,?,?,?,?)')
      .run(reqid, tgId, paid ? 1 : 0, amount, JSON.stringify(req.query))

    // 5) kredit kalau paid
    if (paid) {
      // pastikan user ada
      let me = db.prepare('SELECT * FROM users WHERE tg_id=?').get(tgId)
      if (!me) {
        db.prepare('INSERT OR IGNORE INTO users (tg_id, ref_code) VALUES (?,?)').run(tgId, nanoid())
        me = db.prepare('SELECT * FROM users WHERE tg_id=?').get(tgId)
      }

      const creditAmount = amount > 0 ? amount : REWARD_PER_TASK
      credit(tgId, creditAmount, 's2s_postback', { source: 'monetag', reqid })
      db.prepare('UPDATE users SET total_tasks = total_tasks + 1 WHERE tg_id=?').run(tgId)

      // referral bonus (opsional: sama seperti di /api/task/complete)
      if (me?.referred_by) {
        const inviter = db.prepare('SELECT * FROM users WHERE ref_code=?').get(me.referred_by)
        if (inviter) {
          const bonus = +(creditAmount * (REF_BONUS_PCT / 100)).toFixed(6)
          if (bonus > 0) {
            credit(inviter.tg_id, bonus, 'ref_bonus', { from: tgId, reqid, source: 'monetag' })
            db.prepare('INSERT INTO referrals (ref_code, invitee_tg_id, bonus) VALUES (?,?,?)')
              .run(inviter.ref_code, tgId, bonus)
          }
        }
      }
    }

    return res.status(200).send('OK')
  } catch (e) {
    console.error('postback error', e)
    return res.status(500).send('Error')
  }
})

app.listen(PORT, () => console.log('Server on', PORT))
                                  
