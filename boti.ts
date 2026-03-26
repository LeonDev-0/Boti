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
import { handleMessage, iniciarPollerPagos, setSock } from './messageHandler.js'

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

  // Cerrar Prisma al terminar
  process.on('SIGINT', async () => {
    console.log('👋 Cerrando bot...')
    await prisma.$disconnect()
    process.exit(0)
  })
}

// ← iniciar el poller UNA sola vez antes de conectar
iniciarPollerPagos()

startBot().catch(console.error)

//este arvchivo es boti.ts