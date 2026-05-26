import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  WASocket,
  ConnectionState,
} from '@whiskeysockets/baileys'
// @ts-ignore
import QRCode from 'qrcode-terminal'
import qrcode from 'qrcode'
import pino from 'pino'
import fs from 'fs'
import { prisma } from './lib/prisma.js'
import { handleMessage, iniciarPollerPagos, iniciarPollerExpiraciones, iniciarPollerActivacionesPendientes, setSock } from './messageHandler.js'
import { iniciarTelegramAdmin, detenerTelegramAdmin, setResetSessionCallback, notifyQrCode, notifyBotConectado } from './telegramAdmin.js'

const NOISE_PATTERNS = [
  'Decrypted message with closed session',
  'Closing session:',
  'Session error',
  'Bad MAC',
  'SessionEntry',
  'pubKey: <Buffer',
  'privKey: <Buffer',
  'rootKey: <Buffer',
  'baseKey: <Buffer',
  'remoteIdentityKey: <Buffer',
  'lastRemoteEphemeralKey: <Buffer',
  'ephemeralKeyPair',
  'currentRatchet',
  'indexInfo',
  'pendingPreKey',
  '_chains',
  'chainKey',
  'previousCounter',
  'registrationId',
]

function isNoise(...args: any[]): boolean {
  const combined = args.map(a => (typeof a === 'string' ? a : JSON.stringify(a) ?? '')).join(' ')
  return NOISE_PATTERNS.some(p => combined.includes(p))
}

const _origLog = console.log.bind(console)
console.log = (...args: any[]) => { if (!isNoise(...args)) _origLog(...args) }

const _origError = console.error.bind(console)
console.error = (...args: any[]) => { if (!isNoise(...args)) _origError(...args) }

const _origWarn = console.warn.bind(console)
console.warn = (...args: any[]) => { if (!isNoise(...args)) _origWarn(...args) }

let currentSock: WASocket | null = null

async function resetSession(): Promise<void> {
  console.log('🔄 Reiniciando sesión de WhatsApp...')
  try {
    if (currentSock) {
      currentSock.ev.removeAllListeners()
      ;(currentSock.ws as any).close()
      currentSock = null
    }
  } catch {}
  if (fs.existsSync('./auth')) {
    fs.rmSync('./auth', { recursive: true, force: true })
    console.log('🗑️ Carpeta auth eliminada')
  }
  setTimeout(() => startBot(), 1000)
}

async function startBot(): Promise<void> {
  const { state, saveCreds } = await useMultiFileAuthState('auth')
  const { version } = await fetchLatestBaileysVersion()

  const sock: WASocket = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    version,
    connectTimeoutMs: 60000,
  })

  currentSock = sock
  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async (update: Partial<ConnectionState>) => {
    const { qr, connection, lastDisconnect } = update

    if (qr) {
      console.log('📲 Escanea el QR')
      QRCode.generate(qr, { small: true })
      try {
        const buffer = await qrcode.toBuffer(qr, { type: 'png', scale: 6 })
        await notifyQrCode(buffer)
      } catch (e: any) {
        console.error('⚠️ No se pudo enviar QR a Telegram:', e.message)
      }
    }

    if (connection === 'close') {
      const shouldReconnect =
        (lastDisconnect?.error as any)?.output?.statusCode !== DisconnectReason.loggedOut

      console.log('🔌 Conexión cerrada. Reconectando:', shouldReconnect)

      if (shouldReconnect) {
        setTimeout(() => startBot(), 3000)
      } else {
        console.log('❌ Sesión cerrada. Elimina la carpeta "auth" y vuelve a escanear QR')
      }
    }

    if (connection === 'open') {
      console.log('🤖 Bot MasTV conectado correctamente')
      setSock(sock)
      const numero = sock.user?.id?.split(':')[0]?.split('@')[0] ?? 'desconocido'
      await notifyBotConectado(numero)
    }
  })

  // 📩 ESCUCHAR MENSAJES
  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0]
    await handleMessage(sock, msg)
  })

  // Cerrar todo al terminar
  process.on('SIGINT', async () => {
    console.log('👋 Cerrando bot...')
    detenerTelegramAdmin()
    await prisma.$disconnect()
    process.exit(0)
  })
}

// ← iniciar los pollers y el admin de Telegram UNA sola vez
iniciarPollerPagos()
iniciarPollerExpiraciones().catch(console.error)
iniciarPollerActivacionesPendientes().catch(console.error)
iniciarTelegramAdmin()
setResetSessionCallback(resetSession)

startBot().catch(console.error)

//este arvchivo es boti.ts
