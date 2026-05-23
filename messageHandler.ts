import { WASocket, downloadMediaMessage } from '@whiskeysockets/baileys'
import { prisma } from './lib/prisma.js'
import { crearUsuarioIPTV } from './iptvservice.js'
import https from 'https'

// =============================================
// CONFIGURACION VERIPAGOS
// =============================================
const VERIPAGOS_CONFIG = {
  USER: 'zandrotja',
  PASS: 'H?F1&crEcz',
  SECRET_KEY: 'c93b4584-2292-46c1-a698-6ae8b4a01d83',
}
const VERIPAGOS_AUTH = 'Basic ' + Buffer.from(`${VERIPAGOS_CONFIG.USER}:${VERIPAGOS_CONFIG.PASS}`).toString('base64')
const ADMIN_NUMBER = '64598912'

// =============================================
// ANTI-BAN: wrapper que simula comportamiento humano antes de enviar
// =============================================
async function sendMsg(socket: WASocket, jid: string, content: any): Promise<void> {
  if (content.text) {
    await socket.sendPresenceUpdate('composing', jid)
    await new Promise(r => setTimeout(r, 200))
    await socket.sendPresenceUpdate('paused', jid)
  }
  await socket.sendMessage(jid, content)
}

// =============================================
// COLA DE MENSAJES
// =============================================
const procesandoMensaje = new Set<string>()

// Procesos críticos: mientras están activos se descartan mensajes entrantes
// excepto "0" o "menu" que siempre se permiten para cancelar
const procesoCritico = new Set<string>()

async function encolarMensaje(sock: WASocket, msg: any): Promise<void> {
  const jid = msg.key.remoteJid
  if (!jid) return

  const text: string = (
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    ''
  ).trim().toLowerCase()

  // Si hay un proceso crítico activo para este jid, descartar silenciosamente
  // excepto si el usuario escribe 0 o menu (para cancelar/volver)
  if (procesoCritico.has(jid)) {
    if (text !== '0' && text !== 'menu') {
      console.log(`🚫 Mensaje descartado (proceso crítico activo) jid=${jid}: "${text}"`)
      return
    }
  }

  // Si ya se está procesando un mensaje, descartar también
  // (no acumular cola durante procesos normales)
  if (procesandoMensaje.has(jid)) {
    console.log(`🚫 Mensaje descartado (procesando) jid=${jid}: "${text}"`)
    return
  }

  await procesarConCola(sock, msg, jid)
}

async function procesarConCola(sock: WASocket, msg: any, jid: string): Promise<void> {
  procesandoMensaje.add(jid)
  try {
    await _handleMessage(sock, msg)
  } finally {
    procesandoMensaje.delete(jid)
  }
}

export async function handleMessage(sock: WASocket, msg: any): Promise<void> {
  await encolarMensaje(sock, msg)
}

// Marcar inicio/fin de proceso crítico (crear cuenta, renovar, generar QR, crear demo)
function iniciarProcesoCritico(jid: string): void {
  procesoCritico.add(jid)
  console.log(`🔒 Proceso crítico iniciado: ${jid}`)
}

function finalizarProcesoCritico(jid: string): void {
  procesoCritico.delete(jid)
  console.log(`🔓 Proceso crítico finalizado: ${jid}`)
}

// =============================================
// ESTADOS DEL USUARIO
// =============================================
export const userStates = new Map<string, string>()
const lastActivity = new Map<string, number>()
const SESSION_TIMEOUT_MS = 15 * 60 * 1000 // 15 minutos

// ── Números con bot pausado por el admin ───────────────────
const numerosPausados = new Set<string>()
let pausadosCargados = false

async function cargarPausados(): Promise<void> {
  if (pausadosCargados) return
  pausadosCargados = true
  const cfg = await prisma.config.findUnique({ where: { key: 'numeros_pausados' } })
  if (cfg) {
    try {
      const arr: string[] = JSON.parse(cfg.value)
      arr.forEach(n => numerosPausados.add(n))
    } catch {}
  }
}

async function guardarPausados(): Promise<void> {
  const arr = Array.from(numerosPausados)
  await prisma.config.upsert({
    where: { key: 'numeros_pausados' },
    update: { value: JSON.stringify(arr) },
    create: { key: 'numeros_pausados', value: JSON.stringify(arr) },
  })
}

// =============================================
// PAGOS PENDIENTES
// =============================================
interface PagoPendiente {
  jid: string
  phoneNumber: string
  tipo: 'nueva' | 'renovacion'
  precio: string
  nombre: string
  usuarioIPTV?: string
  existingUserId?: number
  intentos: number
  fallos: number
  movimiento_id: string
  qrBase64: string
  generadoEn: number
  vigenciaMs: number
  lastChecked: number
}

const pagosPendientes = new Map<string, PagoPendiente>()
const QR_VIGENCIA_MS = 30 * 60 * 1000

// ── Pagos manuales pendientes ──────────────────────────────
interface PagoManual {
  jid: string
  phoneNumber: string
  nombre: string
  comprobanteRecibido?: boolean
  precio: string
  tipo: 'nueva' | 'renovacion'
  usuarioIPTV?: string
  existingUserId?: number
  timestamp: number
}
const pagosManualPendientes = new Map<string, PagoManual>()

// ── Preferencia de canales adultos ─────────────────────────
const adultosPreferencia = new Map<string, boolean>()
const pendingNombreParaAdultos = new Map<string, { nombre: string; precio: string }>()
const pendingNombreDemo = new Map<string, string>()

const TEXTO_PREGUNTA_ADULTOS =
  `🔞 *¿Deseas incluir canales para adultos (+18)?*\n\n` +
  `1️⃣ Sí, incluir contenido adulto\n` +
  `2️⃣ No, sin contenido adulto\n\n` +
  `0️⃣ Volver al menú`

// ── Callback para notificar al admin de Telegram ───────────
type AdminNotifyFn = (text: string, phoneNumber?: string, mediaBuffer?: Buffer) => Promise<void>
let adminNotifyCallback: AdminNotifyFn | null = null
export function setAdminNotifyCallback(fn: AdminNotifyFn): void {
  adminNotifyCallback = fn
}

let sockGlobal: WASocket | null = null

// =============================================
// FALLBACK AUTOMÁTICO VERIPAGOS
// =============================================
let veripagosFailCount = 0
const VERIPAGOS_MAX_FALLOS = 3

async function autoDisableVeripagos(razon: string): Promise<void> {
  try {
    await prisma.config.upsert({
      where: { key: 'veripagos_enabled' },
      update: { value: 'false' },
      create: { key: 'veripagos_enabled', value: 'false' },
    })
    veripagosFailCount = 0
    console.warn(`⚠️ VeriPagos AUTO-DESHABILITADO: ${razon}`)
    if (adminNotifyCallback) {
      await adminNotifyCallback(
        `🔴 *VERIPAGOS DESHABILITADO AUTOMÁTICAMENTE*\n\n` +
        `Motivo: ${razon}\n\n` +
        `El bot cambiará a pago manual hasta que reactives VeriPagos con el comando:\n` +
        `*veripagos on*`
      )
    }
  } catch (e: any) {
    console.error('Error al auto-deshabilitar VeriPagos:', e.message)
  }
}

// =============================================
// API VERIPAGOS
// =============================================
function apiPost(path: string, body: object): Promise<any> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body)
    const req = https.request({
      hostname: 'veripagos.com',
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': VERIPAGOS_AUTH,
        'Content-Length': Buffer.byteLength(data),
      },
    }, (res) => {
      let raw = ''
      res.on('data', (c: string) => raw += c)
      res.on('end', () => {
        try { resolve(JSON.parse(raw)) }
        catch (e) { reject(new Error('Respuesta invalida: ' + raw)) }
      })
    })
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')) })
    req.on('error', reject)
    req.write(data)
    req.end()
  })
}

async function generarQR(monto: number): Promise<{ movimiento_id: number, qr: string } | null> {
  try {
    const res = await apiPost('/api/bcp/generar-qr', {
      secret_key: VERIPAGOS_CONFIG.SECRET_KEY,
      monto,
      uso_unico: true,
      vigencia: '0/00:30',
      detalle: `Pago Servicio`,
    })
    if (res.Codigo === 0) {
      veripagosFailCount = 0
      return res.Data
    }
    console.error('Error generando QR:', res.Mensaje)
    veripagosFailCount++
    if (veripagosFailCount >= VERIPAGOS_MAX_FALLOS) {
      await autoDisableVeripagos(`${veripagosFailCount} fallos consecutivos al generar QR (último: ${res.Mensaje})`)
    }
    return null
  } catch (e: any) {
    console.error('Error generando QR:', e.message)
    veripagosFailCount++
    if (veripagosFailCount >= VERIPAGOS_MAX_FALLOS) {
      await autoDisableVeripagos(`${veripagosFailCount} fallos consecutivos al generar QR (${e.message})`)
    }
    return null
  }
}

async function verificarEstadoQR(movimiento_id: number): Promise<string | null> {
  try {
    const res = await apiPost('/api/bcp/verificar-estado-qr', {
      secret_key: VERIPAGOS_CONFIG.SECRET_KEY,
      movimiento_id: String(movimiento_id),
    })
    if (res.Codigo === 0) return res.Data?.estado || null
    return null
  } catch (e: any) {
    console.error('Error verificando QR:', e.message)
    return null
  }
}

// =============================================
// HELPERS QR
// =============================================
function obtenerQRActivo(phoneNumber: string): [string, PagoPendiente] | null {
  const ahora = Date.now()
  for (const [mov_id, pago] of pagosPendientes.entries()) {
    if (pago.phoneNumber === phoneNumber) {
      if (pago.vigenciaMs - (ahora - pago.generadoEn) > 0) return [mov_id, pago]
      pagosPendientes.delete(mov_id)
    }
  }
  return null
}

function cancelarQRDelUsuario(phoneNumber: string): void {
  for (const [mov_id, pago] of pagosPendientes.entries()) {
    if (pago.phoneNumber === phoneNumber) {
      pagosPendientes.delete(mov_id)
      console.log(`🗑️ QR ${mov_id} cancelado para ${phoneNumber}`)
    }
  }
}

function formatarTiempoRestante(ms: number): string {
  const totalSeg = Math.floor(ms / 1000)
  const min = Math.floor(totalSeg / 60)
  const seg = totalSeg % 60
  if (min > 0 && seg > 0) return `${min} min ${seg} seg`
  if (min > 0) return `${min} min`
  return `${seg} seg`
}

// =============================================
// =============================================
// HELPER: FECHA CORTA con mes abreviado
// =============================================
const MESES_CORTOS = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic']
function fechaCorta(d: Date): string {
  return `${d.getUTCDate()}/${MESES_CORTOS[d.getUTCMonth()]}/${d.getUTCFullYear()}`
}

// =============================================
// DETECTAR PRECIO A PARTIR DEL PAQUETE/CONEXIONES
// Lee duración Y dispositivos desde el texto del paquete del panel
// Ejemplos de paquetes que llegan:
//   "1 MES - 1 DISP"
//   "3 MESES - 2 DISP"
//   "6 MESES (+1 MES GRATIS) - 1 DISP"
//   "1 AÑO (+2 MESES GRATIS) - 3 DISP"
// =============================================
function buscarPrecioDesdeNombrePlan(planNombre: string): string | null {
  for (const [precio, p] of Object.entries(PLANES_MAP)) {
    const label = `${p.dispositivos} Dispositivo${p.dispositivos > 1 ? 's' : ''} – ${p.duracion}`
    if (planNombre.startsWith(label)) return precio
  }
  return null
}

function detectarPrecioDesdePanel(paquete: string, conexiones: any): string {
  const pkg = (paquete || '').toUpperCase()
  const numConexiones = parseInt(String(conexiones), 10) || 1

  // --- Detectar dispositivos ---
  const matchDisp = pkg.match(/[\-–]\s*(\d+)\s*DISP/)
  const dispositivos = matchDisp ? parseInt(matchDisp[1], 10) : numConexiones

  // --- Detectar duración ---
  let duracionKey: '1mes' | '3meses' | '6meses' | '12meses' = '1mes'

  if (pkg.includes('AÑO') || pkg.includes('ANO') || pkg.includes('12 MES')) {
    duracionKey = '12meses'
  } else if (pkg.match(/6\s*MESES?/)) {
    duracionKey = '6meses'
  } else if (pkg.match(/3\s*MESES?/)) {
    duracionKey = '3meses'
  } else {
    // "1 MES" o cualquier otro caso
    duracionKey = '1mes'
  }

  console.log(`🔍 Paquete: "${paquete}" | Conexiones: ${conexiones} | Disp detectados: ${dispositivos} | Duración: ${duracionKey}`)

  // --- Tabla dispositivos × duración → precio ---
  const tabla: Record<string, Record<string, string>> = {
    '1': { '1mes': '29',  '3meses': '82',  '6meses': '155', '12meses': '300' },
    '2': { '1mes': '35',  '3meses': '100', '6meses': '190', '12meses': '380' },
    '3': { '1mes': '40',  '3meses': '115', '6meses': '225', '12meses': '440' },
  }

  const dispKey = dispositivos >= 3 ? '3' : dispositivos === 2 ? '2' : '1'
  return tabla[dispKey][duracionKey]
}

// =============================================
// POLLER GLOBAL
// =============================================
export function iniciarPollerPagos(): void {
  // Intervalo base 5s — la frecuencia real de cada pago se decide adentro (adaptativa)
  setInterval(async () => {
    if (pagosPendientes.size === 0 || !sockGlobal) return

    const ahora = Date.now()

    const verificaciones = Array.from(pagosPendientes.entries()).map(async ([movimiento_id, pago]) => {
      const elapsed = ahora - pago.generadoEn

      // Expiró los 30 minutos
      if (elapsed >= QR_VIGENCIA_MS) {
        pagosPendientes.delete(movimiento_id)
        userStates.delete(pago.phoneNumber)
        await enviar(pago.jid, `⏰ *EL QR DE PAGO EXPIRÓ*\n\nEl tiempo de pago finalizó y el QR ya no está disponible.\n\n💳 Para generar un nuevo QR, vuelve a escribir el precio de tu plan.\n\n0️⃣ Volver al menú`)
        return
      }

      // Frecuencia adaptativa según tiempo transcurrido
      const intervaloRequerido =
        elapsed < 2 * 60 * 1000  ? 5_000  :   // primeros 2 min → cada 5s
        elapsed < 10 * 60 * 1000 ? 15_000 :   // 2-10 min       → cada 15s
                                   30_000      // 10-30 min      → cada 30s

      if (ahora - pago.lastChecked < intervaloRequerido) return

      pago.lastChecked = ahora
      pago.intentos++

      try {
        const estado = await verificarEstadoQR(parseInt(movimiento_id))
        pago.fallos = 0

        if (estado === 'Completado') {
          pagosPendientes.delete(movimiento_id)
          // Cancelar cualquier otro QR pendiente del mismo número
          for (const [mid, p] of pagosPendientes.entries()) {
            if (p.phoneNumber === pago.phoneNumber) pagosPendientes.delete(mid)
          }
          userStates.delete(pago.phoneNumber)

          await enviar(pago.jid,
            `✅ *PAGO RECIBIDO*\n\n` +
            `Tu pago fue confirmado correctamente.\n\n` +
            `⏳ Estamos procesando tu cuenta, por favor espera un momento...`
          )

          if (pago.tipo === 'nueva') {
            await procesarCuentaNueva(pago.jid, pago.phoneNumber, pago.precio, pago.nombre, pago.existingUserId)
          } else {
            await procesarRenovacion(pago.jid, pago.phoneNumber, pago.precio, pago.usuarioIPTV!, pago.existingUserId!)
          }
        }
      } catch (e: any) {
        pago.fallos = (pago.fallos || 0) + 1
        console.error(`Error verificando movimiento ${movimiento_id} (fallo ${pago.fallos}):`, e.message)
        if (pago.fallos >= 5) {
          await autoDisableVeripagos(`5 fallos consecutivos verificando QR ${movimiento_id} (${e.message})`)
        }
      }
    })

    await Promise.allSettled(verificaciones)
  }, 5_000)
}

