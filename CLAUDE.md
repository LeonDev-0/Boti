# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**MasTV Bot** is a WhatsApp-based IPTV subscription service bot written in TypeScript/Node.js. It automates: user registration, plan selection, payment via QR (VeriPagos), and IPTV account creation/renewal via Puppeteer panel automation.

## Commands

```bash
# Run the bot
npx tsx boti.ts

# Database migrations
npx prisma migrate dev

# Generate Prisma client
npx prisma generate

# Inspect DB
npx prisma studio
```

There are no tests configured (`npm test` exits 1).

## Architecture

### Entry Point: `boti.ts`
Initializes the Baileys (WhatsApp Web) socket, registers message event listeners, and starts the payment poller (`iniciarPollerPagos()`). On reconnect it re-registers listeners without creating new pollers.

### Message Handler: `messageHandler.ts`
The core of the bot (~1100 lines). All incoming messages go through `_handleMessage()`. Key concepts:

- **User state machine**: Each phone number has a state (e.g., `'esperando_nombre'`, `'menu_planes'`, `'esperando_pago'`) stored in a `Map<string, UserState>`.
- **Message queueing**: `procesandoMensaje` Set prevents concurrent processing per user. `procesoCritico` Set blocks new input during QR generation or account creation (only `"0"` or `"menu"` are accepted).
- **Payment flow**: `enviarQRPago()` calls VeriPagos API to generate a QR, then `iniciarPollerPagos()` polls every 15 seconds (30-minute max) until payment is confirmed, then calls `procesarCuentaNueva()` or `procesarRenovacion()`.
- **Plans**: `PLANES` map defines pricing for 1–3 devices × 1/3/6/12 months. Bonus months (6mo +1, 12mo +2) are hardcoded.
- **Admin commands**: Sent by `ADMIN_NUMBER` (last 8 digits matched) — e.g., `demos on/off`.

### IPTV Panel Automation: `iptvservice.ts`
Uses Puppeteer with a persistent browser profile at `./panel-profile/` to interact with the reseller panel at `resellermastv.com:8443`. Key functions:
- `crearUsuarioIPTV()` — creates account with 3 retry attempts
- `buscarUsuarioIPTV()` — searches and returns full account details including plan and expiry
- `renovarUsuarioIPTV()` — extends an existing account

The browser instance is kept alive between calls (singleton pattern).

### Database: Prisma + SQLite
Schema has two models:
- **User** — stores IPTV credentials, plan, phone, and `expiresAt`
- **Config** — key-value feature flags (e.g., `demos_enabled`)

The Prisma client uses `better-sqlite3` adapter (sync SQLite). Client singleton is in `lib/prisma.ts`.

## Configuration

**`.env`** (required):
```
DATABASE_URL="file:./dev.db"
```

**Embedded in `messageHandler.ts`** (VeriPagos credentials and admin phone number — do not move to `.env` without updating references).

**Auto-generated directories** (gitignored or created at runtime):
- `auth/` — WhatsApp Web session; deleting this forces re-QR-scan
- `panel-profile/` — Puppeteer browser session for the IPTV panel
- `generated/prisma/` — Prisma client output (regenerate with `prisma generate`)

## TypeScript

`tsconfig.json` targets ES2023 with `moduleResolution: bundler` and strict mode. The project uses ES module syntax (`import`/`export`). Run with `tsx` (not `ts-node`).
