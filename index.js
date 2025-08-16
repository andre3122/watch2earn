import 'dotenv/config'
import express from 'express'
import { Telegraf, Markup } from 'telegraf'
import Database from 'better-sqlite3'
import { customAlphabet } from 'nanoid'
import crypto from 'crypto'

/* ============ Config ============ */
const BOT_TOKEN = process.env.BOT_TOKEN || ''
if (!BOT_TOKEN) { console.error('Please set BOT_TOKEN in .env'); process.exit(1) }
const PORT = parseInt(process.env.PORT || '3000', 10)
const BASE_URL = process.env.BASE_URL || ('http://localhost:' + PORT)

const MIN_WITHDRAW     = parseFloat(process.env.MIN_WITHDRAW || '1')
const REWARD_PER_TASK  = parseFloat(process.env.REWARD_PER_TASK || '0.01')
const REF_BONUS_PCT    = parseFloat(process.env.REF_BONUS_PCT || '10')
const VAST_TAG         = process.env.VAST_TAG || ''
const POSTBACK_TOKEN   = process.env.POSTBACK_TOKEN || ''

// Follow-task config
const CHANNEL_ID       = process.env.CHANNEL_ID ? parseInt(process.env.CHANNEL_ID, 10) : null
const CHANNEL_USERNAME = process.env.CHANNEL_USERNAME || ''
const FOLLOW_REWARD    = parseFloat(process.env.FOLLOW_REWARD || '0.01')

// Check-in amounts (7 hari)
const CHECKIN_AMOUNTS = (process.env.CHECKIN_AMOUNTS
  ? process.env.CHECKIN_AMOUNTS.split(',').map(s => parseFloat(s.trim()))
  : [0.02,0.04,0.06,0.08,0.10,0.12,0.15]
).slice(0,7)
while (CHECKIN_AMOUNTS.length < 7) CHECKIN_AMOUNTS.push(0)

// Dev mode untuk test via browser biasa
const DEV_MODE = String(process.env.DEV_MODE || 'false').toLowerCase() === 'true'

const nanoid = customAlphabet('23456789ABCDEFGHJKLMNPQRSTUVWXYZ', 8)

/* ============ Utils ============ */
function verifyInitData(initData) {
  if (DEV_MODE) {
    // Dev user mock — HANYA untuk dev lokal
    return { id: 999, username: 'dev' }
  }
  if (!initData) return null
  const urlParams = new URLSearchParams(initData)
  const hash = urlParams.get('hash')
  urlParams.delete('hash')
  const data = []
  for (const [k, v] of Array.from(urlParams.entries()).sort((a,b)=>a[0].localeCompare(b[0]))) {
    data.push(`${k}=${v}`)
  }
  const dataCheckString = data.join('\n')
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest()
  const hmac = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex')
  if (hmac !== hash) return null
  const user = JSON.parse(urlParams.get('user') || '{}')
  return user
}
const todayUTC = () => new Date().toISOString().slice(0,10)
const diffDaysUTC = (a,b) => {
  const A = new Date(a+'T00:00:00Z').getTime()
  const B = new Date(b+'T00:00:00Z').getTime()
  return Math.round((A - B) / 86400000)
}