// =============================================
// POLLER DE ACTIVACIÓN DE CUENTA
// =============================================
const activationPollers = new Map<string, ReturnType<typeof setInterval>>()

function iniciarPollerActivacion(usuario: string, dbUserId: number): void {
  if (activationPollers.has(usuario)) return

  console.log(`👀 Poller activación iniciado para: ${usuario}`)

  let noEncontradoCount = 0
  const MAX_NO_ENCONTRADO = 3

  const intervalo = setInterval(async () => {
    try {
      const { buscarUsuarioIPTV } = await import('./iptvservice.js')
      const data = await buscarUsuarioIPTV(usuario)
      noEncontradoCount = 0
      const expira = data.expira?.trim() ?? ''
      console.log(`🔎 Poller (${usuario}) — expira en panel: "${expira}"`)

      const matchFecha = expira.match(/(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/)
      if (matchFecha && !expira.startsWith('+')) {
        const fechaReal = new Date(`${matchFecha[1]}T${matchFecha[2]}:00Z`)
        if (!isNaN(fechaReal.getTime())) {
          const precioActual = detectarPrecioDesdePanel(data.paquete, data.conexiones)
          const planActual = PLANES_MAP[precioActual]
          const planCompleto = planActual
            ? (planActual.bonus
                ? `${planActual.dispositivos} Dispositivo${planActual.dispositivos > 1 ? 's' : ''} – ${planActual.duracion} ${planActual.bonus}`
                : `${planActual.dispositivos} Dispositivo${planActual.dispositivos > 1 ? 's' : ''} – ${planActual.duracion}`)
            : undefined
          const updated = await prisma.user.update({
            where: { id: dbUserId },
            data: {
              expiresAt: fechaReal,
              activated: true,
              ...(data.password && { password: data.password }),
              ...(planCompleto  && { plan: planCompleto }),
            }
          })
          console.log(`✅ Cuenta ${usuario} ACTIVADA — Fecha: ${fechaReal.toISOString()} | Plan: ${planCompleto ?? 'sin cambio'} | Pass: ${data.password ? 'actualizado' : 'sin cambio'}`)
          programarRecordatorio({ ...updated, expiresAt: fechaReal })
          clearInterval(intervalo)
          activationPollers.delete(usuario)
        }
      } else {
        console.log(`⏳ Cuenta ${usuario} aún no activada — Expira: "${expira}"`)
      }
    } catch (e: any) {
      const msg = (e.message ?? '').toLowerCase()
      const esNoEncontrado = msg.includes('no se encontró') || msg.includes('no se encontro')

      if (esNoEncontrado) {
        noEncontradoCount++
        console.warn(`⚠️ Poller (${usuario}) — no encontrada en panel (${noEncontradoCount}/${MAX_NO_ENCONTRADO})`)
        if (noEncontradoCount >= MAX_NO_ENCONTRADO) {
          clearInterval(intervalo)
          activationPollers.delete(usuario)
          console.warn(`🗑️ Cuenta ${usuario} eliminada de DB tras ${MAX_NO_ENCONTRADO} intentos fallidos`)
          try { await prisma.user.delete({ where: { id: dbUserId } }) } catch {}
        }
      } else {
        console.error(`❌ Error en poller activación (${usuario}):`, e.message)
      }
    }
  }, 2 * 60 * 1000)

  activationPollers.set(usuario, intervalo)
}

export async function iniciarPollerActivacionesPendientes(): Promise<void> {
  const pendientes = await prisma.user.findMany({
    where: {
      activated: false,
      NOT: { plan: { in: ['DEMO 3 HORA', 'DEMO EXPIRADA'] } }
    }
  })
  let count = 0
  for (const u of pendientes) {
    if (!activationPollers.has(u.usuario)) {
      iniciarPollerActivacion(u.usuario, u.id)
      count++
    }
  }
  console.log(`👀 ${count} poller(s) de activación recuperados al arrancar`)
}

// =============================================
// RECORDATORIOS DE EXPIRACIÓN (setTimeout exacto)
// =============================================
const reminderTimers = new Map<number, ReturnType<typeof setTimeout>>()

async function enviarRecordatorio(user: { id: number; usuario: string; celular: string; expiresAt: Date | null; reminderSent: boolean }): Promise<void> {
  if (!sockGlobal) return
  reminderTimers.delete(user.id)

  try {
    // Verificar fecha real en el panel antes de enviar
    let fechaPanel: Date | null = null
    try {
      const { buscarUsuarioIPTV } = await import('./iptvservice.js')
      const panelData = await buscarUsuarioIPTV(user.usuario)
      const match = panelData.expira?.match(/(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/)
      if (match) fechaPanel = new Date(`${match[1]}T${match[2]}:00Z`)
    } catch {
      console.warn(`⚠️ No se pudo verificar panel para ${user.usuario}, se usará fecha de DB`)
    }

    if (fechaPanel && !isNaN(fechaPanel.getTime())) {
      const diffMs = Math.abs(fechaPanel.getTime() - (user.expiresAt?.getTime() ?? 0))
      const diffHoras = diffMs / 3600000

      if (diffHoras > 1) {
        // La fecha cambió (admin la modificó) — actualizar DB y reprogramar
        console.log(`🔄 Fecha cambiada en panel para ${user.usuario}: ${fechaPanel.toISOString()} (era ${user.expiresAt?.toISOString()})`)
        const updated = await prisma.user.update({ where: { id: user.id }, data: { expiresAt: fechaPanel, reminderSent: false } })
        programarRecordatorio({ ...updated, expiresAt: fechaPanel })
        return
      }
      // Fecha coincide — sincronizar de todas formas para mantener DB alineada con panel
      await prisma.user.update({ where: { id: user.id }, data: { expiresAt: fechaPanel } }).catch(() => {})
    }

    // Fecha correcta — enviar recordatorio
    const fechaExp = (fechaPanel ?? user.expiresAt) ? fechaCorta(new Date((fechaPanel ?? user.expiresAt)!)) : '-'
    const jid = celularAJid(user.celular)
    const dbUser = await prisma.user.findUnique({ where: { id: user.id } })
    const precioRenovacion = dbUser?.plan ? buscarPrecioDesdeNombrePlan(dbUser.plan) : null
    const planInfo = precioRenovacion ? PLANES_MAP[precioRenovacion] : null
    const planLineas = planInfo
      ? `📦 Plan: *${planInfo.duracion}${planInfo.bonus ? ' ' + planInfo.bonus : ''}*\n📺 Dispositivos: *${planInfo.dispositivos}*\n💰 Renovación: *Bs. ${planInfo.precio}*\n`
      : ''

    const textoRecordatorio =
      `⏰ *TU CUENTA VENCE EN 24 HORAS*\n\n` +
      `┌───────────────\n` +
      `👤 Usuario: *${user.usuario}*\n` +
      `🔐 Contraseña: *${dbUser?.password || '-'}*\n` +
      `└───────────────\n\n` +
      `📅 Expira: *${fechaExp}*\n` +
      `${planLineas}\n` +
      `━━━━━━━━━━━━━━━━━━\n\n` +
      `Para renovar escribe *5️⃣*\n\n` +
      `0️⃣ Menú principal`
    await sockGlobal.sendMessage(jid, { text: textoRecordatorio })
    await prisma.user.update({ where: { id: user.id }, data: { reminderSent: true } })
    console.log(`📨 Recordatorio enviado a ${user.celular} (usuario: ${user.usuario})`)
  } catch (e: any) {
    console.error(`Error en recordatorio de ${user.celular}:`, e.message)
  }
}

export function programarRecordatorio(user: { id: number; usuario: string; celular: string; expiresAt: Date | null; reminderSent: boolean }): void {
  if (!user.expiresAt || user.reminderSent) return

  const ahora = Date.now()
  const disparo = user.expiresAt.getTime() - 24 * 60 * 60 * 1000
  const delay = disparo - ahora

  if (reminderTimers.has(user.id)) clearTimeout(reminderTimers.get(user.id)!)

  if (delay <= 0) {
    // Ya pasó el momento de avisar — enviar de inmediato
    enviarRecordatorio(user)
    return
  }

  // Node.js setTimeout max es 2^31-1 ms (~24.8 días). Para delays mayores, re-programa en tramos.
  const MAX_TIMEOUT_MS = 2147483647
  if (delay > MAX_TIMEOUT_MS) {
    const timer = setTimeout(() => programarRecordatorio(user), MAX_TIMEOUT_MS)
    reminderTimers.set(user.id, timer)
    console.log(`⏰ Recordatorio pre-programado (tramo largo): ${user.usuario} en ${Math.round(delay / 3600000)}h`)
    return
  }

  const timer = setTimeout(() => enviarRecordatorio(user), delay)
  reminderTimers.set(user.id, timer)
  console.log(`⏰ Recordatorio programado: ${user.usuario} en ${Math.round(delay / 3600000)}h`)
}

export async function iniciarPollerExpiraciones(): Promise<void> {
  const pendientes = await prisma.user.findMany({
    where: { plan: { not: 'DEMO 3 HORA' }, reminderSent: false, expiresAt: { not: null, gt: new Date() } }
  })
  for (const u of pendientes) programarRecordatorio(u)
  console.log(`⏰ ${pendientes.length} recordatorio(s) programado(s) al iniciar`)
}

async function enviar(jid: string, text: string): Promise<void> {
  if (!sockGlobal) return
  try { await sockGlobal.sendMessage(jid, { text }) }
  catch (e: any) { console.error('Error enviando mensaje:', e.message) }
}

export function setSock(sock: WASocket): void {
  sockGlobal = sock
}

// =============================================
// GENERAR Y ENVIAR QR AL CLIENTE
// =============================================
async function enviarQRPago(
  sock: WASocket,
  from: string,
  phoneNumber: string,
  monto: number,
  tipo: 'nueva' | 'renovacion',
  precio: string,
  nombre: string,
  usuarioIPTV?: string,
  existingUserId?: number,
): Promise<void> {
  // ── Modo pago manual (VeriPagos deshabilitado) ──────────────
  const veripagosOn = await isVeripagosEnabled()
  if (!veripagosOn) {
    const { readFileSync } = await import('fs')
    const planInfo = PLANES_MAP[precio]
    const tituloManual = tipo === 'renovacion' && usuarioIPTV ? `💳 *RENOVACIÓN - ${usuarioIPTV}*` : `💳 *NUEVA CUENTA*`
    const cuerpoManual =
      `\n\n📦 Plan: *${planInfo?.duracion}*\n` +
      `📺 Dispositivos: *${planInfo?.dispositivos}*\n` +
      `💰 Total: *Bs. ${monto.toFixed(2)}*\n\n` +
      `✅ Enviá tu comprobante para confirmar el pago.\n\n` +
      `0️⃣ Volver al menú`
    try {
      const imgBuffer = readFileSync('./recursos/qr.jpg')
      await sendMsg(sock, from, { image: imgBuffer, caption: tituloManual + cuerpoManual })
    } catch {
      await sendMsg(sock, from, { text: tituloManual + cuerpoManual })
    }
    pagosManualPendientes.set(phoneNumber, {
      jid: from,
      phoneNumber,
      nombre,
      precio,
      tipo,
      usuarioIPTV,
      existingUserId,
      timestamp: Date.now(),
    })
    userStates.set(phoneNumber, 'esperando_comprobante')
    return
  }

  const qrActivo = obtenerQRActivo(phoneNumber)

  if (qrActivo) {
    const [mov_id, pagoPrevio] = qrActivo
    const restanteMs = pagoPrevio.vigenciaMs - (Date.now() - pagoPrevio.generadoEn)

    if (pagoPrevio.precio === precio) {
      console.log(`♻️ Reenviando QR ${mov_id} a ${phoneNumber} (${formatarTiempoRestante(restanteMs)} restantes)`)
      const tituloActivo = pagoPrevio.tipo === 'renovacion' && pagoPrevio.usuarioIPTV ? `💳 *RENOVACIÓN - ${pagoPrevio.usuarioIPTV}*` : `💳 *NUEVA CUENTA*`
      await sendMsg(sock, from, {
        image: Buffer.from(pagoPrevio.qrBase64, 'base64'),
        caption:
          `${tituloActivo}\n\n` +
          `📦 Plan: *${PLANES_MAP[precio]?.duracion}*\n` +
          `📺 Dispositivos: *${PLANES_MAP[precio]?.dispositivos}*\n` +
          `💰 Total: *Bs. ${monto.toFixed(2)}*\n\n` +
          `✅ El sistema confirmará tu pago automáticamente.\n` +
          `⏳ Tiempo restante: *${formatarTiempoRestante(restanteMs)}*\n\n` +
          `0️⃣ Volver al menú`
      })
      return
    } else {
      console.log(`🔄 Cambiando plan: cancelando QR ${mov_id} de ${pagoPrevio.precio} → nuevo de ${precio}`)
      cancelarQRDelUsuario(phoneNumber)
      await sendMsg(sock, from, { text: `🔄 *CAMBIO DE PLAN DETECTADO*\n\nGenerando un nuevo QR de pago por:\n\n💳 *Bs. ${monto.toFixed(2)}*\n\nPor favor espera un momento...` })
    }
  } else {
    await sendMsg(sock, from, { text: `⏳ *GENERANDO QR DE PAGO*\n\n💳 Monto: *Bs. ${monto.toFixed(2)}*\n\nPor favor espera un momento...` })
  }

  iniciarProcesoCritico(from)
  let qrData: { movimiento_id: number, qr: string } | null = null
  try {
    qrData = await generarQR(monto)
  } finally {
    finalizarProcesoCritico(from)
  }

  if (!qrData) {
    await sendMsg(sock, from, { text: `⚠️ *NO SE PUDO GENERAR EL QR DE PAGO*\n\nOcurrió un problema temporal al generar el QR.\n\n⏳ Por favor intenta nuevamente más tarde.\n\n📞 Si el problema continúa, contacta soporte:\n64598912\n\n0️⃣ Volver al menú` })
    return
  }

  const { movimiento_id, qr } = qrData
  const generadoEn = Date.now()

  const tituloQR = tipo === 'renovacion' && usuarioIPTV ? `💳 *RENOVACIÓN - ${usuarioIPTV}*` : `💳 *NUEVA CUENTA*`
  await sendMsg(sock, from, {
    image: Buffer.from(qr, 'base64'),
    caption:
      `${tituloQR}\n\n` +
      `📦 Plan: *${PLANES_MAP[precio]?.duracion}*\n` +
      `📺 Dispositivos: *${PLANES_MAP[precio]?.dispositivos}*\n` +
      `💰 Total: *Bs. ${monto.toFixed(2)}*\n\n` +
      `✅ El sistema confirmará tu pago automáticamente.\n` +
      `⏳ QR válido por 30 minutos\n\n` +
      `0️⃣ Volver al menú`
  })

  pagosPendientes.set(String(movimiento_id), {
    jid: from,
    phoneNumber,
    tipo,
    precio,
    nombre,
    usuarioIPTV,
    existingUserId,
    intentos: 0,
    fallos: 0,
    movimiento_id: String(movimiento_id),
    qrBase64: qr,
    generadoEn,
    vigenciaMs: QR_VIGENCIA_MS,
    lastChecked: 0,
  })

  console.log(`💳 QR generado: movimiento ${movimiento_id} | Bs. ${monto} | ${tipo} | ${phoneNumber} | válido 30 min`)
}

// =============================================
// FINANZAS — helpers
// =============================================
async function getPrecioCredito(): Promise<number> {
  const cfg = await prisma.config.findUnique({ where: { key: 'precio_credito' } })
  return cfg ? parseFloat(cfg.value) : 17
}

async function registrarTransaccion(tipo: 'nueva' | 'renovacion', precio: string, phoneNumber: string): Promise<void> {
  const plan = PLANES_MAP[precio]
  if (!plan) return
  const precioCredito = await getPrecioCredito()
  const costo = plan.creditos * precioCredito
  const ganancia = plan.precio - costo
  const planLabel = plan.bonus
    ? `${plan.dispositivos} Disp – ${plan.duracion} ${plan.bonus}`
    : `${plan.dispositivos} Disp – ${plan.duracion}`
  try {
    await (prisma as any).transaccion.create({
      data: { tipo, plan: planLabel, precio: plan.precio, creditos: plan.creditos, costo, ganancia, phoneNumber }
    })
  } catch (e: any) {
    console.error('Error registrando transacción:', e.message)
  }
}

// =============================================
// PROCESAR CUENTA NUEVA
// =============================================
async function procesarCuentaNueva(
  jid: string,
  phoneNumber: string,
  precio: string,
  nombre: string,
  existingUserId?: number,
): Promise<void> {
  const plan = PLANES_MAP[precio]
  iniciarProcesoCritico(jid)
  try {
    let planPuppeteer = ''
    let meses = 0
    if (plan.duracion === '1 Mes') {
      meses = 1
      if (plan.dispositivos === 1) planPuppeteer = '1 MES - 1 DISP'
      else if (plan.dispositivos === 2) planPuppeteer = '1 MES - 2 DISP'
      else if (plan.dispositivos === 3) planPuppeteer = '1 MES - 3 DISP'
    } else if (plan.duracion === '3 Meses') {
      meses = 3
      if (plan.dispositivos === 1) planPuppeteer = '3 MESES - 1 DISP'
      else if (plan.dispositivos === 2) planPuppeteer = '3 MESES - 2 DISP'
      else if (plan.dispositivos === 3) planPuppeteer = '3 MESES - 3 DISP'
    } else if (plan.duracion === '6 Meses') {
      meses = plan.bonus ? 7 : 6
      if (plan.dispositivos === 1) planPuppeteer = '6 MESES (+1 MES GRATIS) - 1 DISP'
      else if (plan.dispositivos === 2) planPuppeteer = '6 MESES (+1 MES GRATIS) - 2 DISP'
      else if (plan.dispositivos === 3) planPuppeteer = '6 MESES (+1 MES GRATIS) - 3 DISP'
    } else if (plan.duracion === '12 Meses') {
      meses = plan.bonus ? 14 : 12
      if (plan.dispositivos === 1) planPuppeteer = '1 AÑO (+2 MESES GRATIS) - 1 DISP'
      else if (plan.dispositivos === 2) planPuppeteer = '1 AÑO (+2 MESES GRATIS) - 2 DISP'
      else if (plan.dispositivos === 3) planPuppeteer = '1 AÑO (+2 MESES GRATIS) - 3 DISP'
    }

    const incluirAdultos = adultosPreferencia.get(phoneNumber) ?? true
    adultosPreferencia.delete(phoneNumber)
    const iptvData = await crearUsuarioIPTV(planPuppeteer, incluirAdultos)
    const expiresAt = (() => {
      const match = iptvData.expira?.match(/(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/)
      if (match) {
        const d = new Date(`${match[1]}T${match[2]}:00Z`)
        if (!isNaN(d.getTime())) return d
      }
      const d = new Date()
      d.setMonth(d.getMonth() + meses)
      return d
    })()
    const expiresAtDisplay = fechaCorta(expiresAt)
    const planCompleto = plan.bonus
      ? `${plan.dispositivos} Dispositivo${plan.dispositivos > 1 ? 's' : ''} – ${plan.duracion} ${plan.bonus}`
      : `${plan.dispositivos} Dispositivo${plan.dispositivos > 1 ? 's' : ''} – ${plan.duracion}`

    await prisma.user.deleteMany({ where: { celular: phoneNumber, plan: { in: ['DEMO 3 HORA', 'DEMO EXPIRADA'] } } })
    const cuentaCreada = await prisma.user.create({ data: { nombre, usuario: iptvData.usuario, password: iptvData.password, celular: phoneNumber, plan: planCompleto, expiresAt, adultChannels: incluirAdultos } })
    iniciarPollerActivacion(iptvData.usuario, cuentaCreada.id)
    await registrarTransaccion('nueva', precio, phoneNumber)

    await enviar(jid,
      `✅ *¡CUENTA ACTIVADA!*\n\n` +
      `┌───────────────\n` +
      `👤 Usuario: *${iptvData.usuario}*\n` +
      `🔐 Contraseña: *${iptvData.password}*\n` +
      `└───────────────\n\n` +
      `📦 Plan: *${planCompleto}*\n` +
      `📅 Expira: *${expiresAtDisplay}*\n\n` +
      `━━━━━━━━━━━━━━━━━━\n\n` +
      `📲 Si necesitas ayuda para instalar:\n2️⃣ Guía de instalación\n\n` +
      `0️⃣ Volver al Menú`
    )
  } catch (e: any) {
    console.error('Error procesando cuenta nueva:', e.message)
    await enviar(jid, `⚠️ *NO SE PUDO ACTIVAR LA CUENTA*\n\nTu pago fue recibido correctamente, pero ocurrió un problema temporal al crear la cuenta.\n\n📞 Por favor contacta soporte:\n64598912\n\n0️⃣ Volver al Menú`)
  } finally {
    finalizarProcesoCritico(jid)
  }
}

// =============================================
// PROCESAR RENOVACIÓN
// =============================================
async function procesarRenovacion(
  jid: string,
  phoneNumber: string,
  precio: string,
  usuarioIPTV: string,
  existingUserId: number,
): Promise<void> {
  const plan = PLANES_MAP[precio]
  iniciarProcesoCritico(jid)
  try {
    let planPuppeteer = ''
    let meses = 0
    if (plan.duracion === '1 Mes') {
      meses = 1
      if (plan.dispositivos === 1) planPuppeteer = '1 MES - 1 DISP'
      else if (plan.dispositivos === 2) planPuppeteer = '1 MES - 2 DISP'
      else if (plan.dispositivos === 3) planPuppeteer = '1 MES - 3 DISP'
    } else if (plan.duracion === '3 Meses') {
      meses = 3
      if (plan.dispositivos === 1) planPuppeteer = '3 MESES - 1 DISP'
      else if (plan.dispositivos === 2) planPuppeteer = '3 MESES - 2 DISP'
      else if (plan.dispositivos === 3) planPuppeteer = '3 MESES - 3 DISP'
    } else if (plan.duracion === '6 Meses') {
      meses = plan.bonus ? 7 : 6
      if (plan.dispositivos === 1) planPuppeteer = '6 MESES (+1 MES GRATIS) - 1 DISP'
      else if (plan.dispositivos === 2) planPuppeteer = '6 MESES (+1 MES GRATIS) - 2 DISP'
      else if (plan.dispositivos === 3) planPuppeteer = '6 MESES (+1 MES GRATIS) - 3 DISP'
    } else if (plan.duracion === '12 Meses') {
      meses = plan.bonus ? 14 : 12
      if (plan.dispositivos === 1) planPuppeteer = '1 AÑO (+2 MESES GRATIS) - 1 DISP'
      else if (plan.dispositivos === 2) planPuppeteer = '1 AÑO (+2 MESES GRATIS) - 2 DISP'
      else if (plan.dispositivos === 3) planPuppeteer = '1 AÑO (+2 MESES GRATIS) - 3 DISP'
    }

    const { renovarUsuarioIPTV, buscarUsuarioIPTV } = await import('./iptvservice.js')
    await renovarUsuarioIPTV(usuarioIPTV, planPuppeteer)

    const planCompleto = plan.bonus
      ? `${plan.dispositivos} Dispositivo${plan.dispositivos > 1 ? 's' : ''} – ${plan.duracion} ${plan.bonus}`
      : `${plan.dispositivos} Dispositivo${plan.dispositivos > 1 ? 's' : ''} – ${plan.duracion}`

    // Obtener datos reales del panel tras renovar
    let expiresAt = new Date()
    expiresAt.setMonth(expiresAt.getMonth() + meses)
    const updateData: any = { plan: planCompleto, expiresAt, reminderSent: false }

    try {
      const panelData = await buscarUsuarioIPTV(usuarioIPTV)
      if (panelData.password) updateData.password = panelData.password
      const matchFecha = panelData.expira?.match(/(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/)
      if (matchFecha) {
        const d = new Date(`${matchFecha[1]}T${matchFecha[2]}:00Z`)
        if (!isNaN(d.getTime())) { expiresAt = d; updateData.expiresAt = d }
      }
      console.log(`💾 Datos panel tras renovar — pass=${!!panelData.password} expira=${panelData.expira}`)
    } catch (e: any) {
      console.warn(`⚠️ No se pudo consultar panel tras renovar, usando fecha estimada:`, e.message)
    }

    const userRecord = await prisma.user.update({ where: { id: existingUserId }, data: updateData })
    programarRecordatorio({ ...userRecord, expiresAt })
    await registrarTransaccion('renovacion', precio, phoneNumber)

    await enviar(jid,
      `✅ *¡CUENTA RENOVADA!*\n\n` +
      `┌───────────────\n` +
      `👤 Usuario: *${usuarioIPTV}*\n` +
      `🔐 Contraseña: *${userRecord.password || '(ver datos anteriores)'}*\n` +
      `└───────────────\n\n` +
      `📦 Plan: *${planCompleto}*\n` +
      `📅 Expira: *${fechaCorta(expiresAt)}*\n\n` +
      `0️⃣ Volver al Menú`
    )
  } catch (e: any) {
    console.error('Error procesando renovación:', e.message)
    await enviar(jid, `⚠️ *NO SE PUDO RENOVAR LA CUENTA*\n\nTu pago fue recibido correctamente, pero ocurrió un problema temporal al renovar la cuenta.\n\n📞 Por favor contacta soporte:\n64598912\n\n0️⃣ Volver al Menú`)
  } finally {
    finalizarProcesoCritico(jid)
  }
}

// =============================================
// FUNCIONES AUXILIARES
// =============================================
export async function aprobarPagoManual(phoneNumber: string): Promise<string> {
  const pago = pagosManualPendientes.get(phoneNumber)
  if (!pago) return '❌ No se encontró el pago pendiente (puede haber expirado o ya fue procesado)'
  pagosManualPendientes.delete(phoneNumber)
  await enviar(pago.jid, `✅ *PAGO CONFIRMADO*\n\nTu pago fue verificado correctamente.\n\n⏳ Estamos preparando tu cuenta, por favor espera un momento...`)
  if (pago.tipo === 'nueva') {
    await procesarCuentaNueva(pago.jid, pago.phoneNumber, pago.precio, pago.nombre, pago.existingUserId)
  } else {
    await procesarRenovacion(pago.jid, pago.phoneNumber, pago.precio, pago.usuarioIPTV!, pago.existingUserId!)
  }
  return `✅ Pago aprobado y cuenta procesada para *${pago.nombre}* (${phoneNumber})`
}

export async function rechazarPagoManual(phoneNumber: string): Promise<string> {
  const pago = pagosManualPendientes.get(phoneNumber)
  if (!pago) return '❌ No se encontró el pago pendiente'
  pagosManualPendientes.delete(phoneNumber)
  userStates.delete(phoneNumber)
  await enviar(pago.jid,
    `⚠️ *NO SE PUDO CONFIRMAR EL PAGO*\n\n` +
    `No logramos verificar el pago enviado.\n\n` +
    `📞 Por favor contacta soporte para ayudarte con la verificación:\n64598912\n\n` +
    `0️⃣ Volver al menú`
  )
  return `❌ Pago rechazado para *${pago.nombre}* (${phoneNumber})`
}

export function cleanPhoneNumber(jid: string): string {
  let number = jid.replace('@s.whatsapp.net', '').replace('@c.us', '').replace('@lid', '').split(':')[0]
  if (number.startsWith('591')) number = number.substring(3)       // Bolivia
  else if (number.startsWith('549')) number = number.substring(3)  // Argentina móvil
  console.log(`🔍 Número original: ${jid} → Número limpio: ${number}`)
  return number
}

function celularAJid(celular: string): string {
  if (celular.length <= 8) return `591${celular}@s.whatsapp.net`   // Bolivia local
  if (celular.length === 10) return `549${celular}@s.whatsapp.net` // Argentina (sin código)
  return `${celular}@s.whatsapp.net`                               // Ya trae código completo
}

function normalizarNombre(input: string): string {
  return input.trim().split(/\s+/).filter(w => w.length > 0)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ')
}

function isValidName(nombre: string): boolean {
  if (nombre.trim().length < 4) return false
  return /^[a-záéíóúñA-ZÁÉÍÓÚÑ ]+$/.test(nombre.trim())
}

function primerNombre(nombre: string): string {
  return nombre.trim().split(' ')[0]
}

function cleanPuppeteerText(text: string): string {
  if (!text) return text
  return text.replace(/\s*-\s*Costo:/gi, '').replace(/\s+\d+(\.\d+)?\s+creditos?\.?/gi, '').trim()
}

export function getPagosPendientes() {
  return Array.from(pagosPendientes.values())
}

export function getPagosManualPendientes() {
  return Array.from(pagosManualPendientes.values())
}


export async function isVeripagosEnabled(): Promise<boolean> {
  try {
    const config = await prisma.config.findUnique({ where: { key: 'veripagos_enabled' } })
    if (!config) { await prisma.config.create({ data: { key: 'veripagos_enabled', value: 'true' } }); return true }
    return config.value === 'true'
  } catch { return true }
}

export async function setVeripagosEnabled(enabled: boolean): Promise<void> {
  await prisma.config.upsert({
    where: { key: 'veripagos_enabled' },
    update: { value: enabled ? 'true' : 'false' },
    create: { key: 'veripagos_enabled', value: enabled ? 'true' : 'false' }
  })
}

export async function isDemosEnabled(): Promise<boolean> {
  try {
    const config = await prisma.config.findUnique({ where: { key: 'demos_enabled' } })
    if (!config) { await prisma.config.create({ data: { key: 'demos_enabled', value: 'true' } }); return true }
    return config.value === 'true'
  } catch { return true }
}

export async function setDemosEnabled(enabled: boolean): Promise<void> {
  await prisma.config.upsert({
    where: { key: 'demos_enabled' },
    update: { value: enabled ? 'true' : 'false' },
    create: { key: 'demos_enabled', value: enabled ? 'true' : 'false' }
  })
}

function parseDateStr(str: string): Date | null {
  if (!str) return null
  // DD/MM/YYYY o DD/MM/YYYY HH:MM
  const mDMY = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/)
  if (mDMY) return new Date(parseInt(mDMY[3]), parseInt(mDMY[2]) - 1, parseInt(mDMY[1]))
  // ISO fallback
  const d = new Date(str)
  return isNaN(d.getTime()) ? null : d
}

function hasActiveOfficialAccount(user: any): boolean {
  if (!user || !user.plan) return false
  if (user.plan.includes('DEMO')) return false
  if (!user.expiresAt) return false
  return new Date() <= new Date(user.expiresAt)
}

function isPlanPrice(input: string): boolean {
  return Object.prototype.hasOwnProperty.call(PLANES_MAP, input)
}

async function enviarComprobanteAlAdmin(
  sock: WASocket,
  from: string,
  phoneNumber: string,
  pagoManual: PagoManual,
  msg: any,
): Promise<void> {
  userStates.delete(phoneNumber)
  pagoManual.comprobanteRecibido = true  // mantener en map para que admin pueda aprobar/rechazar
  await sendMsg(sock, from, {
    text: `🔍 *VERIFICANDO PAGO*\n\nTu comprobante fue recibido correctamente.\n\n⏳ La verificación puede tardar algunos minutos.\n\nPor favor espera...`,
  })
  if (adminNotifyCallback) {
    const tipoLabel = pagoManual.tipo === 'renovacion' ? '🔄 Renovación' : '🆕 Cuenta nueva'
    const planInfo = PLANES_MAP[pagoManual.precio]
    const planDescLineas = planInfo
      ? `📦 *Plan:* ${planInfo.duracion}${planInfo.bonus ? ' ' + planInfo.bonus : ''}\n📺 *Dispositivos:* ${planInfo.dispositivos}\n💰 *Total:* Bs. ${planInfo.precio}`
      : `💰 *Total:* Bs. ${pagoManual.precio}`
    const usuarioLine = pagoManual.usuarioIPTV ? `🔑 *Usuario IPTV:* ${pagoManual.usuarioIPTV}\n` : ''

    let mediaBuffer: Buffer | undefined
    try {
      const hasMedia = msg?.message?.imageMessage || msg?.message?.documentMessage ||
        msg?.message?.documentWithCaptionMessage?.message?.imageMessage
      if (hasMedia) mediaBuffer = await downloadMediaMessage(msg, 'buffer', {}) as Buffer
    } catch { /* sin archivo adjunto */ }

    await adminNotifyCallback(
      `💳 *PAGO MANUAL PENDIENTE*\n\n` +
      `👤 *Cliente:* ${pagoManual.nombre}\n` +
      `📱 *Número:* ${phoneNumber}\n` +
      `${usuarioLine}` +
      `${planDescLineas}\n` +
      `${tipoLabel}\n\n` +
      `¿Aprobar o rechazar?`,
      phoneNumber,
      mediaBuffer,
    )
  }
}

// =============================================
// MANEJADOR INTERNO
// =============================================
async function _handleMessage(sock: WASocket, msg: any): Promise<void> {
  if (!msg) return

  // ── Ignorar mensajes antiguos (evita flood de historial al reconectar) ──
  const msgTimestamp = typeof msg.messageTimestamp === 'number'
    ? msg.messageTimestamp
    : msg.messageTimestamp?.toNumber?.() ?? 0
  if (msgTimestamp && (Date.now() / 1000) - msgTimestamp > 90) return

  // ── Detectar comandos del admin escritos desde el chat del cliente ──
  if (msg.key.fromMe) {
    const jid = msg.key.remoteJid
    if (!jid || jid.endsWith('@g.us') || jid === 'status@broadcast') return
    const texto = (msg.message?.conversation || msg.message?.extendedTextMessage?.text || '').trim().toLowerCase()
    const rawJid = msg.key.remoteJidAlt || msg.key.remoteJid
    const clienteNum = cleanPhoneNumber(rawJid)
    if (texto === 'off') {
      await cargarPausados()
      numerosPausados.add(clienteNum)
      await guardarPausados()
      userStates.delete(clienteNum)
      console.log(`🔕 Bot pausado para ${clienteNum}`)
    } else if (texto === 'on') {
      await cargarPausados()
      numerosPausados.delete(clienteNum)
      await guardarPausados()
      console.log(`🔔 Bot reactivado para ${clienteNum}`)
    }
    return
  }

  setSock(sock)

  const from: string | undefined = msg.key.remoteJid
  const rawPhoneNumber: string | undefined = msg.key.remoteJidAlt || msg.key.remoteJid

  if (!from || !rawPhoneNumber) return
  if (from.endsWith('@g.us')) return
  if (from === 'status@broadcast') return

  const phoneNumber: string = cleanPhoneNumber(rawPhoneNumber)
  const pushName: string = msg.pushName || 'Usuario'
  const text: string | undefined = msg.message?.conversation || msg.message?.extendedTextMessage?.text

  // ── Verificar si el bot está pausado para este cliente ──────
  await cargarPausados()
  if (numerosPausados.has(phoneNumber)) return

  console.log(`💬 Mensaje de ${pushName} (${phoneNumber}): ${text}`)

  // ── TIMEOUT DE SESIÓN (15 min de inactividad) ───────────────
  const ahora = Date.now()
  const ultimaActividad = lastActivity.get(phoneNumber)
  const jidParaCritico = from
  if (
    ultimaActividad &&
    ahora - ultimaActividad > SESSION_TIMEOUT_MS &&
    userStates.has(phoneNumber) &&
    !procesoCritico.has(jidParaCritico)
  ) {
    console.log(`⏱️ Sesión expirada para ${phoneNumber} (${Math.round((ahora - ultimaActividad) / 60000)} min inactivo) — estado eliminado: ${userStates.get(phoneNumber)}`)
    userStates.delete(phoneNumber)
  }
  lastActivity.set(phoneNumber, ahora)

  // ── COMPROBANTE PAGO MANUAL ─────────────────────────────────
  if (userStates.get(phoneNumber) === 'esperando_comprobante') {
    const pagoManual = pagosManualPendientes.get(phoneNumber)

    if (text === '0' || text?.toLowerCase() === 'menu') {
      userStates.delete(phoneNumber)
      // No se borra pagosManualPendientes — el cliente tiene 30 min para enviar comprobante
      const usersMenu = await prisma.user.findMany({ where: { celular: phoneNumber }, orderBy: { createdAt: 'desc' } })
      const officialsMenu = usersMenu.filter(u => u.plan !== 'DEMO 3 HORA')
      await sendMsg(sock, from, { text: getMainMenu(usersMenu[0] ?? null, officialsMenu) }); return
    }

    if (text === '5' && pagoManual?.tipo === 'renovacion' && pagoManual?.usuarioIPTV) {
      userStates.delete(phoneNumber)
      pagosManualPendientes.delete(phoneNumber)
      const disp = PLANES_MAP[pagoManual.precio]?.dispositivos ?? 1
      await handleRenewalUsernameSearch(sock, from, phoneNumber, pagoManual.usuarioIPTV, disp, true); return
    }

    if (pagoManual) {
      if (text === undefined) {
        await enviarComprobanteAlAdmin(sock, from, phoneNumber, pagoManual, msg)
      } else {
        await sendMsg(sock, from, { text: `📎 *Envía una imagen o PDF* de tu comprobante de pago.\n\n0️⃣ Cancelar` })
      }
    } else {
      userStates.delete(phoneNumber)
    }
    return
  }

  // ── PAGO PENDIENTE FUERA DE FLUJO (cliente salió con 0 pero aún tiene 30 min) ──
  const pagoFuera = pagosManualPendientes.get(phoneNumber)
  if (pagoFuera && !userStates.has(phoneNumber)) {
    const minutosTranscurridos = (Date.now() - pagoFuera.timestamp) / 60000
    if (minutosTranscurridos > 30) {
      pagosManualPendientes.delete(phoneNumber)
    } else if (text === undefined && !pagoFuera.comprobanteRecibido) {
      await enviarComprobanteAlAdmin(sock, from, phoneNumber, pagoFuera, msg)
      return
    }
  }

  if (!text) return

  const userInput: string = text.trim()
  let response: string = ''

  try {
    const existingUsers = await prisma.user.findMany({ where: { celular: phoneNumber }, orderBy: { createdAt: 'desc' } })
    const existingDemoUser = existingUsers.find(u => u.plan === 'DEMO 3 HORA') ?? null
    const existingOfficialUsers = existingUsers.filter(u => u.plan !== 'DEMO 3 HORA' && u.plan !== 'DEMO EXPIRADA')
    const existingUser = existingUsers[0] ?? null
    const currentState = userStates.get(phoneNumber)
    console.log(`🔍 Estado actual de ${phoneNumber}:`, currentState || 'sin estado')

    // ── COMANDOS ADMIN ──────────────────────────────────────────
    if (phoneNumber === ADMIN_NUMBER) {
      if (userInput.toLowerCase() === 'demos off') {
        await setDemosEnabled(false); await sendMsg(sock, from, { text: '🔴 *DEMOS DESHABILITADAS*' }); return
      } else if (userInput.toLowerCase() === 'demos on') {
        await setDemosEnabled(true); await sendMsg(sock, from, { text: '🟢 *DEMOS HABILITADAS*' }); return
      } else if (userInput.toLowerCase() === 'demos status') {
        const enabled = await isDemosEnabled()
        await sendMsg(sock, from, { text: `📊 Demos: ${enabled ? '🟢 Habilitadas' : '🔴 Deshabilitadas'}` }); return
      } else if (userInput.toLowerCase() === 'pagos') {
        const total = pagosPendientes.size
        const ahora = Date.now()
        const lista = total === 0 ? 'Ninguno' : Array.from(pagosPendientes.values())
          .map(p => {
            const restanteMs = p.vigenciaMs - (ahora - p.generadoEn)
            return `• ${p.phoneNumber} | Bs.${PLANES_MAP[p.precio]?.precio} | ${p.tipo} | ⏳ ${restanteMs > 0 ? formatarTiempoRestante(restanteMs) : 'EXPIRADO'}`
          }).join('\n')
        await sendMsg(sock, from, { text: `💳 *PAGOS PENDIENTES: ${total}*\n\n${lista}` }); return
      } else if (userInput.toLowerCase().startsWith('setfecha ')) {
        const partes = userInput.trim().split(' ')
        // setfecha <usuario> <DD/MM/YYYY>
        if (partes.length < 3) {
          await sendMsg(sock, from, { text: '⚠️ Formato: *setfecha <usuario> DD/MM/YYYY*\nEjemplo: setfecha abc12 15/09/2026' }); return
        }
        const usuarioTarget = partes[1]
        const fechaStr = partes[2]
        if (!/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(fechaStr)) {
          await sendMsg(sock, from, { text: '⚠️ Formato de fecha inválido. Usá DD/MM/YYYY\nEjemplo: 15/09/2026' }); return
        }
        const userTarget = await prisma.user.findUnique({ where: { usuario: usuarioTarget } })
        if (!userTarget) {
          await sendMsg(sock, from, { text: `❌ No se encontró el usuario *${usuarioTarget}*` }); return
        }
        const [fd, fm, fy] = fechaStr.split('/')
        const fechaDate = new Date(parseInt(fy), parseInt(fm) - 1, parseInt(fd))
        await prisma.user.update({ where: { usuario: usuarioTarget }, data: { expiresAt: fechaDate, reminderSent: false } })
        await sendMsg(sock, from, { text: `✅ Fecha actualizada\n\n👤 Usuario: *${usuarioTarget}*\n📅 Nueva fecha: *${fechaStr}*` }); return
      } else if (userInput.toLowerCase().startsWith('vercliente ')) {
        const usuarioTarget = userInput.trim().split(' ')[1]
        const userTarget = await prisma.user.findUnique({ where: { usuario: usuarioTarget } })
        if (!userTarget) {
          await sendMsg(sock, from, { text: `❌ No se encontró el usuario *${usuarioTarget}*` }); return
        }
        const expiraDisplay = userTarget.expiresAt ? fechaCorta(new Date(userTarget.expiresAt)) : '-'
        await sendMsg(sock, from, {
          text: `👤 *${userTarget.nombre}*\n📱 Celular: *${userTarget.celular}*\n🔑 Usuario: *${userTarget.usuario}*\n🔐 Password: *${userTarget.password}*\n📦 Plan: *${userTarget.plan}*\n📅 Expira: *${expiraDisplay}*`
        }); return
      }
    }

    // ── CAPTURA NOMBRE PARA DEMO ────────────────────────────────
    if (currentState === 'waiting_name_for_demo') {
      if (userInput === '0' || userInput.toLowerCase() === 'menu') {
        userStates.delete(phoneNumber)
        await sendMsg(sock, from, { text: getMainMenu(existingUser, existingOfficialUsers) }); return
      }
      const nombre = normalizarNombre(userInput)
      if (nombre.length === 0) {
        await sendMsg(sock, from, { text: `⚠️ *NOMBRE NO VÁLIDO*\n\nEscribe solo tu nombre y apellido.\n\n📝 Ej: *Juan García*\n\n0️⃣ Volver al menú` }); return
      }
      if (nombre.split(' ').length > 4) {
        await sendMsg(sock, from, { text: `⚠️ *NOMBRE DEMASIADO LARGO*\n\nEscribe *solo* tu nombre y apellido, sin frases adicionales.\n\n📝 Ej: *Juan García*\n\n👉 Inténtalo de nuevo\n0️⃣ Cancelar` }); return
      }
      if (!isValidName(nombre)) {
        await sendMsg(sock, from, { text: `⚠️ *NOMBRE INVÁLIDO*\n\nSolo letras y espacios, mínimo 4 caracteres.\n❌ Sin números ni símbolos\n\n📝 Ej: *Juan García*\n\n👉 Escribe tu nombre\n0️⃣ Cancelar` }); return
      }
      pendingNombreDemo.set(phoneNumber, nombre)
      userStates.set(phoneNumber, 'confirming_adultos_demo')
      await sendMsg(sock, from, { text: TEXTO_PREGUNTA_ADULTOS }); return
    }

    // ── CAPTURA NOMBRE PARA SUSCRIPCIÓN ────────────────────────
    if (currentState && currentState.startsWith('waiting_name_for_plan_')) {
      if (userInput === '0' || userInput.toLowerCase() === 'menu') {
        userStates.delete(phoneNumber)
        await sendMsg(sock, from, { text: getMainMenu(existingUser, existingOfficialUsers) }); return
      }
      const precio = currentState.replace('waiting_name_for_plan_', '')
      const nombre = normalizarNombre(userInput)
      if (nombre.length === 0) {
        await sendMsg(sock, from, { text: `⚠️ *NOMBRE NO VÁLIDO*\n\nEscribe solo tu nombre y apellido.\n\n📝 Ej: *Juan García*\n\n0️⃣ Volver al menú` }); return
      }
      if (nombre.split(' ').length > 4) {
        await sendMsg(sock, from, { text: `⚠️ *NOMBRE DEMASIADO LARGO*\n\nEscribe *solo* tu nombre y apellido, sin frases adicionales.\n\n📝 Ej: *Juan García*\n\n👉 Inténtalo de nuevo\n0️⃣ Cancelar` }); return
      }
      if (!isValidName(nombre)) {
        await sendMsg(sock, from, { text: `⚠️ *NOMBRE INVÁLIDO*\n\nSolo letras y espacios, mínimo 4 caracteres.\n❌ Sin números ni símbolos\n\n📝 Ej: *Juan García*\n\n👉 Escribe tu nombre\n0️⃣ Cancelar` }); return
      }
      await handlePlanSelectionWithName(precio, nombre, sock, from, phoneNumber, existingUser); return
    }

    // ── GUÍAS DE INSTALACIÓN ────────────────────────────────────
    if (currentState === 'in_installation_guide') {
      const op = userInput.toLowerCase()
      if (op === 'a') { await sendInstallationGuideTVBox(sock, from, existingUser); return }
      else if (op === 'b') { await sendInstallationGuideSmartTV(sock, from, existingUser); return }
      else if (op === 'c') { await sendInstallationGuideAndroid(sock, from, existingUser); return }
      else if (op === 'd') { await sendInstallationGuideIPhone(sock, from, existingUser); return }
      else if (op === 'e') { await sendInstallationGuidePC(sock, from, existingUser); return }
      else if (op === 'o' || op === '0' || op === 'menu') {
        userStates.delete(phoneNumber); response = getMainMenu(existingUser, existingOfficialUsers)
        await sendMsg(sock, from, { text: response }); return
      } else if (op === '3' || op === '4') {
        userStates.delete(phoneNumber)
        // dejar caer al flujo principal para que procese el 3 o 4 normalmente
      } else {
        response = `⚠️ *Opción no válida*\n\nSelecciona una de las siguientes opciones 👇\n\n🅰️ TV-Android / TV Box\n🅱️ Smart TV (Samsung / LG)\n🅲️ Celular Android / Tablet\n🅳️ iPhone / iPad\n🅴️ PC o Laptop\n\n0️⃣ Volver al menú principal`
        await sendMsg(sock, from, { text: response }); return
      }
    }

    // ── SELECCIÓN PLAN DE RENOVACIÓN ───────────────────────────
    if (currentState && currentState.startsWith('selecting_renewal_plan_')) {
      const rest = currentState.replace('selecting_renewal_plan_', '')
      const sepIdx = rest.indexOf('_')
      const dispositivos = sepIdx >= 0 ? parseInt(rest.substring(0, sepIdx)) : 1
      const usuarioIPTV = sepIdx >= 0 ? rest.substring(sepIdx + 1) : rest
      if (userInput === '0' || userInput.toLowerCase() === 'menu') {
        userStates.delete(phoneNumber); await sendMsg(sock, from, { text: getMainMenu(existingUser, existingOfficialUsers) }); return
      } else if (isPlanPrice(userInput)) {
        if (dispositivos !== 0 && PLANES_MAP[userInput].dispositivos !== dispositivos) {
          const fechaExp = existingUser?.expiresAt ? `\n📅 Vencimiento del plan actual:\n*${fechaCorta(new Date(existingUser.expiresAt))}*` : ''
          await sendMsg(sock, from, {
            text:
              `⚠️ *Para cambiar esta cuenta a un plan con más dispositivos, es necesario esperar a que el plan actual expire o hacerlo 1 día antes del vencimiento.*` +
              `${fechaExp}\n\n` +
              `📌 Si necesitás más dispositivos antes de esa fecha, podés crear una cuenta nueva ahora mismo.\n\n` +
              `4️⃣ Crear cuenta nueva\n` +
              `0️⃣ Volver al menú`
          }); return
        }
        await handleRenewalPlanSelection(userInput, sock, from, phoneNumber, usuarioIPTV, existingUser); return
      } else {
        await sendMsg(sock, from, { text: '⚠️ Por favor selecciona un plan escribiendo el precio.\n\n👉 Escribe *0* para volver al menú' }); return
      }
    }

    // ── CONFIRMACIÓN CUENTA NUEVA ──────────────────────────────
    if (currentState && currentState.startsWith('confirming_new_account_')) {
      const precio = currentState.replace('confirming_new_account_', '')
      if (userInput === '0' || userInput.toLowerCase() === 'menu') {
        userStates.delete(phoneNumber); await sendMsg(sock, from, { text: getMainMenu(existingUser, existingOfficialUsers) }); return
      }
      if (userInput === '5') {
        userStates.delete(phoneNumber)
        if (existingOfficialUsers.length === 1) {
          await handleRenewalWithQuickOption(sock, from, phoneNumber, existingOfficialUsers[0]); return
        }
        await handleAccountSelectionForRenewal(sock, from, phoneNumber, existingOfficialUsers); return
      }
      if (userInput.toLowerCase() === 'si' || userInput.toLowerCase() === 'sí') {
        userStates.delete(phoneNumber)
        const knownName = existingUser?.nombre
        if (!knownName || knownName === 'Cliente' || knownName === 'Cliente Demo') {
          userStates.set(phoneNumber, `waiting_name_for_plan_${precio}`)
          await sendMsg(sock, from, { text: `📝 *CREAR NUEVA CUENTA*\n\nEscribe tu nombre 👇` }); return
        }
        await handlePlanSelectionWithName(precio, knownName, sock, from, phoneNumber, existingUser); return
      }
      await sendMsg(sock, from, { text: `⚠️ Opción no válida.\n\n✅ Escribe *SI* para agregar cuenta nueva\n5️⃣ Renovar una cuenta existente\n0️⃣ Menú` }); return
    }

    // ── SELECCIÓN DE CUENTA PARA RENOVAR ───────────────────────
    if (currentState === 'selecting_account_to_renew') {
      if (userInput === '0' || userInput.toLowerCase() === 'menu') {
        userStates.delete(phoneNumber); await sendMsg(sock, from, { text: getMainMenu(existingUser, existingOfficialUsers) }); return
      }
      const idx = parseInt(userInput) - 1
      if (isNaN(idx) || idx < 0 || idx >= existingOfficialUsers.length) {
        await sendMsg(sock, from, { text: `⚠️ *OPCIÓN NO VÁLIDA*\n\nSelecciona una cuenta escribiendo un número del *1 al ${existingOfficialUsers.length}*.\n\n0️⃣ Volver al Menú` }); return
      }
      await handleRenewalWithQuickOption(sock, from, phoneNumber, existingOfficialUsers[idx]); return
    }

    // ── RENOVACIÓN RÁPIDA ───────────────────────────────────────
    if (currentState && currentState.startsWith('quick_renewal_')) {
      const parts = currentState.replace('quick_renewal_', '').split('_')
      const usuarioIPTV = parts[0]
      const precioSugerido = parts[1]
      const cuentaActivada = parts[2] !== '0' // '0' = aún no usada, '1' o ausente = activada
      if (userInput === '0' || userInput.toLowerCase() === 'menu') {
        userStates.delete(phoneNumber); await sendMsg(sock, from, { text: getMainMenu(existingUser, existingOfficialUsers) }); return
      } else if (userInput === '1') {
        await handleRenewalPlanSelection(precioSugerido, sock, from, phoneNumber, usuarioIPTV, existingUser); return
      } else if (userInput === '2') {
        const dispositivos = PLANES_MAP[precioSugerido]?.dispositivos ?? 1
        const canChangePlan = cuentaActivada && existingUser?.reminderSent === true
        const imgDisp: number | 'all' = canChangePlan ? 'all' : dispositivos
        await sendPlanesImagen(sock, from, imgDisp, `Escribe el precio del plan que deseas 👇`)
        userStates.set(phoneNumber, `selecting_renewal_plan_${canChangePlan ? 0 : dispositivos}_${usuarioIPTV}`)
        return
      } else {
        await sendMsg(sock, from, { text: `⚠️ Opción no válida.\n\n1️⃣ Sí\n2️⃣ Ver otros planes\n0️⃣ Volver al menú` }); return
      }
    }

    // ── ACTIVACIÓN DE CUENTA DEMO ───────────────────────────────
    if (currentState === 'demo_activate_offer') {
      if (userInput === '0' || userInput.toLowerCase() === 'menu') {
        userStates.delete(phoneNumber); await sendMsg(sock, from, { text: getMainMenu(existingUser, existingOfficialUsers) }); return
      }
      if (userInput === '4') {
        userStates.set(phoneNumber, 'seleccionando_plan_nuevo')
        await sendPlanesImagen(sock, from, 'all', `Escribe el precio del plan que deseas 👇`)
        return
      }
      if (userInput === '1') {
        if (!existingDemoUser) { userStates.delete(phoneNumber); await sendMsg(sock, from, { text: getMainMenu(existingUser, existingOfficialUsers) }); return }
        await sendMsg(sock, from, { text: `🔍 *VERIFICANDO TU CUENTA...*\n\nPor favor espera un momento.` })
        let cuentaDemo: Awaited<ReturnType<typeof import('./iptvservice.js')['buscarUsuarioIPTV']>> | null = null
        try {
          const { buscarUsuarioIPTV } = await import('./iptvservice.js')
          try {
            cuentaDemo = await buscarUsuarioIPTV(existingDemoUser.usuario)
          } catch {
            await new Promise(r => setTimeout(r, 3000))
            cuentaDemo = await buscarUsuarioIPTV(existingDemoUser.usuario)
          }
          // Guardar datos reales del panel en DB
          try {
            const syncDemo: any = {}
            if (cuentaDemo.password) syncDemo.password = cuentaDemo.password
            const matchExp = cuentaDemo.expira?.match(/(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/)
            if (matchExp) {
              const d = new Date(`${matchExp[1]}T${matchExp[2]}:00Z`)
              if (!isNaN(d.getTime())) syncDemo.expiresAt = d
            }
            if (Object.keys(syncDemo).length > 0)
              await prisma.user.update({ where: { id: existingDemoUser.id }, data: syncDemo })
          } catch {}
        } catch {
          userStates.delete(phoneNumber)
          try { await prisma.user.update({ where: { id: existingDemoUser.id }, data: { plan: 'DEMO EXPIRADA' } }) } catch {}
          await sendMsg(sock, from, {
            text:
              `ℹ️ *Tu cuenta demo ya no está disponible*\n\n` +
              `⏱️ La demo ya expiró y no puede activarse.\n\n` +
              `4️⃣ Suscribirme con una cuenta nueva\n` +
              `0️⃣ Volver al menú`
          }); return
        }
        const passwordDemo = cuentaDemo?.password || existingDemoUser.password
        userStates.set(phoneNumber, 'demo_selecting_plan')
        await sendMsg(sock, from, {
          text:
            `✅ *Cuenta Mastv Verificada*\n\n` +
            `┌───────────────\n` +
            `👤 Usuario: *${existingDemoUser.usuario}*\n` +
            `🔐 Contraseña: *${passwordDemo}*\n` +
            `└───────────────`
        })
        await sendPlanesImagen(sock, from, 'all', `Escribe el precio del plan que deseas 👇`)
        return
      }
      await sendMsg(sock, from, { text: `⚠️ Opción no válida.\n\n1️⃣ Activar esta cuenta\n4️⃣ Suscribirme con cuenta nueva\n0️⃣ Menú` }); return
    }

    // ── SELECCIÓN CUENTA PARA ACTIVAR ADULTOS ──────────────────
    if (currentState === 'selecting_account_adultos') {
      if (userInput === '0' || userInput.toLowerCase() === 'menu') {
        userStates.delete(phoneNumber); await sendMsg(sock, from, { text: getMainMenu(existingUser, existingOfficialUsers) }); return
      }
      const idx = parseInt(userInput) - 1
      if (isNaN(idx) || idx < 0 || idx >= existingOfficialUsers.length) {
        await sendMsg(sock, from, { text: `⚠️ Opción no válida. Escribe un número del 1 al ${existingOfficialUsers.length}\n\n0️⃣ Cancelar` }); return
      }
      const u = existingOfficialUsers[idx]
      const activar = !u.adultChannels
      userStates.set(phoneNumber, `confirming_adultos_activation_${u.usuario}`)
      await sendMsg(sock, from, {
        text:
          `🔞 *${activar ? 'ACTIVAR' : 'DESACTIVAR'} CONTENIDO ADULTOS (+18)*\n\n` +
          `👤 Cuenta: *${u.usuario}*\n` +
          `Estado actual: ${u.adultChannels ? '✅ Activados' : '❌ Desactivados'}\n\n` +
          `¿Confirmas que deseas ${activar ? 'activar' : 'desactivar'} el contenido adulto?\n\n` +
          `1️⃣ Sí, ${activar ? 'activar' : 'desactivar'}\n` +
          `0️⃣ Cancelar`
      }); return
    }

    // ── CONFIRMACIÓN ACTIVAR ADULTOS ────────────────────────────
    if (currentState && currentState.startsWith('confirming_adultos_activation_')) {
      const usuarioIPTV = currentState.replace('confirming_adultos_activation_', '')
      const inputLC = userInput.toLowerCase()
      if (inputLC === '0' || inputLC === 'no' || inputLC === 'menu') {
        userStates.delete(phoneNumber); await sendMsg(sock, from, { text: getMainMenu(existingUser, existingOfficialUsers) }); return
      }
      if (inputLC === '1' || inputLC === 'si' || inputLC === 'sí') {
        userStates.delete(phoneNumber)
        const dbUser = await prisma.user.findUnique({ where: { usuario: usuarioIPTV } })
        const activar = !dbUser?.adultChannels
        await sendMsg(sock, from, { text: `⏳ *${activar ? 'Activando' : 'Desactivando'} contenido adulto...*\n\nPor favor espera un momento.` })
        iniciarProcesoCritico(from)
        try {
          const { activarAdultosEnUsuario, desactivarAdultosEnUsuario } = await import('./iptvservice.js')
          if (activar) {
            await activarAdultosEnUsuario(usuarioIPTV)
          } else {
            await desactivarAdultosEnUsuario(usuarioIPTV)
          }
          await prisma.user.update({ where: { usuario: usuarioIPTV }, data: { adultChannels: activar } })
          await sendMsg(sock, from, {
            text:
              `✅ *Contenido adulto ${activar ? 'activado' : 'desactivado'}*\n\n` +
              `👤 Cuenta: *${usuarioIPTV}*\n\n` +
              `${activar ? 'El contenido +18 ya está disponible en tu cuenta.' : 'El contenido adulto fue removido de tu cuenta.'}\n\n` +
              `⚠️ Para ver los cambios reflejados, actualiza 🔄 el contenido en la aplicación.\n\n` +
              `0️⃣ Volver al Menú`
          })
        } catch (e: any) {
          console.error('❌ Error cambiando canales adultos:', e.message)
          await sendMsg(sock, from, {
            text:
              `⚠️ *NO SE PUDO ACTUALIZAR EL CONTENIDO ADULTO*\n\n` +
              `Ocurrió un problema temporal al aplicar los cambios en la cuenta:\n\n` +
              `👤 *${usuarioIPTV}*\n\n` +
              `📞 Por favor solicita el cambio al soporte:\n64598912\n\n` +
              `0️⃣ Volver al Menú`
          })
        } finally {
          finalizarProcesoCritico(from)
        }
        return
      }
      await sendMsg(sock, from, { text: `⚠️ Opción no válida.\n\n1️⃣ Sí, activar\n0️⃣ Cancelar` }); return
    }

    // ── PREGUNTA CANALES ADULTOS — DEMO ────────────────────────
    if (currentState === 'confirming_adultos_demo') {
      const lc = userInput.toLowerCase().trim()
      if (lc === '0' || lc === 'menu') {
        userStates.delete(phoneNumber)
        pendingNombreDemo.delete(phoneNumber)
        await sendMsg(sock, from, { text: getMainMenu(existingUser, existingOfficialUsers) }); return
      }
      if (lc === '1' || lc === '2' || lc === 'si' || lc === 'sí' || lc === 'no') {
        const nombre = pendingNombreDemo.get(phoneNumber) || 'Cliente'
        pendingNombreDemo.delete(phoneNumber)
        userStates.delete(phoneNumber)
        const incluirAdultos = lc === '1' || lc === 'si' || lc === 'sí'
        const respuesta = await handleDemoCreation(sock, from, phoneNumber, nombre, incluirAdultos)
        await sendMsg(sock, from, { text: respuesta }); return
      }
      await sendMsg(sock, from, { text: `⚠️ Opción no válida.\n\n${TEXTO_PREGUNTA_ADULTOS}` }); return
    }

    // ── PREGUNTA CANALES ADULTOS — CUENTA NUEVA ────────────────
    if (currentState === 'confirming_adultos_nueva') {
      const lc = userInput.toLowerCase().trim()
      if (lc === '0' || lc === 'menu') {
        userStates.delete(phoneNumber)
        pendingNombreParaAdultos.delete(phoneNumber)
        await sendMsg(sock, from, { text: getMainMenu(existingUser, existingOfficialUsers) }); return
      }
      if (lc === '1' || lc === '2' || lc === 'si' || lc === 'sí' || lc === 'no') {
        const pending = pendingNombreParaAdultos.get(phoneNumber)
        pendingNombreParaAdultos.delete(phoneNumber)
        userStates.delete(phoneNumber)
        if (!pending) { await sendMsg(sock, from, { text: getMainMenu(existingUser, existingOfficialUsers) }); return }
        const incluirAdultos = lc === '1' || lc === 'si' || lc === 'sí'
        adultosPreferencia.set(phoneNumber, incluirAdultos)
        const plan = PLANES_MAP[pending.precio]
        await enviarQRPago(sock, from, phoneNumber, plan.precio, 'nueva', pending.precio, pending.nombre, undefined, existingUser?.id)
        return
      }
      await sendMsg(sock, from, { text: `⚠️ Opción no válida.\n\n${TEXTO_PREGUNTA_ADULTOS}` }); return
    }

    if (currentState === 'demo_selecting_plan') {
      if (userInput === '0' || userInput.toLowerCase() === 'menu') {
        userStates.delete(phoneNumber); await sendMsg(sock, from, { text: getMainMenu(existingUser, existingOfficialUsers) }); return
      }
      if (isPlanPrice(userInput)) {
        userStates.delete(phoneNumber)
        if (!existingDemoUser) { await sendMsg(sock, from, { text: getMainMenu(existingUser, existingOfficialUsers) }); return }
        const nombre = existingDemoUser.nombre || existingUser?.nombre || 'Cliente'
        const plan = PLANES_MAP[userInput]
        await enviarQRPago(sock, from, phoneNumber, plan.precio, 'renovacion', userInput, nombre, existingDemoUser.usuario, existingDemoUser.id)
        return
      }
      await sendMsg(sock, from, { text: `⚠️ Opción no válida. Escribe el precio del plan que deseas.\n0️⃣ Volver al menú` }); return
    }

    // ── SELECCIÓN DE PLAN (nueva cuenta) ───────────────────────
    if (currentState === 'seleccionando_plan_nuevo') {
      if (userInput === '0' || userInput.toLowerCase() === 'menu') {
        userStates.delete(phoneNumber); await sendMsg(sock, from, { text: getMainMenu(existingUser, existingOfficialUsers) }); return
      }
      if (isPlanPrice(userInput)) {
        userStates.delete(phoneNumber)
        if (existingOfficialUsers.length > 0) {
          const selectedDisp = PLANES_MAP[userInput]?.dispositivos ?? 0
          const samePlanAccounts = existingOfficialUsers.filter(u => {
            const m = (u.plan || '').match(/^(\d+) Dispositivos?/)
            return m ? parseInt(m[1]) === selectedDisp : false
          })
          if (samePlanAccounts.length > 0) {
            userStates.set(phoneNumber, `confirming_new_account_${userInput}`)
            const fmtPlan = (plan: string) => {
              const pm = plan.match(/^(\d+) Dispositivos?\s*–\s*(.+)$/)
              return pm ? `📦 Plan: *${pm[2]}*\n📺 Dispositivos: *${pm[1]}*` : `📦 Plan: *${plan || 'sin plan'}*`
            }
            if (samePlanAccounts.length === 1) {
              const u = samePlanAccounts[0]
              await sendMsg(sock, from, {
                text:
                  `📺 *YA TIENES UNA CUENTA ACTIVA*\n\n` +
                  `┌───────────────\n` +
                  `🔑 Usuario: *${u.usuario}*\n` +
                  `${fmtPlan(u.plan || '')}\n` +
                  `└───────────────\n\n` +
                  `¿Deseas agregar una cuenta adicional?\n\n` +
                  `✅ Escribe *SI* para confirmar\n` +
                  `5️⃣ Renovar cuenta existente\n` +
                  `0️⃣ Volver al menú`
              }); return
            }
            const lista = samePlanAccounts.map((u2, i) => {
              const pm = (u2.plan || '').match(/^(\d+) Dispositivos?\s*–\s*(.+)$/)
              const planLines = pm ? `   📦 Plan: *${pm[2]}*\n   📺 Dispositivos: *${pm[1]}*` : `   📦 *${u2.plan || 'sin plan'}*`
              return `${i + 1}️⃣ ┌───────────────\n   🔑 *${u2.usuario}*\n${planLines}\n   └───────────────`
            }).join('\n\n')
            await sendMsg(sock, from, {
              text:
                `📺 *YA TIENES ${samePlanAccounts.length} CUENTAS ACTIVAS*\n\n` +
                `${lista}\n\n` +
                `¿Deseas agregar una cuenta adicional?\n\n` +
                `✅ Escribe *SI* para confirmar\n` +
                `5️⃣ Renovar una cuenta existente\n` +
                `0️⃣ Volver al menú`
            }); return
          }
        }
        const knownName = existingUser?.nombre
        if (!knownName || knownName === 'Cliente' || knownName === 'Cliente Demo') {
          userStates.set(phoneNumber, `waiting_name_for_plan_${userInput}`)
          await sendMsg(sock, from, { text: `📝 *CREAR NUEVA CUENTA*\n\nEscribe tu nombre 👇` }); return
        }
        await handlePlanSelectionWithName(userInput, knownName, sock, from, phoneNumber, existingUser); return
      }
      await sendMsg(sock, from, { text: `⚠️ Opción no válida. Escribe el precio del plan que deseas.\n0️⃣ Volver al menú` }); return
    }

    // ── MENÚ PRINCIPAL ──────────────────────────────────────────
    if (userInput === '1') {
      await getInfoAndPrices(sock, from, existingOfficialUsers.length > 0); return

    } else if (userInput === '3') {
      if (existingOfficialUsers.length > 0) {
        await mostrarMisCuentas(sock, from, existingOfficialUsers); return
      }
      const existingExpiredDemo = existingUsers.find(u => u.plan === 'DEMO EXPIRADA') ?? null
      if (existingExpiredDemo && !existingDemoUser) {
        await sendMsg(sock, from, {
          text:
            `ℹ️ *Tu cuenta demo ya no está disponible*\n\n` +
            `⏱️ La demo que obtuviste ya expiró y no puede reactivarse.\n\n` +
            `4️⃣ Suscribirme con una cuenta nueva\n` +
            `0️⃣ Volver al menú`
        }); return
      }
      await handleFreeTrial(sock, from, phoneNumber, existingDemoUser); return

    } else if (userInput === '4') {
      userStates.set(phoneNumber, 'seleccionando_plan_nuevo')
      await sendPlanesImagen(sock, from, 'all', `Escribe el precio del plan que deseas 👇`); return

    } else if (userInput === '5') {
      if (existingOfficialUsers.length === 0) {
        await sendMsg(sock, from, {
          text:
            `⚠️ *NO HAY CUENTAS REGISTRADAS*\n\n` +
            `Para renovar una cuenta, primero necesitas tener una suscripción activa.\n\n` +
            `━━━━━━━━━━━━━━━━━━\n\n` +
            `3️⃣ Prueba gratis\n4️⃣ Ver planes y suscribirme\n\n0️⃣ Volver al Menú`
        }); return
      }
      if (existingOfficialUsers.length === 1) {
        await handleRenewalWithQuickOption(sock, from, phoneNumber, existingOfficialUsers[0]); return
      }
      await handleAccountSelectionForRenewal(sock, from, phoneNumber, existingOfficialUsers); return

    } else if (userInput === '8') {
      if (existingOfficialUsers.length === 0) {
        response = getMainMenu(existingUser, existingOfficialUsers)
      } else if (existingOfficialUsers.length === 1) {
        const u = existingOfficialUsers[0]
        const activar = !u.adultChannels
        userStates.set(phoneNumber, `confirming_adultos_activation_${u.usuario}`)
        await sendMsg(sock, from, {
          text:
            `🔞 *${activar ? 'ACTIVAR' : 'DESACTIVAR'} CONTENIDO ADULTOS (+18)*\n\n` +
            `👤 Cuenta: *${u.usuario}*\n` +
            `Estado actual: ${u.adultChannels ? '✅ Activados' : '❌ Desactivados'}\n\n` +
            `¿Confirmas que deseas ${activar ? 'activar' : 'desactivar'} el contenido adulto?\n\n` +
            `1️⃣ Sí, ${activar ? 'activar' : 'desactivar'}\n` +
            `0️⃣ Cancelar`
        }); return
      } else {
        const lista = existingOfficialUsers.map((u, i) =>
          `${i + 1}️⃣ *${u.usuario}* — adultos: ${u.adultChannels ? '✅' : '❌'}`
        ).join('\n')
        userStates.set(phoneNumber, 'selecting_account_adultos')
        await sendMsg(sock, from, {
          text:
            `🔞 *CONTENIDO ADULTOS (+18)*\n\n` +
            `¿En qué cuenta deseas cambiar el estado?\n\n${lista}\n\n` +
            `👉 Escribe el número de la cuenta\n0️⃣ Cancelar`
        }); return
      }

    } else if (userInput === '6') {
      if (existingOfficialUsers.length > 0) {
        await sendCommunityInfo(sock, from); return
      }
      await sendResellerInfo(sock, from); return
    } else if (userInput === '7') {
      response = getAdvisorContact()
    } else if (userInput === '2') {
      userStates.set(phoneNumber, 'in_installation_guide'); response = getInstallationGuide()
    } else if (userInput === '0' || userInput.toLowerCase() === 'menu') {
      response = getMainMenu(existingUser, existingOfficialUsers)
    } else if (isPlanPrice(userInput)) {
      if (existingOfficialUsers.length > 0) {
        const selectedDisp = PLANES_MAP[userInput]?.dispositivos ?? 0
        const samePlanAccounts = existingOfficialUsers.filter(u => {
          const m = (u.plan || '').match(/^(\d+) Dispositivos?/)
          return m ? parseInt(m[1]) === selectedDisp : false
        })
        if (samePlanAccounts.length > 0) {
          userStates.set(phoneNumber, `confirming_new_account_${userInput}`)
          const fmtPlan = (plan: string) => {
            const pm = plan.match(/^(\d+) Dispositivos?\s*–\s*(.+)$/)
            return pm ? `📦 Plan: *${pm[2]}*\n📺 Dispositivos: *${pm[1]}*` : `📦 Plan: *${plan || 'sin plan'}*`
          }
          if (samePlanAccounts.length === 1) {
            const u = samePlanAccounts[0]
            await sendMsg(sock, from, {
              text:
                `📺 *YA TIENES UNA CUENTA ACTIVA*\n\n` +
                `┌───────────────\n` +
                `🔑 Usuario: *${u.usuario}*\n` +
                `${fmtPlan(u.plan || '')}\n` +
                `└───────────────\n\n` +
                `¿Deseas agregar una cuenta adicional?\n\n` +
                `✅ Escribe *SI* para confirmar\n` +
                `5️⃣ Renovar cuenta existente\n` +
                `0️⃣ Volver al menú`
            }); return
          }
          const lista = samePlanAccounts.map((u, i) => {
            const pm = (u.plan || '').match(/^(\d+) Dispositivos?\s*–\s*(.+)$/)
            const planLines = pm ? `   📦 Plan: *${pm[2]}*\n   📺 Dispositivos: *${pm[1]}*` : `   📦 *${u.plan || 'sin plan'}*`
            return `${i + 1}️⃣ ┌───────────────\n   🔑 *${u.usuario}*\n${planLines}\n   └───────────────`
          }).join('\n\n')
          await sendMsg(sock, from, {
            text:
              `📺 *YA TIENES ${samePlanAccounts.length} CUENTAS ACTIVAS*\n\n` +
              `${lista}\n\n` +
              `¿Deseas agregar una cuenta adicional?\n\n` +
              `✅ Escribe *SI* para confirmar\n` +
              `5️⃣ Renovar una cuenta existente\n` +
              `0️⃣ Volver al menú`
          }); return
        }
      }
      const knownName = existingUser?.nombre
      if (!knownName || knownName === 'Cliente' || knownName === 'Cliente Demo') {
        userStates.set(phoneNumber, `waiting_name_for_plan_${userInput}`)
        await sendMsg(sock, from, { text: `📝 *CREAR NUEVA CUENTA*\n\nEscribe tu nombre 👇` }); return
      } else {
        await handlePlanSelectionWithName(userInput, knownName, sock, from, phoneNumber, existingUser); return
      }
    } else {
      response = getMainMenu(existingUser, existingOfficialUsers)
    }

    if (response) await sendMsg(sock, from, { text: response })

  } catch (error) {
    console.error('❌ Error:', error)
    await sendMsg(sock, from, { text: '⚠️ Hubo un error. Intenta de nuevo escribiendo *menu*' })
    userStates.delete(phoneNumber)
  }
}

// =============================================
// FLUJOS DE PAGO CON QR
// =============================================
async function handlePlanSelectionWithName(precio: string, nombre: string, sock: WASocket, from: string, phoneNumber: string, existingUser: any): Promise<void> {
  userStates.delete(phoneNumber)
  pendingNombreParaAdultos.set(phoneNumber, { nombre, precio })
  userStates.set(phoneNumber, 'confirming_adultos_nueva')
  await sendMsg(sock, from, { text: TEXTO_PREGUNTA_ADULTOS })
}

async function handleRenewalPlanSelection(precio: string, sock: WASocket, from: string, phoneNumber: string, usuarioIPTV: string, existingUser: any): Promise<void> {
  userStates.delete(phoneNumber)
  const plan = PLANES_MAP[precio]
  await enviarQRPago(sock, from, phoneNumber, plan.precio, 'renovacion', precio, existingUser?.nombre || 'Cliente', usuarioIPTV, existingUser?.id)
}

// =============================================
// FIX: RENOVACIÓN CON OPCIÓN RÁPIDA
// — Plan correcto según paquete + expiración relativa
// =============================================
async function handleRenewalWithQuickOption(sock: WASocket, from: string, phoneNumber: string, existingUser: any): Promise<void> {
  await sendMsg(sock, from, { text: `🔍 *BUSCANDO TU CUENTA...*\n\nPor favor espera un momento.` })
  try {
    const { buscarUsuarioIPTV } = await import('./iptvservice.js')
    let cuentaData: Awaited<ReturnType<typeof buscarUsuarioIPTV>>
    try {
      cuentaData = await buscarUsuarioIPTV(existingUser.usuario)
    } catch {
      await new Promise(r => setTimeout(r, 3000))
      cuentaData = await buscarUsuarioIPTV(existingUser.usuario)
    }

    // Detectar precio real según paquete + conexiones del panel
    const precioActual = detectarPrecioDesdePanel(cuentaData.paquete, cuentaData.conexiones)
    const planActual = PLANES_MAP[precioActual]

    console.log(`✅ Plan detectado para ${existingUser.usuario}: precio=${precioActual} | ${planActual.dispositivos} disp | ${planActual.duracion}`)

    // Detectar si la cuenta aún no fue usada
    const expiraRaw = (cuentaData.expira ?? '').toLowerCase()
    const noActivadaAun = expiraRaw.includes('first connection') || expiraRaw.includes('set on') || expiraRaw.startsWith('+')

    // Guardar datos frescos del panel en la DB
    try {
      const planDesc = `${planActual.dispositivos} Dispositivo${planActual.dispositivos > 1 ? 's' : ''} – ${planActual.duracion}${planActual.bonus ? ' ' + planActual.bonus : ''}`
      const syncData: any = { plan: planDesc, activated: !noActivadaAun }
      if (cuentaData.password) syncData.password = cuentaData.password

      if (noActivadaAun) {
        // Sin fecha real aún — poner hoy como placeholder y lanzar poller
        syncData.expiresAt = new Date()
        console.log(`⏳ Cuenta ${existingUser.usuario} sin activar — guardando fecha placeholder y lanzando poller`)
        iniciarPollerActivacion(existingUser.usuario, existingUser.id)
      } else {
        const matchFecha = cuentaData.expira?.match(/(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/)
        if (matchFecha) {
          const d = new Date(`${matchFecha[1]}T${matchFecha[2]}:00Z`)
          if (!isNaN(d.getTime())) syncData.expiresAt = d
        }
      }

      await prisma.user.update({ where: { id: existingUser.id }, data: syncData })
      console.log(`💾 DB actualizada para ${existingUser.usuario}: pass=${!!syncData.password} expira=${syncData.expiresAt ?? 'sin cambio'} activada=${!noActivadaAun}`)
    } catch (e: any) {
      console.warn(`⚠️ No se pudo actualizar DB para ${existingUser.usuario}:`, e.message)
    }


    await sendMsg(sock, from, {
      text:
        `🔄 *${cuentaData.usuario}*\n` +
        `${planActual.duracion}${planActual.bonus ? ' ' + planActual.bonus : ''} • ${planActual.dispositivos} Dispositivo${planActual.dispositivos > 1 ? 's' : ''}\n\n` +
        `¿Renovamos el mismo plan por Bs. ${planActual.precio}?\n\n` +
        `1️⃣ Sí\n` +
        `2️⃣ Ver otros planes\n` +
        `0️⃣ No, volver al menú`
    })
    userStates.set(phoneNumber, `quick_renewal_${existingUser.usuario}_${precioActual}_${noActivadaAun ? '0' : '1'}`)
  } catch (error: any) {
    userStates.delete(phoneNumber)
    const noEncontrado = error?.message?.toLowerCase().includes('no se encontró') || error?.message?.toLowerCase().includes('no se encontro')
    if (noEncontrado) {
      console.log(`ℹ️ Cuenta no encontrada en panel: ${existingUser.usuario}`)
      try {
        await prisma.user.delete({ where: { id: existingUser.id } })
        console.log(`🗑️ Cuenta eliminada de DB (no existe en panel): ${existingUser.usuario}`)
      } catch (e: any) {
        console.error('Error eliminando cuenta de DB:', e.message)
      }
      await sendMsg(sock, from, {
        text:
          `⚠️ *CUENTA NO DISPONIBLE*\n\n` +
          `La cuenta *${existingUser.usuario}* ya no se encuentra activa en el sistema.\n\n` +
          `━━━━━━━━━━━━━━━━━━\n\n` +
          `4️⃣ Crear nueva cuenta\n\n` +
          `0️⃣ Volver al Menú`
      })
    } else {
      console.error(`❌ Error inesperado buscando cuenta ${existingUser.usuario}:`, error.message)
      await sendMsg(sock, from, { text: `⚠️ *NO SE PUDO VERIFICAR LA CUENTA*\n\nOcurrió un problema temporal al consultar la cuenta *${existingUser.usuario}*.\n\n📞 Por favor contacta soporte:\n64598912\n\n0️⃣ Volver al Menú` })
    }
  }
}

async function handleRenewalUsernameSearch(sock: WASocket, from: string, phoneNumber: string, usuarioIPTV: string, dispositivos: number, showAll = false): Promise<void> {
  let planesTexto: string
  let titulo: string

  if (showAll) {
    titulo = `📺 *PLANES DISPONIBLES — Todos los dispositivos*\n👤 Cuenta: *${usuarioIPTV}*`
    planesTexto =
      `📺 *1 DISPOSITIVO*\n` +
      Object.entries(PLANES_MAP).filter(([, p]) => p.dispositivos === 1).map(([pr, p]) => `▫️ ${pr} → ${p.duracion}${p.bonus ? ' ' + p.bonus : ''}`).join('\n') + '\n\n' +
      `📺 *2 DISPOSITIVOS*\n` +
      Object.entries(PLANES_MAP).filter(([, p]) => p.dispositivos === 2).map(([pr, p]) => `▫️ ${pr} → ${p.duracion}${p.bonus ? ' ' + p.bonus : ''}`).join('\n') + '\n\n' +
      `📺 *3 DISPOSITIVOS*\n` +
      Object.entries(PLANES_MAP).filter(([, p]) => p.dispositivos === 3).map(([pr, p]) => `▫️ ${pr} → ${p.duracion}${p.bonus ? ' ' + p.bonus : ''}`).join('\n')
  } else {
    titulo = `📺 *PLANES DE RENOVACIÓN — ${dispositivos} Dispositivo${dispositivos > 1 ? 's' : ''}*\n👤 Cuenta: *${usuarioIPTV}*`
    planesTexto = Object.entries(PLANES_MAP)
      .filter(([, p]) => p.dispositivos === dispositivos)
      .map(([precio, p]) => `▫️ ${precio} → ${p.duracion}${p.bonus ? ' ' + p.bonus : ''}`)
      .join('\n')
  }

  await sendMsg(sock, from, {
    text:
      `${titulo}\n\n` +
      `👉 Escribe el precio del plan\n\n` +
      `${planesTexto}\n\n` +
      `0️⃣ Volver al menú`
  })
  userStates.set(phoneNumber, `selecting_renewal_plan_${showAll ? 0 : dispositivos}_${usuarioIPTV}`)
}

async function handleAccountSelectionForRenewal(sock: WASocket, from: string, phoneNumber: string, accounts: any[]): Promise<void> {
  const sep = `━━━━━━━━━━━━━━━`
  const lista = accounts.map((u, i) => {
    const expiraDate = u.expiresAt ? new Date(u.expiresAt) : null
    let expiraLabel = '-'
    let vencida = false
    if (expiraDate) {
      const hoy = new Date(); hoy.setHours(0,0,0,0)
      const fe = new Date(expiraDate); fe.setHours(0,0,0,0)
      const diff = Math.round((fe.getTime() - hoy.getTime()) / 86400000)
      if (diff < -1) {
        vencida = true
        expiraLabel = `⏳ Expiró: *${fechaCorta(expiraDate)}*`
      } else {
        expiraLabel = `⏳ Expira: *${fechaCorta(expiraDate)}*`
      }
    }
    const estadoLinea = vencida ? `📅 Estado: ❌ VENCIDA\n` : ``
    return (
      `${sep}\n` +
      `${i + 1}️⃣ *${u.usuario}*\n` +
      `📦 Plan: *${u.plan || 'Sin plan'}*\n` +
      `${estadoLinea}` +
      `${expiraLabel}`
    )
  }).join('\n\n')
  const n = accounts.length
  await sendMsg(sock, from, {
    text:
      `🔄 *RENOVAR CUENTA*\n\n` +
      `Tienes ${n} cuenta${n !== 1 ? 's' : ''} registrada${n !== 1 ? 's' : ''}.\n` +
      `Selecciona cuál deseas renovar:\n\n` +
      `${lista}\n` +
      `${sep}\n\n` +
      `👉 Escribe el número de la cuenta\n` +
      `0️⃣ Volver al menú`
  })
  userStates.set(phoneNumber, 'selecting_account_to_renew')
}

// =============================================
// DEMO
// =============================================
async function handleDemoCreation(sock: WASocket, from: string, phoneNumber: string, nombre: string, incluirAdultos = true): Promise<string> {
  await sendMsg(sock, from, { text: `⏳ *CREANDO TU PRUEBA GRATIS...*\n\nPor favor espera un momento.` })
  iniciarProcesoCritico(from)
  try {
    const iptvData = await crearUsuarioIPTV('DEMO 3 HORA', incluirAdultos)
    const demoExp = new Date()
    demoExp.setHours(demoExp.getHours() + 3)
    await prisma.user.create({ data: { nombre, usuario: iptvData.usuario, password: iptvData.password, celular: phoneNumber, plan: 'DEMO 3 HORA', expiresAt: demoExp, adultChannels: incluirAdultos, activated: true } })
    console.log(`🎬 DEMO CREADA | Usuario: ${iptvData.usuario} | Expira: ${demoExp.toISOString()}`)
    userStates.delete(phoneNumber)
    return `✅✅ *¡TU PRUEBA GRATIS ESTÁ LISTA!*\n\n┌───────────────\n👤 Usuario: *${iptvData.usuario}*\n🔐 Contraseña: *${iptvData.password}*\n└───────────────\n\n⏱️ La prueba gratuita tiene una duración de 3 horas y comienza cuando ingreses a la aplicación.\n\n📲 Si necesitas ayuda para instalar:\n\n2️⃣ Guía de instalación\n0️⃣ Volver al menú`
  } catch (error: any) {
    userStates.delete(phoneNumber)
    console.error('❌ Error creando demo:', error?.message ?? error)
    return `⚠️ *NO SE PUDO CREAR LA PRUEBA GRATIS*\n\nOcurrió un problema temporal al generar tu acceso.\n\n⏳ Por favor intenta más tarde.\n\n📞 Si el problema continúa, contacta soporte:\n64598912\n\n0️⃣ Volver al menú`
  } finally {
    finalizarProcesoCritico(from)
  }
}

async function handleFreeTrial(sock: WASocket, from: string, phoneNumber: string, existingDemoUser: any): Promise<void> {
  const demosEnabled = await isDemosEnabled()
  if (!demosEnabled) {
    await sendMsg(sock, from, {
      text:
        `🔴 *PRUEBAS GRATIS NO DISPONIBLES*\n\n` +
        `Debido a la alta demanda durante eventos deportivos en vivo, las pruebas gratuitas están temporalmente deshabilitadas.\n\n` +
        `📺 Por el momento el servicio está disponible solo por suscripción.\n\n` +
        `━━━━━━━━━━━━━━━━━━\n\n` +
        `4️⃣ Ver planes y suscribirme\n` +
        `0️⃣ Volver al menú`
    }); return
  }
  if (existingDemoUser) {
    userStates.set(phoneNumber, 'demo_activate_offer')
    await sendMsg(sock, from, {
      text:
        `🎁 *TU ACCESO DE PRUEBA*\n\n` +
        `┌───────────────\n` +
        `👤 Usuario: *${existingDemoUser.usuario}*\n` +
        `🔑 Contraseña: *${existingDemoUser.password}*\n` +
        `└───────────────\n\n` +
        `⏱️ La prueba gratuita dura *3 horas*\n` +
        `⚠️ Disponible solo una vez por usuario\n\n` +
        `━━━━━━━━━━━━━━━━━━\n\n` +
        `1️⃣ Activar esta cuenta\n` +
        `4️⃣ Crear cuenta nueva\n` +
        `0️⃣ Volver al menú`
    }); return
  }
  userStates.set(phoneNumber, 'waiting_name_for_demo')
  await sendMsg(sock, from, { text: `🎁 *PRUEBA GRATIS — 3 HORAS*\n\nVamos a crear tu acceso gratuito 👇\n\n✍️ Escribe tu nombre` })
}

// =============================================
// MENÚS Y GUÍAS
// =============================================
async function getInfoAndPrices(sock: WASocket, from: string, tieneCuenta = false): Promise<void> {
  if (tieneCuenta) {
    const opciones = `3️⃣ 📺 Mi cuenta MasTV\n0️⃣ Volver al menú principal`
    try {
      const fs = await import('fs')
      if (fs.existsSync('./recursos/img.png')) {
        await sendMsg(sock, from, { image: fs.readFileSync('./recursos/img.png'), caption: `💵 PLANES Y PRECIOS 👆\n\n${opciones}` })
        return
      }
    } catch {}
    await sendMsg(sock, from, { text: opciones })
    return
  }

  try {
    const fs = await import('fs')
    if (fs.existsSync('./recursos/img.png')) {
      await sendMsg(sock, from, { image: fs.readFileSync('./recursos/img.png'), caption: '💵 PLANES Y PRECIOS 👆' })
      await new Promise(r => setTimeout(r, 1000))
    }
  } catch {}
  await sendMsg(sock, from, {
    text:
      `🔥🎬 MASTV – Todo el entretenimiento en un solo lugar 🎬🔥\n\n` +
      `Con *MASTV* tienes TODO en un solo lugar:\n\n` +
      `🏆 Liga Boliviana en vivo\n` +
      `🌎 Mundial, Champions, Libertadores y Sudamericana\n` +
      `🏀 NBA en vivo\n` +
      `🥊 UFC, WWE y Fórmula 1\n` +
      `🎬 Películas, series y TV en vivo 24/7\n` +
      `📺 Novelas, Dramabox y contenido exclusivo\n` +
      `🇧🇴 Canales nacionales de Bolivia\n` +
      `🔞 Contenido adulto (+18) opcional\n\n` +
      `📱 Funciona en TODO:\n` +
      `Celular • Smart TV • TV Box • PC\n\n` +
      `⚡ Activa HOY mismo y empieza a ver al instante\n` +
      `💸 Planes accesibles y sin complicaciones\n\n` +
      `👉 Elige una opción:\n\n` +
      `  2️⃣ Ver guía de instalación\n  3️⃣ 🎁 Solicitar prueba GRATIS\n  4️⃣ 🚀 Activar mi cuenta\n  0️⃣ Volver al menú principal`
  })
}

function getSubscriptionMenu(): string {
  return `💵 *Planes MASTV*\n\n👉 Escribe el precio del plan que deseas.\nEjemplo: *29* para 1 Mes - 1 Dispositivo\n\n📺 *1 DISPOSITIVO*\n▫️ 29 → 1 Mes\n▫️ 82 → 3 Meses\n▫️ 155 → 6 Meses + 1 Mes 🎁\n▫️ 300 → 12 Meses + 2 Meses 🎁\n\n📺 *2 DISPOSITIVOS*\n▫️ 35 → 1 Mes\n▫️ 100 → 3 Meses\n▫️ 190 → 6 Meses + 1 Mes 🎁\n▫️ 380 → 12 Meses + 2 Meses 🎁\n\n📺 *3 DISPOSITIVOS*\n▫️ 40 → 1 Mes\n▫️ 115 → 3 Meses\n▫️ 225 → 6 Meses + 1 Mes 🎁\n▫️ 440 → 12 Meses + 2 Meses 🎁\n\n━━━━━━━━━━━━━━━━━━\n0️⃣ Menú principal`
}

function getPlanesTextoFallback(dispositivos: number): string {
  const t: Record<number, string> = {
    1: `📺 *1 DISPOSITIVO*\n▫️ 29 → 1 Mes\n▫️ 82 → 3 Meses\n▫️ 155 → 6 Meses + 1 Mes 🎁\n▫️ 300 → 12 Meses + 2 Meses 🎁`,
    2: `📺 *2 DISPOSITIVOS*\n▫️ 35 → 1 Mes\n▫️ 100 → 3 Meses\n▫️ 190 → 6 Meses + 1 Mes 🎁\n▫️ 380 → 12 Meses + 2 Meses 🎁`,
    3: `📺 *3 DISPOSITIVOS*\n▫️ 40 → 1 Mes\n▫️ 115 → 3 Meses\n▫️ 225 → 6 Meses + 1 Mes 🎁\n▫️ 440 → 12 Meses + 2 Meses 🎁`,
  }
  return t[dispositivos] ?? getSubscriptionMenu()
}

async function sendPlanesImagen(sock: WASocket, from: string, dispositivos: number | 'all', opciones: string): Promise<void> {
  const imgMap: Record<string, string> = {
    all: './recursos/allPlan.png',
    '1': './recursos/onePlan.png',
    '2': './recursos/twoPlan.png',
    '3': './recursos/threePlan.png',
  }
  const key = dispositivos === 'all' ? 'all' : String(dispositivos)
  const imgPath = imgMap[key]
  try {
    const { readFileSync, existsSync } = await import('fs')
    if (existsSync(imgPath)) {
      await sendMsg(sock, from, { image: readFileSync(imgPath), caption: opciones })
      return
    }
  } catch {}
  // fallback texto
  const planesTexto = dispositivos === 'all' ? getSubscriptionMenu() : getPlanesTextoFallback(dispositivos as number)
  await sendMsg(sock, from, { text: `${planesTexto}\n\n━━━━━━━━━━━━━━━━━━\n${opciones}` })
}

async function sendResellerInfo(sock: WASocket, from: string): Promise<void> {
  try {
    const fs = await import('fs')
    if (fs.existsSync('./recursos/img4.png')) {
      await sendMsg(sock, from, { image: fs.readFileSync('./recursos/img4.png'), caption: 'PRECIO DE CREDITOS' })
      await new Promise(r => setTimeout(r, 800))
    }
    if (fs.existsSync('./recursos/img5.png')) {
      await sendMsg(sock, from, { image: fs.readFileSync('./recursos/img5.png'), caption: '💰PRECIO CLIENTE FINAL ' })
      await new Promise(r => setTimeout(r, 800))
    }
  } catch (e: any) {
    console.error('Error enviando imágenes reseller:', e.message)
  }

  await sendMsg(sock, from, {
    text:
      `📢 *SISTEMA DE REVENTA MASTV*\n\n` +
      `MASTV trabaja con un sistema de créditos que te permite crear y renovar cuentas IPTV para tus clientes.\n\n` +
      `📺 *USO DE CRÉDITOS*\n` +
      `🟡 Crear cuenta 1 dispositivo / 1 mes → *0.50 créditos*\n` +
      `🔵 Crear cuenta 2 dispositivos / 1 mes → *0.75 créditos*\n` +
      `🟢 Crear cuenta 3 dispositivos / 1 mes → *1 crédito*\n\n` +
      `🎁 *DEMOS*\n` +
     `Puedes generar demos ilimitados para pruebas (solo para mostrar el servicio).\n\n` +
      `💰 *EJEMPLO DE GANANCIA*\n` +
      `Compra de crédito: *18 Bs*\n` +
      `Venta de 1 cuenta: *40 Bs*\n\n` +
      `🚨 *REGLAS OBLIGATORIAS*\n` +
      `▪️ Debes respetar los precios mínimos\n` +
      `▪️ PROHIBIDO vender más barato\n\n` +
      `⚠️ *Si incumples:*\n` +
      `▪️ Pierdes créditos\n` +
      `▪️ Se bloquea tu cuenta\n` +
      `▪️ Pierdes clientes\n` +
      `▪️ Baneo permanente sin aviso\n\n` +
      `🚫 *SIN EXCEPCIONES*\n` +
      `No hay devoluciones ni reclamos.\n\n` +
      `⚖️ *¿POR QUÉ SE TRABAJA ASÍ?*\n` +
      `Para mantener igualdad entre revendedores y evitar que alguien dañe el mercado bajando precios.\n\n` +
      `📲 ¿Te interesa unirte?\n\n` +
      `7️⃣ Hablar con soporte\n` +
      `0️⃣ Volver al Menú`
  })
}

function getResellerInfo(): string {
  return ''
}

// ── Enlace al grupo de WhatsApp comunitario (editar aquí) ──
const GRUPO_WHATSAPP_LINK = 'https://chat.whatsapp.com/HLYHIzvJsKC3xmO6jduQc5'

async function sendCommunityInfo(sock: WASocket, from: string): Promise<void> {
  try {
    const fs = await import('fs')
    const mediaFiles = [
      './recursos/comunidad1.jpg',
      './recursos/comunidad2.jpg',
      './recursos/comunidad3.jpg',
      './recursos/comunidad1.mp4',
      './recursos/comunidad2.mp4',
    ]
    for (const filePath of mediaFiles) {
      if (fs.existsSync(filePath)) {
        const ext = filePath.split('.').pop()?.toLowerCase()
        if (ext === 'mp4' || ext === 'mov') {
          await sendMsg(sock, from, { video: fs.readFileSync(filePath), caption: '' })
        } else {
          await sendMsg(sock, from, { image: fs.readFileSync(filePath), caption: '' })
        }
        await new Promise(r => setTimeout(r, 800))
      }
    }
  } catch (e: any) {
    console.error('Error enviando media comunidad:', e.message)
  }

  await sendMsg(sock, from, {
    text:
      `🌐 *COMUNIDAD MASTV*\n\n` +
      `Mantente informado sobre:\n\n` +
      `⚽ Eventos deportivos en vivo\n` +
      `🥊 UFC • WWE • Boxeo\n` +
      `🏀 NBA • Fórmula 1\n` +
      `📢 Novedades y actualizaciones\n\n` +
      `━━━━━━━━━━━━━━━━━━\n\n` +
      `👉 Únete al grupo oficial:\n\n${GRUPO_WHATSAPP_LINK}\n\n` +
      `━━━━━━━━━━━━━━━━━━\n\n` +
      `0️⃣ Volver al Menú`
  })
}


function getAdvisorContact(): string {
  return `🛠 *SOPORTE TÉCNICO*\n\nSi presentas algún problema con el servicio:\n\n✍️ Escríbenos o envíanos una foto 📸 o video 🎥 del inconveniente.\n\n📞 Soporte: *64598912*\n\n━━━━━━━━━━━━━━━━━━\n\n0️⃣ Volver al Menú`
}

function getInstallationGuide(): string {
  return `📲 *GUÍA DE INSTALACIÓN MASTV*\n\nInstala MasTV fácilmente en tu dispositivo 👇\n\n🅰️ 📦 TV-Android / TV Box\n🅱️ 📺 Smart TV (Samsung / LG)\n🅲️ 📱 Celular Android / Tablet\n🅳️ 🍎 iPhone / iPad\n🅴️ 💻 PC o Laptop\n\n✍️ Escribe la letra de tu dispositivo\n\n0️⃣ Volver al menú principal`
}

function estadoDesdeDate(expira: Date): string {
  const ahora = new Date()
  const hoyUTC = Date.UTC(ahora.getUTCFullYear(), ahora.getUTCMonth(), ahora.getUTCDate())
  const expiraUTC = Date.UTC(expira.getUTCFullYear(), expira.getUTCMonth(), expira.getUTCDate())
  const diffDias = Math.round((expiraUTC - hoyUTC) / (1000 * 60 * 60 * 24))
  const fc = fechaCorta(expira)
  if (diffDias < -1) return `⚠️ Expiró el *${fc}*`
  if (diffDias <= 0) return `📅 Expira: *${fc}*`
  if (diffDias <= 5) return `🟡 Expira en *${diffDias} día${diffDias !== 1 ? 's' : ''}* – *${fc}*`
  return `📅 Expira: *${fc}*`
}

async function mostrarMisCuentas(sock: WASocket, from: string, cuentas: any[]): Promise<void> {
  const ahora = new Date()
  const lineas = cuentas.map((u, i) => {
    const expira = u.expiresAt ? new Date(u.expiresAt) : null
    const vigente = expira && ahora < expira
    const estadoLine = expira ? estadoDesdeDate(expira) : '📅 Sin fecha de expiración'
    const icono = vigente ? '🟢' : '🔴'
    const planMatch = (u.plan || '').match(/^(\d+) Dispositivos?\s*–\s*(.+)$/)
    const planLinea = planMatch
      ? `📦 Plan: *${planMatch[2]}*\n📺 Dispositivos: *${planMatch[1]}*`
      : `📦 Plan: *${u.plan || '-'}*`
    return (
      `${icono} *Cuenta ${cuentas.length > 1 ? i + 1 : ''}*\n` +
      `┌───────────────\n` +
      `👤 Usuario: *${u.usuario}*\n` +
      `🔐 Contraseña: *${u.password || '-'}*\n` +
      `${planLinea}\n` +
      `${estadoLine}\n` +
      `└───────────────`
    )
  }).join('\n\n')

  const tieneAdultos = cuentas.some(u => u.adultChannels)
  const labelAdultos = tieneAdultos
    ? `8️⃣ Desactivar canales adultos (+18)\n`
    : `8️⃣ Activar canales adultos (+18)\n`

  await sendMsg(sock, from, {
    text:
      `📺 *MIS CUENTAS MASTV*\n\n${lineas}\n\n` +
      `4️⃣ Nueva cuenta\n` +
      `5️⃣ Renovar cuenta\n` +
      labelAdultos +
      `0️⃣ Menú`
  })
}

function getMainMenu(existingUser: any, existingOfficialUsers: any[] = []): string {
  const nombre = existingUser ? `Bienvenido de nuevo *${primerNombre(existingUser.nombre)}*` : 'Bienvenido a *MasTV*'
  if (existingOfficialUsers.length > 0) {
    return `👋 ${nombre}\n\n📋 *MENÚ MASTV*\n\n1️⃣ Información y precios\n2️⃣ Guía de instalación\n3️⃣ 📺 Mi cuenta MasTV\n6️⃣ 🌐 Comunidad\n7️⃣ 🛠 Soporte técnico\n\n👉 Responde con un número`
  }
  return `👋 ${nombre}\n\n📋 *MENÚ MASTV*\n\n1️⃣ Ver planes y precios\n2️⃣ Guía de instalación\n3️⃣ 🎁 Prueba GRATIS por 3 horas\n4️⃣ 📺 Activar mi cuenta ahora\n6️⃣ 💼 Quiero vender MasTV\n7️⃣ 🛠 Hablar con soporte\n\n👉 Responde con un número`
}

function bloqueCredenciales(existingUser: any, conNombre = false): string {
  if (!existingUser) {
    return `📌 *¿No tienes cuenta todavía?*\n\n3️⃣ Prueba GRATIS\n4️⃣ Activar cuenta`
  }
  const us = existingUser.usuario
  const pw = existingUser.password
  const n = primerNombre(existingUser.nombre).toLowerCase()
  if (conNombre) {
    return `┌───────────────\n🧾 Nombre: *${n}*\n👤 Usuario: *${us}*\n🔑 Contraseña: *${pw}*\n└───────────────`
  }
  return `┌───────────────\n👤 Usuario: *${us}*\n🔑 Contraseña: *${pw}*\n└───────────────`
}

async function sendInstallationGuideAndroid(sock: WASocket, from: string, existingUser: any): Promise<void> {
  try { const fs = await import('fs'); if (fs.existsSync('./recursos/android.mp4')) { await sendMsg(sock, from, { video: fs.readFileSync('./recursos/android.mp4') }); await new Promise(r => setTimeout(r, 1500)) } } catch {}
  await sendMsg(sock, from, {
    text:
      `📱 *INSTALACIÓN EN CELULAR ANDROID / TABLET*\n\n` +
      `Tienes varias formas de descargar la aplicación 👇\n\n` +
      `🔹 *Play Store*\n` +
      `👉 https://play.google.com/store/apps/details?id=com.tv222aaa.aaa_mobile\n\n` +
      `🔹 *Play Store (Alternativa)*\n` +
      `👉 https://play.google.com/store/apps/details?id=com.apksrebrand.smarters.mastv\n\n` +
      `🔹 *Descarga directa APK*\n` +
      `👉 https://bit.ly/mastviptv\n` +
      `👉 https://123.bo/a\n\n` +
      `━━━━━━━━━━━━━━━━━━\n\n` +
      `📲 *Luego de instalar:*\n\n` +
      `✅ Abre la aplicación\n` +
      `✅ Selecciona: *MOBILE*\n` +
      `✅ Ingresa tus datos:\n\n` +
      `${bloqueCredenciales(existingUser)}\n\n` +
      `0️⃣ Volver al menú`
  })
}

async function sendInstallationGuideIPhone(sock: WASocket, from: string, existingUser: any): Promise<void> {
  try { const fs = await import('fs'); if (fs.existsSync('./recursos/iphoneimg.jpg')) { await sendMsg(sock, from, { image: fs.readFileSync('./recursos/iphoneimg.jpg') }); await new Promise(r => setTimeout(r, 1500)) } } catch {}
  if (!existingUser) {
    await sendMsg(sock, from, {
      text:
        `🍎 *INSTALACIÓN EN iPHONE / iPAD*\n\n` +
        `Descarga una de estas aplicaciones 👇\n\n` +
        `🔹 *IPTV Stream Player*\n` +
        `👉 https://bit.ly/iphone-iptv-stream-player\n\n` +
        `🔹 *VU IPTV Player*\n` +
        `👉 https://bit.ly/iphone-vu-iptv-player\n\n` +
        `━━━━━━━━━━━━━━━━━━\n\n` +
        `${bloqueCredenciales(null)}\n\n` +
        `0️⃣ Volver al menú`
    })
    return
  }
  const us = existingUser.usuario
  const pw = existingUser.password
  const n = primerNombre(existingUser.nombre).toLowerCase()
  await sendMsg(sock, from, {
    text:
      `🍎 *INSTALACIÓN EN iPHONE / iPAD*\n\n` +
      `🔹 *IPTV Stream Player*\n` +
      `👉 https://bit.ly/iphone-iptv-stream-player\n\n` +
      `┌───────────────\n` +
      `👤 Usuario: *${us}*\n` +
      `🔑 Contraseña: *${pw}*\n` +
      `🌐 URL: *http://mtv.bo:80*\n` +
      `└───────────────\n\n` +
      `══════════════════\n\n` +
      `🔹 *VU IPTV Player*\n` +
      `👉 https://bit.ly/iphone-vu-iptv-player\n\n` +
      `┌───────────────\n` +
      `🧾 Nombre: *${n}*\n` +
      `👤 Usuario: *${us}*\n` +
      `🔑 Contraseña: *${pw}*\n` +
      `🌐 URL: *http://mtv.bo:80*\n` +
      `└───────────────\n\n` +
      `0️⃣ Volver al menú`
  })
}

async function sendInstallationGuideSmartTV(sock: WASocket, from: string, existingUser: any): Promise<void> {
  try { const fs = await import('fs'); if (fs.existsSync('./recursos/smart.mp4')) { await sendMsg(sock, from, { video: fs.readFileSync('./recursos/smart.mp4') }); await new Promise(r => setTimeout(r, 1500)) } } catch {}
  await sendMsg(sock, from, {
    text:
      `📺 *INSTALACIÓN EN SMART TV (Samsung / LG)*\n\n` +
      `📲 Abre la tienda de aplicaciones de tu TV y descarga:\n\n` +
      `🔹 *IPTV Smarters Pro*\n\n` +
      `━━━━━━━━━━━━━━━━━━\n\n` +
      `✅ Luego abre la aplicación\n` +
      `✅ Ingresa tus datos:\n\n` +
      (existingUser
        ? `┌───────────────\n🧾 Nombre: *${primerNombre(existingUser.nombre).toLowerCase()}*\n👤 Usuario: *${existingUser.usuario}*\n🔑 Contraseña: *${existingUser.password}*\n🌐 URL: *vivetv.net*\n└───────────────`
        : bloqueCredenciales(null)) +
      `\n\n0️⃣ Volver al menú`
  })
}

async function sendInstallationGuideTVBox(sock: WASocket, from: string, existingUser: any): Promise<void> {
  try { const fs = await import('fs'); if (fs.existsSync('./recursos/playstore.mp4')) { await sendMsg(sock, from, { video: fs.readFileSync('./recursos/playstore.mp4'), caption: '📦 *INSTALACION DESDE PLAY STORE*' }); await new Promise(r => setTimeout(r, 1500)) } } catch {}
  await sendMsg(sock, from, {
    text:
      `📦 *INSTALACIÓN EN TV-ANDROID / TV BOX*\n\n` +
      `Tienes varias formas de instalar la aplicación 👇\n\n` +
      `🔹 *Play Store*\n` +
      `🔍 Busca: *Mastv Player* 📺\n\n` +
      `🔹 *Downloader*\n` +
      `Código: *223062*\n` +
      `Código alternativo: *123.bo/a*\n\n` +
      `🔹 *Descarga por navegador*\n` +
      `👉 https://123.bo/a\n` +
      `👉 Alternativo: https://bit.ly/mastviptv\n\n` +
      `━━━━━━━━━━━━━━━━━━\n\n` +
      `📲 *Luego de instalar:*\n\n` +
      `✅ Abre la aplicación\n` +
      `✅ Selecciona: *TV*\n\n` +
      `${bloqueCredenciales(existingUser)}\n\n` +
      `0️⃣ Volver al menú`
  })
}

async function sendInstallationGuidePC(sock: WASocket, from: string, existingUser: any): Promise<void> {
  try { const fs = await import('fs'); if (fs.existsSync('./recursos/pc.mp4')) { await sendMsg(sock, from, { video: fs.readFileSync('./recursos/pc.mp4') }); await new Promise(r => setTimeout(r, 1500)) } } catch {}
  await sendMsg(sock, from, {
    text:
      `💻 *INSTALACIÓN EN PC / LAPTOP*\n\n` +
      `Descarga la aplicación 👇\n\n` +
      `🔹 *FULLTVMAS*\n` +
      `👉 https://bit.ly/mastvpc\n\n` +
      `━━━━━━━━━━━━━━━━━━\n\n` +
      `📲 *Luego de instalar:*\n\n` +
      `✅ Abre la aplicación\n` +
      `✅ Ingresa tus datos:\n\n` +
      `${bloqueCredenciales(existingUser, true)}\n\n` +
      `0️⃣ Volver al menú`
  })
}

// =============================================
// MAPA DE PLANES
// =============================================
const PLANES_MAP: { [key: string]: { dispositivos: number, duracion: string, precio: number, creditos: number, bonus?: string } } = {
  '29':  { dispositivos: 1, duracion: '1 Mes',    precio: 29,  creditos: 0.5  },
  '82':  { dispositivos: 1, duracion: '3 Meses',  precio: 82,  creditos: 1.5  },
  '155': { dispositivos: 1, duracion: '6 Meses',  precio: 155, creditos: 3,   bonus: '+ 1 Mes 🎁' },
  '300': { dispositivos: 1, duracion: '12 Meses', precio: 300, creditos: 6,   bonus: '+ 2 Meses 🎁' },
  '35':  { dispositivos: 2, duracion: '1 Mes',    precio: 35,  creditos: 0.75 },
  '100': { dispositivos: 2, duracion: '3 Meses',  precio: 100, creditos: 2.25 },
  '190': { dispositivos: 2, duracion: '6 Meses',  precio: 190, creditos: 4.5, bonus: '+ 1 Mes 🎁' },
  '380': { dispositivos: 2, duracion: '12 Meses', precio: 380, creditos: 9,   bonus: '+ 2 Meses 🎁' },
  '40':  { dispositivos: 3, duracion: '1 Mes',    precio: 40,  creditos: 1    },
  '115': { dispositivos: 3, duracion: '3 Meses',  precio: 115, creditos: 3    },
  '225': { dispositivos: 3, duracion: '6 Meses',  precio: 225, creditos: 6,   bonus: '+ 1 Mes 🎁' },
  '440': { dispositivos: 3, duracion: '12 Meses', precio: 440, creditos: 12,  bonus: '+ 2 Meses 🎁' },
}

//este arvchivo es messageHandler.ts