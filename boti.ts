import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  WASocket,
  ConnectionState,
  Browsers,
} from '@whiskeysockets/baileys'
// @ts-ignore
import QRCode from 'qrcode-terminal'
import qrcode from 'qrcode'
import pino from 'pino'
import fs from 'fs'
import { prisma } from './lib/prisma.js'
import { handleMessage, iniciarPollerPagos, iniciarPollerExpiraciones, iniciarPollerActivacionesPendientes, setSock } from './messageHandler.js'
import { iniciarTelegramAdmin, detenerTelegramAdmin, setResetSessionCallback, setIniciarWACallback, setCancelarWACallback, setWAStatus, notifyQrCode, notifyBotConectado, notifyWAEsperando } from './telegramAdmin.js'

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
let disconnectedAt: number | null = null
let reconnectAttempts = 0
let cancelandoConexion = false
const NOTIF_UMBRAL_MS = 5 * 60 * 1000 // 5 minutos

async function cancelarConexionWA(): Promise<void> {
  cancelandoConexion = true
  console.log('🛑 Conexión WhatsApp cancelada por el admin')
  if (currentSock) {
    try { (currentSock.ev as any).removeAllListeners() } catch {}
    try { (currentSock.ws as any).terminate() } catch {}
    try { (currentSock.ws as any).close() } catch {}
    currentSock = null
  }
  setWAStatus('desconectado')
  setTimeout(() => { cancelandoConexion = false }, 3000)
}

async function resetSession(): Promise<void> {
  console.log('🔄 Reiniciando sesión de WhatsApp...')
  try {
    if (currentSock) {
      ;(currentSock.ev as any).removeAllListeners()
      try { (currentSock.ws as any).terminate() } catch {}
      try { (currentSock.ws as any).close() } catch {}
      currentSock = null
    }
  } catch {}

  // Esperar a que el sistema operativo libere los archivos
  await new Promise(r => setTimeout(r, 2000))

  // Borrar archivos dentro de auth/ sin tocar el directorio (es volumen Docker)
  try {
    if (fs.existsSync('./auth')) {
      for (const file of fs.readdirSync('./auth')) {
        try { fs.rmSync(`./auth/${file}`, { recursive: true, force: true }) } catch {}
      }
      console.log('🗑️ Archivos de sesión eliminados')
    }
  } catch (e: any) {
    console.error('❌ No se pudo limpiar auth:', e.message)
  }

  setTimeout(() => startBot(), 1000)
}

async function startBot(): Promise<void> {
  setWAStatus('conectando')
  const { state, saveCreds } = await useMultiFileAuthState('auth')
  const { version } = await fetchLatestBaileysVersion()

  const sock: WASocket = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    version,
    connectTimeoutMs: 60000,
    markOnlineOnConnect: false,
    syncFullHistory: false,
    browser: Browsers.ubuntu('Chrome'),
    keepAliveIntervalMs: 30000,
    retryRequestDelayMs: 2000,
    generateHighQualityLinkPreview: false,
    getMessage: async () => ({ conversation: '' }),
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

      if (cancelandoConexion) {
        console.log('🛑 Reconexión omitida — cancelado por el admin')
        return
      }

      if (shouldReconnect) {
        setWAStatus('conectando')
        disconnectedAt = Date.now()
        const delay = Math.min(30000, 3000 * Math.pow(2, reconnectAttempts))
        reconnectAttempts++
        console.log(`🔄 Reconectando en ${Math.round(delay / 1000)}s (intento ${reconnectAttempts})`)
        setTimeout(() => startBot(), delay)
      } else {
        setWAStatus('desconectado')
        console.log('❌ Sesión cerrada. Usa Telegram para vincular un número nuevo.')
      }
    }

    if (connection === 'open') {
      console.log('🤖 Bot MasTV conectado correctamente')
      reconnectAttempts = 0
      setSock(sock)
      const numero = sock.user?.id?.split(':')[0]?.split('@')[0] ?? 'desconocido'
      const primeraConexion = disconnectedAt === null
      const caídaLarga = disconnectedAt !== null && (Date.now() - disconnectedAt) > NOTIF_UMBRAL_MS
      disconnectedAt = null
      if (primeraConexion || caídaLarga) {
        await notifyBotConectado(numero)
      }
    }
  })

  // 📩 ESCUCHAR MENSAJES
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return
    const msg = messages[0]
    if (!msg) return
    if (msg.key.fromMe) return
    if (msg.key.remoteJid === 'status@broadcast') return
    if (msg.key.remoteJid?.endsWith('@g.us')) return
    // Marcar como leído (simula comportamiento humano)
    try { await sock.readMessages([msg.key]) } catch {}
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
setIniciarWACallback(() => startBot().catch(console.error))
setCancelarWACallback(cancelarConexionWA)

// Si ya hay sesión guardada → conectar automáticamente
// Si no hay sesión → esperar botón "Conectar WhatsApp" en Telegram
const authExiste = fs.existsSync('./auth') &&
  fs.readdirSync('./auth').filter((f: string) => !f.startsWith('.')).length > 0

if (authExiste) {
  startBot().catch(console.error)
} else {
  console.log('⚠️ No hay sesión de WhatsApp. Usa Telegram para vincular un número.')
  setTimeout(() => notifyWAEsperando().catch(console.error), 10000)
}
