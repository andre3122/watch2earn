import 'dotenv/config'
import express from 'express'
import { Telegraf, Markup } from 'telegraf'
import Database from 'better-sqlite3'
import { customAlphabet } from 'nanoid'
import crypto from 'crypto'

// ==== Config (ENV) ====
const BOT_TOKEN = process.env.BOT_TOKEN || ''
if (!BOT_TOKEN) { console.error('Please set BOT_TOKEN in .env'); process.exit(1) }
const PORT = parseInt(process.env.PORT || '3000', 10)
const BASE_URL = process.env.BASE_URL || ('http://localhost:' + PORT)
const MIN_WITHDRAW = parseFloat(process.env.MIN_WITHDRAW || '1')
const REWARD_PER_TASK = parseFloat(process.env.REWARD_PER_TASK || '0.01')
const REF_BONUS_PCT = parseFloat(process.env.REF_BONUS_PCT || '10')
const VAST_TAG = process.env.VAST_TAG || ''
const POSTBACK_TOKEN = process.env.POSTBACK_TOKEN || ''

// Follow-task
const CHANNEL_ID = process.env.CHANNEL_ID ? parseInt(process.env.CHANNEL_ID, 10) : null
const CHANNEL_USERNAME = process.env.CHANNEL_USERNAME || ''
const FOLLOW_REWARD = parseFloat(process.env.FOLLOW_REWARD || '0.01')

// Check-in amounts (7 hari)
const CHECKIN_AMOUNTS = (process.env.CHECKIN_AMOUNTS || '0.02,0.04,0.06,0.08,0.10,0.12,0.15')
  .split(',')
  .map(s => parseFloat(s.trim()))
  .filter(n => !isNaN(n))
