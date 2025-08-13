# Telegram Mini App — Monetag Pre‑roll Version

- Mini App memutar **VAST pre‑roll Monetag** via Fluid Player.
- Saat event **adEnded** → otomatis **/api/task/complete** → kredit saldo.
- Fallback timer (min N detik) jika iklan terblokir.
- Tetap ada **min withdraw** & **referral bonus** di backend.

## Quick Start
1. `npm install`
2. Copy `.env.example` → `.env`, isi:
   - `BOT_TOKEN=...` (dari BotFather)
   - `BASE_URL=http://localhost:3000` (atau domainmu)
   - `VAST_TAG=https://a.monetag.com/vast/XXXX?subid=...`
3. `npm run dev`
4. Telegram → `/start` → **Open Mini App** → **Mulai**

## Catatan Penting
- Monetag **tidak kirim S2S** untuk completion VAST → kita pakai event `adEnded` dari player (client-side). Hindari manipulasi dengan anti‑fraud (cooldown/IP/device).
- Patuhi **TOS Monetag** (hindari PTC/bot/exchange). Pastikan formatmu sesuai kebijakan (in‑stream pre‑roll).

## Endpoint
- `POST /api/config` → balikin VAST, reward, saldo.
- `POST /api/task/start` → buat task pending.
- `POST /api/task/complete` → kredit user + referral.
- `POST /api/withdraw` → buat permintaan withdraw (pending).
