import 'dotenv/config'
import fs from 'fs'
import path from 'path'
import Database from 'better-sqlite3'

const DB_FILE   = process.env.DB_PATH   || 'data.sqlite'
const BACKUP_DIR = process.env.BACKUP_DIR || 'backup'

// pastikan folder backup ada
fs.mkdirSync(BACKUP_DIR, { recursive: true })

// buka db (WAL sudah aman untuk backup online)
const db = new Database(DB_FILE)
db.pragma('journal_mode = WAL')

// buat nama file backup
const ts = new Date().toISOString().replace(/[:.]/g, '-')
const dest = path.join(BACKUP_DIR, `w2e-${ts}.db`)

;(async () => {
  try {
    if (typeof db.backup === 'function') {
      await db.backup(dest)  // cara paling aman (online backup)
    } else {
      fs.copyFileSync(DB_FILE, dest) // fallback
    }
    console.log('Backup OK =>', dest)
    process.exit(0)
  } catch (e) {
    console.error('Backup failed:', e)
    process.exit(1)
  }
})()