if (CHECKIN_AMOUNTS.length !== 7) {
  throw new Error('CHECKIN_AMOUNTS must have 7 numbers (comma separated)')
}

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
const todayUTC = () => new Date().toISOString().slice(0,10) // YYYY-MM-DD (UTC)

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
/* Check-in state per user */
CREATE TABLE IF NOT EXISTS checkins (
  tg_id INTEGER PRIMARY KEY,
  streak INTEGER DEFAULT 0,      -- 0..7 (dikunci di 7, sama spt versi lokalmu)
  last_claim TEXT                -- 'YYYY-MM-DD' (UTC)
);
CREATE TABLE IF NOT EXISTS postbacks (
  id INTEGER PRIMARY KEY,
  reqid TEXT UNIQUE,
  tg_id INTEGER,
  is_paid INTEGER,
  amount REAL,
  raw TEXT,
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
  // ensure checkin row exists
  const ck = db.prepare('SELECT 1 FROM checkins WHERE tg_id=?').get(user.id)
  if (!ck) db.prepare('INSERT INTO checkins (tg_id, streak, last_claim) VALUES (?,?,?)').run(user.id, 0, null)
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

// helper: cek membership channel
async function isMemberOfChannel(tgId) {
  const chatId = CHANNEL_ID || (CHANNEL_USERNAME ? '@' + CHANNEL_USERNAME : null)
  if (!chatId) throw new Error('Channel config not set')
  const gm = await bot.telegram.getChatMember(chatId, tgId)
  const s = gm?.status
  return ['member', 'administrator', 'creator', 'restricted'].includes(s)
}

bot.start(async (ctx) => {
  const payload = ctx.startPayload
  let refBy = null
  if (payload && payload.length >= 5) {
    const exists = db.prepare('SELECT ref_code FROM users WHERE ref_code = ?').get(payload)
    if (exists) refBy = payload
  }
  getOrCreateUserFromTG(ctx.from, refBy)
  const webAppUrl = `${BASE_URL}/webapp/mini/index.html`
  await ctx.reply(
    'Selamat datang! Buka Mini App untuk mulai.',
    Markup.inlineKeyboard([ Markup.button.webApp('Open Mini App ▶️', webAppUrl) ])
  )
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

// Health
app.get('/health', (req, res) => res.send('OK'))

// === CONFIG (+ follow_reward + checkin_amounts) ===
app.post('/api/config', (req, res) => {
  const { initData } = req.body || {}
  const u = verifyInitData(initData)
  if (!u) return res.status(403).json({ ok: false, error: 'bad initData' })
  const me = getOrCreateUserFromTG(u, null)
  res.json({
    ok: true,
    vastTag: VAST_TAG,
    reward: REWARD_PER_TASK,
    follow_reward: FOLLOW_REWARD,
    checkin_amounts: CHECKIN_AMOUNTS,
    min_withdraw: MIN_WITHDRAW,
    ref_bonus_pct: REF_BONUS_PCT,
    balance: me.balance,
    total_tasks: me.total_tasks
  })
})

// === CHECK-IN: status ===
app.post('/api/checkin/status', (req, res) => {
  const { initData } = req.body || {}
  const u = verifyInitData(initData)
  if (!u) return res.status(403).json({ ok:false, error:'bad initData' })
  getOrCreateUserFromTG(u, null)

  const row = db.prepare('SELECT streak, last_claim FROM checkins WHERE tg_id=?').get(u.id)
  const last = row?.last_claim || null
  const streak = row?.streak || 0
  const tdy = todayUTC()
  const can_claim = (last !== tdy)
  const idx = streak % 7
  const next_amount = CHECKIN_AMOUNTS[idx]

  res.json({ ok:true, streak, last_claim:last, can_claim, day_rewards:CHECKIN_AMOUNTS, next_amount })
})

// === CHECK-IN: claim ===
app.post('/api/checkin/claim', (req, res) => {
  try{
    const { initData } = req.body || {}
    const u = verifyInitData(initData)
    if (!u) return res.status(403).json({ ok:false, error:'bad initData' })
    getOrCreateUserFromTG(u, null)

    const tdy = todayUTC()
    const row = db.prepare('SELECT streak, last_claim FROM checkins WHERE tg_id=?').get(u.id)
    const last = row?.last_claim || null
    let streak = row?.streak || 0
    if (last === tdy) return res.status(400).json({ ok:false, error:'already claimed today' })

    const idx = streak % 7
    const amount = CHECKIN_AMOUNTS[idx]

    // credit ke user
    credit(u.id, amount, 'checkin', { day_index: idx })

    // update streak (dikunci di 7, sama dengan versi lokal kamu)
    streak = Math.min(streak + 1, 7)
    db.prepare('UPDATE checkins SET streak=?, last_claim=? WHERE tg_id=?').run(streak, tdy, u.id)

    res.json({ ok:true, balance_delta: amount, streak, last_claim: tdy, next_amount: CHECKIN_AMOUNTS[streak % 7] })
  }catch(e){
    console.error('checkin/claim error', e)
    res.status(500).json({ ok:false, error:'server error' })
  }
})

// === Start a Monetag pre-roll task ===
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

// === Complete (client fallback / adEnded) ===
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

// === Withdraw ===
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
  debit(me.tg_id, amt, { reason: 'withdraw_request', address })
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
    if (!POSTBACK_TOKEN || req.query.token !== POSTBACK_TOKEN) {
      return res.status(403).send('Forbidden')
    }
    const reqid = String(req.query.reqid || '').trim()
    const tgId = parseInt(String(req.query.telegram_id || '').trim(), 10) || 0
    const amount = parseFloat(String(req.query.estimated_price || '0')) || 0
    const isPaid = String(req.query.is_paid || req.query.reward_event_type || '0').toLowerCase()
    const paid = (isPaid === '1' || isPaid === 'yes')
    if (!reqid || !tgId) return res.status(400).send('Missing params')

    const seen = db.prepare('SELECT 1 FROM postbacks WHERE reqid = ?').get(reqid)
    if (seen) return res.status(200).send('Duplicate ignored')

    db.prepare('INSERT INTO postbacks (reqid, tg_id, is_paid, amount, raw) VALUES (?,?,?,?,?)')
      .run(reqid, tgId, paid ? 1 : 0, amount, JSON.stringify(req.query))

    if (paid) {
      let me = db.prepare('SELECT * FROM users WHERE tg_id=?').get(tgId)
      if (!me) {
        db.prepare('INSERT OR IGNORE INTO users (tg_id, ref_code) VALUES (?,?)').run(tgId, nanoid())
        me = db.prepare('SELECT * FROM users WHERE tg_id=?').get(tgId)
      }
      const creditAmount = amount > 0 ? amount : REWARD_PER_TASK
      credit(tgId, creditAmount, 's2s_postback', { source: 'monetag', reqid })
      db.prepare('UPDATE users SET total_tasks = total_tasks + 1 WHERE tg_id=?').run(tgId)

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

// === Follow Telegram: one-time claim ===
app.post('/api/follow/claim', async (req, res) => {
  try {
    const { initData } = req.body || {}
    const u = verifyInitData(initData)
    if (!u) return res.status(403).json({ ok:false, error:'bad initData' })

    const me = getOrCreateUserFromTG(u, null)

    const existed = db.prepare(
      "SELECT 1 FROM tasks WHERE tg_id=? AND task_id=? AND status='completed'"
    ).get(me.tg_id, 'follow_tg')
    if (existed) return res.json({ ok:true, balance_delta: 0 })

    if (!CHANNEL_ID && !CHANNEL_USERNAME) {
      return res.status(400).json({ ok:false, error:'Follow task not configured (channel missing)' })
    }

    let joined = false
    try { joined = await isMemberOfChannel(me.tg_id) }
    catch (e) {
      console.error('getChatMember error', e)
      return res.status(400).json({ ok:false, error:'Bot must be in channel (prefer admin) to verify membership' })
    }
    if (!joined) return res.status(400).json({ ok:false, error:'Please join the channel first' })

    credit(me.tg_id, FOLLOW_REWARD, 'follow_reward', { task_id:'follow_tg' })
    db.prepare('INSERT INTO tasks (tg_id, task_id, amount, status) VALUES (?,?,?,?)')
      .run(me.tg_id, 'follow_tg', FOLLOW_REWARD, 'completed')
    db.prepare('UPDATE users SET total_tasks = total_tasks + 1 WHERE tg_id=?').run(me.tg_id)

    return res.json({ ok:true, balance_delta: FOLLOW_REWARD })
  } catch (err) {
    console.error('follow/claim error', err)
    return res.status(500).json({ ok:false, error:'server error' })
  }
})

// Start server
app.listen(PORT, () => console.log('Server on', PORT))