/* ============ DB ============ */
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
  reqid TEXT UNIQUE,
  tg_id INTEGER,
  is_paid INTEGER,
  amount REAL,
  raw TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS checkins (
  tg_id INTEGER PRIMARY KEY,
  streak INTEGER DEFAULT 0,
  last_claim TEXT
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
function getOrCreateCheckin(tg_id) {
  let row = db.prepare('SELECT * FROM checkins WHERE tg_id=?').get(tg_id)
  if (!row) {
    db.prepare('INSERT INTO checkins (tg_id, streak, last_claim) VALUES (?,?,?)').run(tg_id, 0, null)
    row = db.prepare('SELECT * FROM checkins WHERE tg_id=?').get(tg_id)
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

/* ============ Bot ============ */
const bot = new Telegraf(BOT_TOKEN)
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
  await ctx.reply('Selamat datang! Buka Mini App untuk mulai.',
    Markup.inlineKeyboard([Markup.button.webApp('Open Mini App ▶️', webAppUrl)]))
})
bot.command('ref', async (ctx) => {
  const me = getOrCreateUserFromTG(ctx.from)
  const refLink = `https://t.me/${(await bot.telegram.getMe()).username}?start=${me.ref_code}`
  const count = db.prepare('SELECT COUNT(*) as c FROM referrals WHERE ref_code=?').get(me.ref_code).c
  const bonus = db.prepare('SELECT COALESCE(SUM(bonus),0) as s FROM referrals WHERE ref_code=?').get(me.ref_code).s
  ctx.reply(`👥 Referral\nJumlah teman: ${count}\nBonus: ${Number(bonus).toFixed(2)} USDT\n${refLink}`)
})
bot.launch().then(() => console.log('Bot launched')).catch(e => console.error(e))

/* ============ Web server ============ */
const app = express()
app.use(express.json())
app.use('/webapp', express.static('webapp'))

app.get('/health', (_, res) => res.send('OK'))

// Config untuk client
app.post('/api/config', (req, res) => {
  const { initData } = req.body || {}
  const u = verifyInitData(initData)
  if (!u) return res.status(403).json({ ok:false, error:'bad initData' })
  const me = getOrCreateUserFromTG(u, null)
  res.json({
    ok: true,
    vastTag: VAST_TAG,
    reward: REWARD_PER_TASK,
    min_withdraw: MIN_WITHDRAW,
    ref_bonus_pct: REF_BONUS_PCT,
    follow_reward: FOLLOW_REWARD,
    checkin_amounts: CHECKIN_AMOUNTS,
    balance: me.balance,
    total_tasks: me.total_tasks
  })
})

/* ======= CHECK-IN ======= */
app.post('/api/checkin/status', (req, res) => {
  const { initData } = req.body || {}
  const u = verifyInitData(initData)
  if (!u) return res.status(403).json({ ok:false, error:'bad initData' })
  const me = getOrCreateUserFromTG(u, null)
  const ci = getOrCreateCheckin(me.tg_id)

  const today = todayUTC()
  const can_claim = (ci.last_claim !== today)
  const next_amount = (Array.isArray(CHECKIN_AMOUNTS) ? CHECKIN_AMOUNTS[ci.streak % 7] : 0) || 0
  res.json({ ok:true, streak: ci.streak, can_claim, next_amount })
})

app.post('/api/checkin/claim', (req, res) => {
  const { initData } = req.body || {}
  const u = verifyInitData(initData)
  if (!u) return res.status(403).json({ ok:false, error:'bad initData' })
  const me = getOrCreateUserFromTG(u, null)
  const ci = getOrCreateCheckin(me.tg_id)

  const today = todayUTC()
  if (ci.last_claim === today) return res.status(400).json({ ok:false, error:'already claimed' })

  let newStreak = 1
  if (ci.last_claim) {
    const delta = diffDaysUTC(today, ci.last_claim)
    newStreak = (delta === 1) ? Math.min(ci.streak + 1, 7) : 1
  }
  const amount = (Array.isArray(CHECKIN_AMOUNTS) ? CHECKIN_AMOUNTS[(newStreak - 1) % 7] : 0) || 0

  credit(me.tg_id, amount, 'daily_checkin', { streak_before: ci.streak })
  db.prepare('UPDATE checkins SET streak=?, last_claim=? WHERE tg_id=?').run(newStreak, today, me.tg_id)

  const next_amount = (Array.isArray(CHECKIN_AMOUNTS) ? CHECKIN_AMOUNTS[newStreak % 7] : 0) || 0
  res.json({ ok:true, balance_delta: amount, streak: newStreak, next_amount })
})

/* ======= Ads Task ======= */
app.post('/api/task/start', (req, res) => {
  const { initData } = req.body || {}
  const u = verifyInitData(initData)
  if (!u) return res.status(403).json({ ok:false, error:'bad initData' })
  const me = getOrCreateUserFromTG(u, null)
  const taskId = nanoid()
  db.prepare('INSERT INTO tasks (tg_id, task_id, amount, status) VALUES (?,?,?,?)')
    .run(me.tg_id, taskId, REWARD_PER_TASK, 'pending')
  res.json({ ok:true, task_id: taskId, min_watch_sec: 15 })
})

app.post('/api/task/complete', (req, res) => {
  const { initData, task_id } = req.body || {}
  const u = verifyInitData(initData)
  if (!u) return res.status(403).json({ ok:false, error:'bad initData' })
  const me = getOrCreateUserFromTG(u, null)
  const t = db.prepare('SELECT * FROM tasks WHERE task_id=? AND tg_id=?').get(task_id, me.tg_id)
  if (!t || t.status !== 'pending') return res.status(400).json({ ok:false, error:'task invalid' })

  credit(me.tg_id, t.amount, 'credit', { task_id })
  db.prepare('UPDATE users SET total_tasks = total_tasks + 1 WHERE tg_id=?').run(me.tg_id)
  db.prepare("UPDATE tasks SET status='completed', completed_at=datetime('now') WHERE id=?").run(t.id)

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
  res.json({ ok:true, balance_delta: t.amount })
})

/* ======= Withdraw ======= */
app.post('/api/withdraw', (req, res) => {
  const { initData, address } = req.body || {}
  const u = verifyInitData(initData)
  if (!u) return res.status(403).json({ ok:false, error:'bad initData' })
  const me = getOrCreateUserFromTG(u, null)

  const row = db.prepare('SELECT * FROM users WHERE tg_id=?').get(me.tg_id)
  if (row.balance < MIN_WITHDRAW) {
    return res.status(400).json({ ok:false, error:'min withdraw not met', balance: row.balance })
  }
  const amt = row.balance
  debit(me.tg_id, amt, { reason: 'withdraw_request' })
  db.prepare('INSERT INTO withdrawals (tg_id, amount, address, status) VALUES (?,?,?,?)')
    .run(me.tg_id, amt, address, 'pending')
  res.json({ ok:true, amount: amt })
})

/* ======= Monetag Postback ======= */
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

app.listen(PORT, () => console.log('Server on', PORT))
