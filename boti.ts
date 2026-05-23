import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  WASocket,
  ConnectionState,
} from '@whiskeysockets/baileys'
import QRCode from 'qrcode-terminal'
import pino from 'pino'
import { prisma } from './lib/prisma.js'
import { handleMessage, iniciarPollerPagos, iniciarPollerExpiraciones, iniciarPollerActivacionesPendientes, setSock } from './messageHandler.js'
import { iniciarTelegramAdmin, detenerTelegramAdmin } from './telegramAdmin.js'

const _origLog = console.log.bind(console)
console.log = (...args: any[]) => {
  const msg = args[0]?.toString() ?? ''
  if (msg.includes('Decrypted message with closed session') || msg.includes('Closing session:')) return
  _origLog(...args)
}

const _origError = console.error.bind(console)
console.error = (...args: any[]) => {
  const msg = args[0]?.toString() ?? ''
  if (msg.includes('Bad MAC') || msg.includes('Session error')) return
  _origError(...args)
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

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async (update: Partial<ConnectionState>) => {
    const { qr, connection, lastDisconnect } = update

    if (qr) {
      console.log('📲 Escanea el QR')
      QRCode.generate(qr, { small: true })
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
      setSock(sock) // ← actualizar referencia del socket en cada reconexión
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

startBot().catch(console.error)

//este arvchivo es boti.ts