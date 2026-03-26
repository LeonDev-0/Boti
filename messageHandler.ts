import { WASocket } from '@whiskeysockets/baileys'
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
}

const pagosPendientes = new Map<string, PagoPendiente>()
const QR_VIGENCIA_MS = 30 * 60 * 1000

let sockGlobal: WASocket | null = null

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
    if (res.Codigo === 0) return res.Data
    console.error('Error generando QR:', res.Mensaje)
    return null
  } catch (e: any) {
    console.error('Error generando QR:', e.message)
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
// FIX: FORMATEAR EXPIRACIÓN CON DÍAS RELATIVOS
// =============================================
function formatarExpiracion(expiraStr: string): string {
  if (!expiraStr) return 'Expira: (desconocido)'

  let fecha: Date | null = null

  // Formato DD/MM/YYYY
  const matchDMY = expiraStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/)
  if (matchDMY) {
    fecha = new Date(parseInt(matchDMY[3]), parseInt(matchDMY[2]) - 1, parseInt(matchDMY[1]))
  }

  // Formato YYYY-MM-DD
  const matchYMD = expiraStr.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (!fecha && matchYMD) {
    fecha = new Date(parseInt(matchYMD[1]), parseInt(matchYMD[2]) - 1, parseInt(matchYMD[3]))
  }

  // Formato DD-MM-YYYY
  const matchDMY2 = expiraStr.match(/^(\d{1,2})-(\d{1,2})-(\d{4})/)
  if (!fecha && matchDMY2) {
    fecha = new Date(parseInt(matchDMY2[3]), parseInt(matchDMY2[2]) - 1, parseInt(matchDMY2[1]))
  }

  if (!fecha || isNaN(fecha.getTime())) {
    // No se pudo parsear, mostrar tal cual
    return `Expira: ${expiraStr}`
  }

  const ahora = new Date()
  const hoy = new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate())
  const fechaExpira = new Date(fecha.getFullYear(), fecha.getMonth(), fecha.getDate())
  const diffMs = fechaExpira.getTime() - hoy.getTime()
  const diffDias = Math.round(diffMs / (1000 * 60 * 60 * 24))

  if (diffDias < 0) {
    const diasVencido = Math.abs(diffDias)
    return `⚠️ *Expiró hace ${diasVencido} día${diasVencido !== 1 ? 's' : ''}* (${fecha.toLocaleDateString('es-BO')})`
  } else if (diffDias === 0) {
    return `🔴 *Expira HOY* (${fecha.toLocaleDateString('es-BO')})`
  } else if (diffDias <= 5) {
    return `🟡 Expira en *${diffDias} día${diffDias !== 1 ? 's' : ''}* (${fecha.toLocaleDateString('es-BO')})`
  } else {
    return `📅 Expira: ${fecha.toLocaleDateString('es-BO')} (en ${diffDias} días)`
  }
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
  setInterval(async () => {
    if (pagosPendientes.size === 0 || !sockGlobal) return

    const verificaciones = Array.from(pagosPendientes.entries()).map(async ([movimiento_id, pago]) => {
      pago.intentos++

      if (pago.intentos > 120) {
        pagosPendientes.delete(movimiento_id)
        userStates.delete(pago.phoneNumber)
        await enviar(pago.jid, '⏰ Tu QR de pago expiró (30 minutos). Escribe el precio de tu plan nuevamente para generar uno nuevo.')
        return
      }

      try {
        const estado = await verificarEstadoQR(parseInt(movimiento_id))
        pago.fallos = 0

        if (estado === 'Completado') {
          pagosPendientes.delete(movimiento_id)
          userStates.delete(pago.phoneNumber)

          await enviar(pago.jid,
            `✅ *Pago QR recibido*\n\n` +
            `⏳ Estamos ${pago.tipo === 'renovacion' ? 'renovando tu cuenta' : 'creando tu cuenta'}... espera un momento.`
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
      }
    })

    await Promise.allSettled(verificaciones)
  }, 15000)
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
  const qrActivo = obtenerQRActivo(phoneNumber)

  if (qrActivo) {
    const [mov_id, pagoPrevio] = qrActivo
    const restanteMs = pagoPrevio.vigenciaMs - (Date.now() - pagoPrevio.generadoEn)

    if (pagoPrevio.precio === precio) {
      console.log(`♻️ Reenviando QR ${mov_id} a ${phoneNumber} (${formatarTiempoRestante(restanteMs)} restantes)`)
      const etiquetaTipo = pagoPrevio.tipo === 'renovacion' ? '🔄 *Renovación de cuenta*' : '🆕 *Cuenta nueva*'
      await sock.sendMessage(from, {
        image: Buffer.from(pagoPrevio.qrBase64, 'base64'),
        caption:
          `♻️ *QR DE PAGO ACTIVO*\n` +
          `${etiquetaTipo}\n\n` +
          `📦 *Plan:* ${PLANES_MAP[precio]?.dispositivos} Dispositivo${(PLANES_MAP[precio]?.dispositivos ?? 1) > 1 ? 's' : ''} – ${PLANES_MAP[precio]?.duracion}\n` +
          `💰 *Monto:* Bs. ${monto.toFixed(2)}\n\n` +
          `⏳ *Tiempo restante:* ${formatarTiempoRestante(restanteMs)}\n\n` +
          `📲 Escanea el QR y realiza el pago\n\n` +
          `⚠️ *No envíes comprobante*\n` +
          `✅ El sistema reconoce tu pago automáticamente\n\n` +
          `👉 0️⃣ Volver al menú principal`
      })
      return
    } else {
      console.log(`🔄 Cambiando plan: cancelando QR ${mov_id} de ${pagoPrevio.precio} → nuevo de ${precio}`)
      cancelarQRDelUsuario(phoneNumber)
      await sock.sendMessage(from, { text: `🔄 *Cambio de plan detectado*\nCancelando QR anterior y generando nuevo por *Bs. ${monto.toFixed(2)}*...` })
    }
  } else {
    await sock.sendMessage(from, { text: `⏳ Generando QR de pago por *Bs. ${monto.toFixed(2)}*...` })
  }

  iniciarProcesoCritico(from)
  let qrData: { movimiento_id: number, qr: string } | null = null
  try {
    qrData = await generarQR(monto)
  } finally {
    finalizarProcesoCritico(from)
  }

  if (!qrData) {
    await sock.sendMessage(from, { text: '❌ No se pudo generar el QR de pago. Por favor intenta nuevamente o contacta soporte: *64598912*' })
    return
  }

  const { movimiento_id, qr } = qrData
  const generadoEn = Date.now()

  const labelTipo = tipo === 'renovacion' ? '🔄 *Renovación de cuenta*' : '🆕 *Cuenta nueva*'
  await sock.sendMessage(from, {
    image: Buffer.from(qr, 'base64'),
    caption:
      `💳 *QR DE PAGO MASTV*\n` +
      `${labelTipo}\n\n` +
      `📦 *Plan:* ${PLANES_MAP[precio]?.dispositivos} Dispositivo${(PLANES_MAP[precio]?.dispositivos ?? 1) > 1 ? 's' : ''} – ${PLANES_MAP[precio]?.duracion}\n` +
      `💰 *Monto:* Bs. ${monto.toFixed(2)}\n\n` +
      `📲 Escanea el QR y realiza el pago\n\n` +
      `⚠️ *No envíes comprobante*\n` +
      `✅ El sistema reconoce tu pago automáticamente\n\n` +
      `⏳ Válido por *30 minutos*\n` +
      `🚀 Tu cuenta se activará de inmediato\n\n` +
      `👉 0️⃣ Volver al menú principal`
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
  })

  console.log(`💳 QR generado: movimiento ${movimiento_id} | Bs. ${monto} | ${tipo} | ${phoneNumber} | válido 30 min`)
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

    const iptvData = await crearUsuarioIPTV(planPuppeteer)
    const expiresAt = new Date()
    expiresAt.setMonth(expiresAt.getMonth() + meses)
    const planCompleto = plan.bonus
      ? `${plan.dispositivos} Dispositivo${plan.dispositivos > 1 ? 's' : ''} – ${plan.duracion} ${plan.bonus}`
      : `${plan.dispositivos} Dispositivo${plan.dispositivos > 1 ? 's' : ''} – ${plan.duracion}`

    const userActual = await prisma.user.findFirst({ where: { celular: phoneNumber } })
    if (userActual) {
      await prisma.user.update({ where: { id: userActual.id }, data: { nombre, usuario: iptvData.usuario, password: iptvData.password, plan: planCompleto, expiresAt } })
    } else {
      await prisma.user.create({ data: { nombre, usuario: iptvData.usuario, password: iptvData.password, celular: phoneNumber, plan: planCompleto, expiresAt } })
    }

    await enviar(jid,
      `✅ *CUENTA ACTIVADA*\n\n` +
      `🎉 Bienvenido ${nombre}\n\n` +
      `┌───────────────\n` +
      `👤 Usuario: ${iptvData.usuario}\n` +
      `🔐 Contraseña: ${iptvData.password}\n` +
      `└───────────────\n\n` +
      `📦 Plan: ${planCompleto}\n` +
      `📅 Expira: ${expiresAt.toLocaleDateString('es-BO')}\n\n` +
      `0️⃣ Menu`
    )
  } catch (e: any) {
    console.error('Error procesando cuenta nueva:', e.message)
    await enviar(jid, '⚠️ Tu pago fue recibido pero hubo un error al crear tu cuenta.\n\nPor favor contacta a soporte: *64598912* indicando que ya realizaste el pago.')
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

    const { renovarUsuarioIPTV } = await import('./iptvservice.js')
    await renovarUsuarioIPTV(usuarioIPTV, planPuppeteer)

    const expiresAt = new Date()
    expiresAt.setMonth(expiresAt.getMonth() + meses)
    const planCompleto = plan.bonus
      ? `${plan.dispositivos} Dispositivo${plan.dispositivos > 1 ? 's' : ''} – ${plan.duracion} ${plan.bonus}`
      : `${plan.dispositivos} Dispositivo${plan.dispositivos > 1 ? 's' : ''} – ${plan.duracion}`

    await prisma.user.update({ where: { id: existingUserId }, data: { plan: planCompleto, expiresAt } })

    const userRecord = await prisma.user.findUnique({ where: { id: existingUserId } })

    await enviar(jid,
      `✅ *RENOVACIÓN EXITOSA*\n\n` +
      `🎉 Tu cuenta ha sido renovada\n\n` +
      `┌───────────────\n` +
      `👤 Usuario: ${usuarioIPTV}\n` +
      `🔐 Contraseña: ${userRecord?.password || '(ver datos anteriores)'}\n` +
      `└───────────────\n\n` +
      `📦 Plan: ${planCompleto}\n` +
      `📅 Expira: ${expiresAt.toLocaleDateString('es-BO')}\n\n` +
      `0️⃣ *Volver al Menu*`
    )
  } catch (e: any) {
    console.error('Error procesando renovación:', e.message)
    await enviar(jid, '⚠️ Tu pago fue recibido pero hubo un error al renovar tu cuenta.\n\nPor favor contacta a soporte: *64598912* indicando que ya realizaste el pago.')
  } finally {
    finalizarProcesoCritico(jid)
  }
}

// =============================================
// FUNCIONES AUXILIARES
// =============================================
export function cleanPhoneNumber(jid: string): string {
  let number = jid.replace('@s.whatsapp.net', '').replace('@c.us', '').replace('@lid', '').split(':')[0]
  if (number.startsWith('591')) number = number.substring(3)
  console.log(`🔍 Número original: ${jid} → Número limpio: ${number}`)
  return number
}

function isValidName(nombre: string): boolean {
  if (nombre.trim().length < 4) return false
  return /^[a-záéíóúñA-ZÁÉÍÓÚÑ ]+$/.test(nombre.trim())
}

function cleanPuppeteerText(text: string): string {
  if (!text) return text
  return text.replace(/\s*-\s*Costo:/gi, '').replace(/\s+\d+(\.\d+)?\s+creditos?\.?/gi, '').trim()
}

async function isDemosEnabled(): Promise<boolean> {
  try {
    const config = await prisma.config.findUnique({ where: { key: 'demos_enabled' } })
    if (!config) { await prisma.config.create({ data: { key: 'demos_enabled', value: 'true' } }); return true }
    return config.value === 'true'
  } catch { return true }
}

async function setDemosEnabled(enabled: boolean): Promise<void> {
  await prisma.config.upsert({
    where: { key: 'demos_enabled' },
    update: { value: enabled ? 'true' : 'false' },
    create: { key: 'demos_enabled', value: enabled ? 'true' : 'false' }
  })
}

function hasActiveOfficialAccount(user: any): boolean {
  if (!user || !user.plan) return false
  if (user.plan.includes('DEMO')) return false
  return new Date() <= new Date(user.expiresAt)
}

function isPlanPrice(input: string): boolean {
  return Object.prototype.hasOwnProperty.call(PLANES_MAP, input)
}

// =============================================
// MANEJADOR INTERNO
// =============================================
async function _handleMessage(sock: WASocket, msg: any): Promise<void> {
  if (!msg) return
  if (msg.key.fromMe) return

  setSock(sock)

  const from: string | undefined = msg.key.remoteJid
  const rawPhoneNumber: string | undefined = msg.key.remoteJidAlt || msg.key.remoteJid

  if (!from || !rawPhoneNumber) return
  if (from.endsWith('@g.us')) return
  if (from === 'status@broadcast') return

  const phoneNumber: string = cleanPhoneNumber(rawPhoneNumber)
  const pushName: string = msg.pushName || 'Usuario'
  const text: string | undefined = msg.message?.conversation || msg.message?.extendedTextMessage?.text

  console.log(`💬 Mensaje de ${pushName} (${phoneNumber}): ${text}`)
  if (!text) return

  const userInput: string = text.trim()
  let response: string = ''

  try {
    const existingUser = await prisma.user.findFirst({ where: { celular: phoneNumber } })
    const currentState = userStates.get(phoneNumber)
    console.log(`🔍 Estado actual de ${phoneNumber}:`, currentState || 'sin estado')

    // ── COMANDOS ADMIN ──────────────────────────────────────────
    if (phoneNumber === ADMIN_NUMBER) {
      if (userInput.toLowerCase() === 'demos off') {
        await setDemosEnabled(false); await sock.sendMessage(from, { text: '🔴 *DEMOS DESHABILITADAS*' }); return
      } else if (userInput.toLowerCase() === 'demos on') {
        await setDemosEnabled(true); await sock.sendMessage(from, { text: '🟢 *DEMOS HABILITADAS*' }); return
      } else if (userInput.toLowerCase() === 'demos status') {
        const enabled = await isDemosEnabled()
        await sock.sendMessage(from, { text: `📊 Demos: ${enabled ? '🟢 Habilitadas' : '🔴 Deshabilitadas'}` }); return
      } else if (userInput.toLowerCase() === 'pagos') {
        const total = pagosPendientes.size
        const ahora = Date.now()
        const lista = total === 0 ? 'Ninguno' : Array.from(pagosPendientes.values())
          .map(p => {
            const restanteMs = p.vigenciaMs - (ahora - p.generadoEn)
            return `• ${p.phoneNumber} | Bs.${PLANES_MAP[p.precio]?.precio} | ${p.tipo} | ⏳ ${restanteMs > 0 ? formatarTiempoRestante(restanteMs) : 'EXPIRADO'}`
          }).join('\n')
        await sock.sendMessage(from, { text: `💳 *PAGOS PENDIENTES: ${total}*\n\n${lista}` }); return
      }
    }

    // ── CAPTURA NOMBRE PARA DEMO ────────────────────────────────
    if (currentState === 'waiting_name_for_demo') {
      if (userInput === '0' || userInput.toLowerCase() === 'menu') {
        userStates.delete(phoneNumber)
        await sock.sendMessage(from, { text: getMainMenu(existingUser) }); return
      }
      const nombre = userInput.trim()
      if (nombre.length === 0 || /^\s+$/.test(userInput)) {
        await sock.sendMessage(from, { text: `⚠️ *NOMBRE INVÁLIDO*\n\nNo puedes dejar el nombre vacío ni poner solo espacios.\n\n👉 Escribe tu nombre\n0️⃣ Volver al menú` }); return
      }
      if (!isValidName(nombre)) {
        await sock.sendMessage(from, { text: `⚠️ *NOMBRE INVÁLIDO*\n\nEl nombre debe cumplir con:\n✅ Mínimo 4 caracteres\n✅ Solo letras y espacios\n❌ Sin números ni caracteres especiales\n\nEjemplo válido: *Juan*\n\n👉 Escribe tu nombre\n0️⃣ Volver al menú` }); return
      }
      response = await handleDemoCreation(sock, from, phoneNumber, nombre)
      await sock.sendMessage(from, { text: response }); return
    }

    // ── CAPTURA NOMBRE PARA SUSCRIPCIÓN ────────────────────────
    if (currentState && currentState.startsWith('waiting_name_for_plan_')) {
      if (userInput === '0' || userInput.toLowerCase() === 'menu') {
        userStates.delete(phoneNumber)
        await sock.sendMessage(from, { text: getMainMenu(existingUser) }); return
      }
      const precio = currentState.replace('waiting_name_for_plan_', '')
      const nombre = userInput.trim()
      if (nombre.length === 0 || /^\s+$/.test(userInput)) {
        await sock.sendMessage(from, { text: `⚠️ *NOMBRE INVÁLIDO*\n\nNo puedes dejar el nombre vacío ni poner solo espacios.\n\n👉 Escribe tu nombre\n0️⃣ Volver al menú` }); return
      }
      if (!isValidName(nombre)) {
        await sock.sendMessage(from, { text: `⚠️ *NOMBRE INVÁLIDO*\n\nEl nombre debe cumplir con:\n✅ Mínimo 4 caracteres\n✅ Solo letras y espacios\n❌ Sin números ni caracteres especiales\n\nEjemplo válido: *Juan*\n\n👉 Escribe tu nombre\n0️⃣ Volver al menú` }); return
      }
      await handlePlanSelectionWithName(precio, nombre, sock, from, phoneNumber, existingUser); return
    }

    // ── GUÍAS DE INSTALACIÓN ────────────────────────────────────
    if (currentState === 'in_installation_guide') {
      const op = userInput.toLowerCase()
      if (op === 'a') { await sendInstallationGuideAndroid(sock, from, existingUser); return }
      else if (op === 'b') { await sendInstallationGuideIPhone(sock, from, existingUser); return }
      else if (op === 'c') { await sendInstallationGuideSmartTV(sock, from, existingUser); return }
      else if (op === 'd') { await sendInstallationGuideTVBox(sock, from, existingUser); return }
      else if (op === 'e') { await sendInstallationGuidePC(sock, from, existingUser); return }
      else if (op === 'o' || op === '0' || op === 'menu') {
        userStates.delete(phoneNumber); response = getMainMenu(existingUser)
      } else {
        response = '⚠️ Opción no válida.\n\nEscribe *A* Android, *B* iPhone, *C* Smart TV, *D* TV Box o *E* PC\n\n🅾️ Escribe *O* para volver al menú'
      }
      await sock.sendMessage(from, { text: response }); return
    }

    // ── SELECCIÓN PLAN DE RENOVACIÓN ───────────────────────────
    if (currentState && currentState.startsWith('selecting_renewal_plan_')) {
      const usuarioIPTV = currentState.replace('selecting_renewal_plan_', '')
      if (userInput === '0' || userInput.toLowerCase() === 'menu') {
        userStates.delete(phoneNumber); await sock.sendMessage(from, { text: getMainMenu(existingUser) }); return
      } else if (isPlanPrice(userInput)) {
        await handleRenewalPlanSelection(userInput, sock, from, phoneNumber, usuarioIPTV, existingUser); return
      } else {
        await sock.sendMessage(from, { text: '⚠️ Por favor selecciona un plan escribiendo el precio.\n\nEjemplo: *29* para 1 mes\n\n👉 Escribe *0* para volver al menú' }); return
      }
    }

    // ── RENOVACIÓN RÁPIDA ───────────────────────────────────────
    if (currentState && currentState.startsWith('quick_renewal_')) {
      const parts = currentState.replace('quick_renewal_', '').split('_')
      const usuarioIPTV = parts[0]
      const precioSugerido = parts[1]
      if (userInput === '0' || userInput.toLowerCase() === 'menu') {
        userStates.delete(phoneNumber); await sock.sendMessage(from, { text: getMainMenu(existingUser) }); return
      } else if (userInput === '99') {
        await handleRenewalUsernameSearch(sock, from, phoneNumber, usuarioIPTV); return
      } else if (isPlanPrice(userInput)) {
        await handleRenewalPlanSelection(userInput, sock, from, phoneNumber, usuarioIPTV, existingUser); return
      } else {
        await sock.sendMessage(from, { text: `⚠️ Opción no válida.\n\nEscribe *${precioSugerido}* para renovar tu plan actual\n9️⃣9️⃣ Ver otros planes\n0️⃣ Menú` }); return
      }
    }

    // ── MENÚ PRINCIPAL ──────────────────────────────────────────
    if (userInput === '1') {
      await getInfoAndPrices(sock, from); return

    } else if (userInput === '3') {
      if (hasActiveOfficialAccount(existingUser)) {
        await sock.sendMessage(from, { text: `⚠️ *${existingUser.nombre}, ya tienes una cuenta registrada*\n\n┌───────────────\n👤 Usuario: ${existingUser.usuario}\n🔐 Contraseña: ${existingUser.password}\n└───────────────\n\n5️⃣ Renovar tu cuenta\n0️⃣ Volver al Menu` }); return
      }
      response = await handleFreeTrial(phoneNumber, existingUser)

    } else if (userInput === '4') {
      if (hasActiveOfficialAccount(existingUser)) {
        const expiresAt = new Date(existingUser.expiresAt)
        await sock.sendMessage(from, { text: `⚠️ *${existingUser.nombre}, YA TIENES UNA CUENTA ACTIVA*\n\n👤 *Usuario:* ${existingUser.usuario}\n🔐 *Contraseña:* ${existingUser.password}\n📦 *Plan:* ${existingUser.plan}\n📅 *Expira:* ${expiresAt.toLocaleDateString('es-BO')}\n\n5️⃣ Renovar mi cuenta\n0️⃣ Volver al menú principal` }); return
      }
      response = getSubscriptionMenu()

    } else if (userInput === '5') {
      if (!existingUser) {
        await sock.sendMessage(from, { text: `❌ *NO TIENES UNA CUENTA REGISTRADA*\n\nPara renovar necesitas tener una cuenta activa.\n\n3️⃣ Prueba gratis\n4️⃣ Suscribirte Ahora\n0️⃣ Volver al Menu` }); return
      }
      if (existingUser.plan && existingUser.plan.includes('DEMO')) {
        await sock.sendMessage(from, { text: `Hola ${existingUser.nombre},\n\nTu cuenta demo no puede ser renovada.\n\n👉 Escribe *4* para suscribirte y obtener una cuenta oficial\n\n0️⃣ Volver al Menu` }); return
      }
      if (!existingUser.usuario) {
        await sock.sendMessage(from, { text: `⚠️ *NO TIENES USUARIO IPTV REGISTRADO*\n\nContacta a soporte: *64598912*` }); return
      }
      await handleRenewalWithQuickOption(sock, from, phoneNumber, existingUser); return

    } else if (userInput === '6') {
      await sendResellerInfo(sock, from); return
    } else if (userInput === '7') {
      response = getAdvisorContact()
    } else if (userInput === '2') {
      userStates.set(phoneNumber, 'in_installation_guide'); response = getInstallationGuide()
    } else if (userInput === '0' || userInput.toLowerCase() === 'menu') {
      response = getMainMenu(existingUser)
    } else if (isPlanPrice(userInput)) {
      if (hasActiveOfficialAccount(existingUser)) {
        await sock.sendMessage(from, { text: `⚠️ Ya tienes una cuenta activa.\n\n5️⃣ Renovar mi cuenta\n0️⃣ Volver al menú` }); return
      }
      if (!existingUser) {
        userStates.set(phoneNumber, `waiting_name_for_plan_${userInput}`)
        await sock.sendMessage(from, { text: `📝 *REGISTRO DE CLIENTE NUEVO*\n\nPara continuar con tu suscripción, necesito tu nombre completo.\n\n👉 Escribe tu nombre\n0️⃣ Volver al menú` }); return
      } else if (!existingUser.nombre || existingUser.nombre === 'Cliente' || existingUser.nombre === 'Cliente Demo') {
        userStates.set(phoneNumber, `waiting_name_for_plan_${userInput}`)
        await sock.sendMessage(from, { text: `📝 *ACTUALIZACIÓN DE DATOS*\n\nNecesito tu nombre completo para continuar.\n\n👉 Escribe tu nombre\n0️⃣ Volver al menú` }); return
      } else {
        await handlePlanSelectionWithName(userInput, existingUser.nombre, sock, from, phoneNumber, existingUser); return
      }
    } else {
      response = getMainMenu(existingUser)
    }

    if (response) await sock.sendMessage(from, { text: response })

  } catch (error) {
    console.error('❌ Error:', error)
    await sock.sendMessage(from, { text: '⚠️ Hubo un error. Intenta de nuevo escribiendo *menu*' })
    userStates.delete(phoneNumber)
  }
}

// =============================================
// FLUJOS DE PAGO CON QR
// =============================================
async function handlePlanSelectionWithName(precio: string, nombre: string, sock: WASocket, from: string, phoneNumber: string, existingUser: any): Promise<void> {
  userStates.delete(phoneNumber)
  const plan = PLANES_MAP[precio]
  await enviarQRPago(sock, from, phoneNumber, plan.precio, 'nueva', precio, nombre, undefined, existingUser?.id)
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
  await sock.sendMessage(from, { text: '🔍 Buscando tu cuenta MasTv...' })
  try {
    const { buscarUsuarioIPTV } = await import('./iptvservice.js')
    const cuentaData = await buscarUsuarioIPTV(existingUser.usuario)

    // Detectar precio real según paquete + conexiones del panel
    const precioActual = detectarPrecioDesdePanel(cuentaData.paquete, cuentaData.conexiones)
    const planActual = PLANES_MAP[precioActual]

    console.log(`✅ Plan detectado para ${existingUser.usuario}: precio=${precioActual} | ${planActual.dispositivos} disp | ${planActual.duracion}`)

    // Formatear expiración con días relativos
    const expiraStr = formatarExpiracion(cuentaData.expira)

    // Descripción legible del plan actual (con bonus si aplica)
    const planDescActual = `${planActual.dispositivos} Dispositivo${planActual.dispositivos > 1 ? 's' : ''} – ${planActual.duracion}${planActual.bonus ? ' ' + planActual.bonus : ''}`

    // Para la renovación rápida siempre se ofrece renovar el mismo plan (mismo precio)
    await sock.sendMessage(from, {
      text:
        `✅ *RENOVAR MI CUENTA*\n\n` +
        `┌───────────────\n` +
        `👤 Usuario: ${cuentaData.usuario}\n` +
        `🔐 Contraseña: ${cuentaData.password}\n` +
        `└───────────────\n\n` +
        `📦 Plan actual: *${planDescActual}*\n` +
        `${expiraStr}\n\n` +
        `💳 Escribe *${precioActual}* para renovar el mismo plan\n` +
        `(${planActual.duracion}${planActual.bonus ? ' ' + planActual.bonus : ''} - ${planActual.dispositivos} dispositivo${planActual.dispositivos > 1 ? 's' : ''} - Bs. ${planActual.precio})\n\n` +
        `9️⃣9️⃣ Ver otros planes\n` +
        `0️⃣ Menú`
    })
    userStates.set(phoneNumber, `quick_renewal_${existingUser.usuario}_${precioActual}`)
  } catch (error) {
    console.error('❌ Error buscando cuenta:', error)
    userStates.delete(phoneNumber)
    await sock.sendMessage(from, { text: `⚠️ No se pudo encontrar la cuenta *${existingUser.usuario}*\n\nPor favor contacta a soporte: *64598912*` })
  }
}

async function handleRenewalUsernameSearch(sock: WASocket, from: string, phoneNumber: string, usuarioIPTV: string): Promise<void> {
  await sock.sendMessage(from, { text: '🔍 Buscando tu cuenta IPTV...' })
  try {
    const { buscarUsuarioIPTV } = await import('./iptvservice.js')
    const cuentaData = await buscarUsuarioIPTV(usuarioIPTV)
    const paqueteLimpio = cleanPuppeteerText(cuentaData.paquete)
    const expiraStr = formatarExpiracion(cuentaData.expira)
    await sock.sendMessage(from, {
      text:
        `📋 *INFORMACIÓN ACTUAL*\n\n` +
        `┌───────────────\n` +
        `👤 Usuario: ${cuentaData.usuario}\n` +
        `📦 Plan: ${paqueteLimpio}\n` +
        `${expiraStr}\n` +
        `└───────────────\n\n` +
        `📺 *PLANES DE RENOVACIÓN*\n` +
        `👉 Escribe el precio del plan\n\n` +
        `*1 DISPOSITIVO*\n` +
        `▫️ 29 → 1 Mes\n▫️ 82 → 3 Meses\n▫️ 155 → 6 Meses + 1 Mes 🎁\n▫️ 300 → 12 Meses + 2 Meses 🎁\n\n` +
        `*2 DISPOSITIVOS*\n` +
        `▫️ 35 → 1 Mes\n▫️ 100 → 3 Meses\n▫️ 190 → 6 Meses + 1 Mes 🎁\n▫️ 380 → 12 Meses + 2 Meses 🎁\n\n` +
        `*3 DISPOSITIVOS*\n` +
        `▫️ 40 → 1 Mes\n▫️ 115 → 3 Meses\n▫️ 225 → 6 Meses + 1 Mes 🎁\n▫️ 440 → 12 Meses + 2 Meses 🎁\n\n` +
        `👉 0️⃣ Volver al menú principal`
    })
    userStates.set(phoneNumber, `selecting_renewal_plan_${usuarioIPTV}`)
  } catch (error) {
    console.error('❌ Error buscando cuenta:', error)
    userStates.delete(phoneNumber)
    await sock.sendMessage(from, { text: `⚠️ No se pudo encontrar la cuenta *${usuarioIPTV}*\n\nContacta a soporte: *64598912*` })
  }
}

// =============================================
// DEMO
// =============================================
async function handleDemoCreation(sock: WASocket, from: string, phoneNumber: string, nombre: string): Promise<string> {
  await sock.sendMessage(from, { text: '⏳ Creando tu cuenta demo...' })
  iniciarProcesoCritico(from)
  try {
    const iptvData = await crearUsuarioIPTV('DEMO 3 HORA')
    const expiresAt = new Date()
    expiresAt.setHours(expiresAt.getHours() + 3)
    await prisma.user.create({ data: { nombre, usuario: iptvData.usuario, password: iptvData.password, celular: phoneNumber, plan: 'DEMO 3 HORA', expiresAt } })
    userStates.delete(phoneNumber)
    return `✅✅ *¡Tu demo de 3 horas ya está lista!*\n\n┌───────────────\n👤 Usuario: ${iptvData.usuario}\n🔐 Contraseña: ${iptvData.password}\n└───────────────\n\n🚀 Empieza cuando ingreses a la aplicación\n\n📲 *En IPTV Smarters Pro ingresa:*\n🌐 URL: mtv.bo\n\n📥 *Si necesitas instalar:*\n🔢 Downloader:\n • 223062\n • 123.bo/a\n\n📲 *Descarga directa para celular:*\n🔗 https://bit.ly/mastviptv\n\n*🅾 Volver al menú principal*`
  } catch (error) {
    userStates.delete(phoneNumber)
    throw new Error('No se pudo crear la cuenta IPTV. Intenta nuevamente.')
  } finally {
    finalizarProcesoCritico(from)
  }
}

async function handleFreeTrial(phoneNumber: string, existingUser: any): Promise<string> {
  const demosEnabled = await isDemosEnabled()
  if (!demosEnabled) return `🔴 *DEMOS DESHABILITADAS*\n\nDebido a alta demanda, las demos están temporalmente deshabilitadas.\n\n👉 Escribe *4* para suscribirte\n📞 Soporte: 64598912`
  if (existingUser) return `ℹ️ *Tu cuenta de prueba*\n\n┌───────────────\n👤 Usuario: ${existingUser.usuario}\n🔐 Contraseña: ${existingUser.password}\n└───────────────\n\n⏱️ La demo es de un solo uso (3 horas).\nSi ya la utilizaste, ya no está disponible.\n\n⚠️ Solo se permite 1 demo por número\n👉 Escribe *4* para suscribirte`
  userStates.set(phoneNumber, 'waiting_name_for_demo')
  return `📝 *DEMO GRATIS - 3 HORAS*\n\nPara crear tu demo, escribe tu nombre:\n\n👉 Ejemplo: Juan\n0️⃣ Volver al menú`
}

// =============================================
// MENÚS Y GUÍAS
// =============================================
async function getInfoAndPrices(sock: WASocket, from: string): Promise<void> {
  try {
    const fs = await import('fs')
    if (fs.existsSync('./recursos/img.png')) {
      await sock.sendMessage(from, { image: fs.readFileSync('./recursos/img.png'), caption: '💵 PLANES Y PRECIOS 👆' })
      await new Promise(r => setTimeout(r, 1000))
    }
  } catch {}
  await sock.sendMessage(from, { text: `⚽🔥 MASTV – El mejor IPTV de Bolivia 🔥⚽\n\nTodo el fútbol, deportes y entretenimiento sin cortes ni límites:\n✅ Liga Boliviana\n✅ Mundial, Champions y Libertadores\n✅ UFC y Fórmula 1\n✅ Películas, series y TV en vivo\n\n📱 Compatible con celular, Smart TV, TV Box y PC\n\n🚀 Elige una opción:\n👉 2️⃣ Guia de instalacion\n👉 0️⃣ Menu principal` })
}

function getSubscriptionMenu(): string {
  return `💵 *Planes MASTV*\n\n👉 Elija su plan escribiendo el número que aparece a la izquierda.\nEjemplo: Si quiere 1 Mes por 29 Bs → escriba *29*\n\n📺 *1 DISPOSITIVO*\n▫️ 29 → 1 Mes\n▫️ 82 → 3 Meses\n▫️ 155 → 6 Meses + 1 Mes 🎁\n▫️ 300 → 12 Meses + 2 Meses 🎁\n\n📺 *2 DISPOSITIVOS*\n▫️ 35 → 1 Mes\n▫️ 100 → 3 Meses\n▫️ 190 → 6 Meses + 1 Mes 🎁\n▫️ 380 → 12 Meses + 2 Meses 🎁\n\n📺 *3 DISPOSITIVOS*\n▫️ 40 → 1 Mes\n▫️ 115 → 3 Meses\n▫️ 225 → 6 Meses + 1 Mes 🎁\n▫️ 440 → 12 Meses + 2 Meses 🎁\n\n━━━━━━━━━━━━━━━━━━\n👉 0️⃣ ▶️ Volver al menú principal\n━━━━━━━━━━━━━━━━━━`
}

async function sendResellerInfo(sock: WASocket, from: string): Promise<void> {
  try {
    const fs = await import('fs')
    if (fs.existsSync('./recursos/img4.png')) {
      await sock.sendMessage(from, { image: fs.readFileSync('./recursos/img4.png'), caption: '📢 SISTEMA DE REVENTA MASTV' })
      await new Promise(r => setTimeout(r, 800))
    }
    if (fs.existsSync('./recursos/img5.png')) {
      await sock.sendMessage(from, { image: fs.readFileSync('./recursos/img5.png'), caption: '💰 PLANES DE CRÉDITOS' })
      await new Promise(r => setTimeout(r, 800))
    }
  } catch (e: any) {
    console.error('Error enviando imágenes reseller:', e.message)
  }

  await sock.sendMessage(from, {
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
      `Para mantener igualdad entre revendedores y evitar que alguien dañe el mercado bajando precios. Aquí todos tienen las mismas oportunidades.\n\n` +
      `📲 *¿Te interesa?* Habla con un asesor escribiendo *7*\n\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `👉 0️⃣ Volver al menú principal\n` +
      `━━━━━━━━━━━━━━━━━━`
  })
}

function getResellerInfo(): string {
  return ''
}

function getAdvisorContact(): string {
  return `🛠 *SOPORTE TÉCNICO*\n\nSi presentas algún problema con el servicio:\n\n✍️ Escríbenos o 📸🎥 envíanos una foto o video del error\n\n📞 O llama a soporte técnico: *64598912*\n\n━━━━━━━━━━━━━━━━━━\n👉 0️⃣ ▶️ Volver al menú principal\n━━━━━━━━━━━━━━━━━━`
}

function getInstallationGuide(): string {
  return `📲 *INSTALACIÓN DE MASTV*\n\n¿En qué dispositivo deseas instalar MASTV? 👇\n\n*A*) 📱 Android\n*B*) 🍎 iPhone\n*C*) 📺 Smart TV\n*D*) 📦 TV Box / Fire Stick\n*E*) 💻 PC o Laptop\n\n✍️ Responde con la letra de la opción\n\n*🅾* Volver al menú principal`
}

function getMainMenu(existingUser: any): string {
  const nombre = existingUser ? `Bienvenido de nuevo *${existingUser.nombre}*` : 'Bienvenido a *MasTV*'
  return `👋 ${nombre}\n\n📋 *MENÚ MASTV*\n\n1️⃣ Información y precios\n2️⃣ Guia de instalación\n3️⃣ Prueba GRATIS por 3 horas\n4️⃣ Suscribirme ahora\n5️⃣ Renovar mi cuenta\n6️⃣ Quiero vender Mastv\n7️⃣ Hablar con un asesor\n\n👉 Responde con un número`
}

async function sendInstallationGuideAndroid(sock: WASocket, from: string, existingUser: any): Promise<void> {
  try { const fs = await import('fs'); if (fs.existsSync('./recursos/video1.mp4')) { await sock.sendMessage(from, { video: fs.readFileSync('./recursos/video1.mp4'), caption: '📱 *GUÍA DE INSTALACIÓN - ANDROID*' }); await new Promise(r => setTimeout(r, 1500)) } } catch {}
  const u = existingUser; const n = u?.nombre || '{nombre}'; const us = u?.usuario || '{usuario}'; const p = u?.password || '{password}'
  await sock.sendMessage(from, { text: `📱 INSTALACIÓN EN CELULAR ANDROID\n\n👉 PASO 1\nPresiona el link azul para descargar la aplicación:\n🔵 https://123.bo/a\n\n⏳ PASO 2\nEspera a que termine la descarga.\nLuego presiona INSTALAR 👆\n\n📲 PASO 3\nCuando termine la instalación, presiona ABRIR 👆\n\n🔐 PASO 4\nDentro de la app selecciona:\n👉 MOBILE\n\n✍️ PASO 5\nIngresa tus datos:\n\n📋 Nombre: ${n}\n👤 Usuario: ${us}\n🔑 Contraseña: ${p}\n\n🅾️ Volver al Menú` })
}

async function sendInstallationGuideIPhone(sock: WASocket, from: string, existingUser: any): Promise<void> {
  try { const fs = await import('fs'); if (fs.existsSync('./recursos/video1.mp4')) { await sock.sendMessage(from, { video: fs.readFileSync('./recursos/video1.mp4'), caption: '🍎 *GUÍA DE INSTALACIÓN - iPHONE*' }); await new Promise(r => setTimeout(r, 1500)) } } catch {}
  const u = existingUser; const us = u?.usuario || '{usuario}'; const p = u?.password || '{password}'
  await sock.sendMessage(from, { text: `🍎 INSTALACIÓN EN IPHONE / IPAD – MasTV\n\n👉 PASO 1\nAbre App Store en tu iPhone o iPad.\n\n🔎 PASO 2\nBusca: 📺 IPTV Stream Player o 📺 VU IPTV Player\n\n🔵 https://bit.ly/iphone-vu-iptv-player\n🔵 https://bit.ly/iphone-iptv-stream-player\n\n⬇️ PASO 3\nPresiona OBTENER e instala la aplicación.\n\n✍️ PASO 4\nIngresa tus datos:\n\n👤 Usuario: ${us}\n🔑 Contraseña: ${p}\n🌐 URL: vivetv.net\n\n🅾️ Volver al Menu` })
}

async function sendInstallationGuideSmartTV(sock: WASocket, from: string, existingUser: any): Promise<void> {
  try { const fs = await import('fs'); if (fs.existsSync('./recursos/video1.mp4')) { await sock.sendMessage(from, { video: fs.readFileSync('./recursos/video1.mp4'), caption: '📺 *GUÍA DE INSTALACIÓN - SMART TV*' }); await new Promise(r => setTimeout(r, 1500)) } } catch {}
  const u = existingUser; const n = u?.nombre || '{nombre}'; const us = u?.usuario || '{usuario}'; const p = u?.password || '{password}'
  await sock.sendMessage(from, { text: `📺 INSTALACIÓN EN SMART TV\n\n🛒 PASO 1\nAbre la tienda de tu TV y busca: 📺 IPTV Smarters Pro\n\n✍️ PASO 2\nIngresa tus datos:\n\n🧾 Nombre: ${n}\n👤 Usuario: ${us}\n🔑 Contraseña: ${p}\n🌐 URL: vivetv.net\n\n🅾️ Volver al Menú` })
}

async function sendInstallationGuideTVBox(sock: WASocket, from: string, existingUser: any): Promise<void> {
  try { const fs = await import('fs'); if (fs.existsSync('./recursos/video1.mp4')) { await sock.sendMessage(from, { video: fs.readFileSync('./recursos/video1.mp4'), caption: '📦 *GUÍA DE INSTALACIÓN - TV BOX*' }); await new Promise(r => setTimeout(r, 1500)) } } catch {}
  const u = existingUser; const n = u?.nombre || '{nombre}'; const us = u?.usuario || '{usuario}'; const p = u?.password || '{password}'
  await sock.sendMessage(from, { text: `📺 INSTALACIÓN EN ANDROID TV / TV BOX\n\n🛒 PASO 1\nAbre Google Play Store y busca: Downloader\n\n🔢 PASO 2\nAbre Downloader y escribe el código: 🔹 223062\n\nPresiona GO para descargar e instalar.\n\n✍️ PASO 3\nIngresa tus datos:\n\n🧾 Nombre: ${n}\n👤 Usuario: ${us}\n🔑 Contraseña: ${p}\n\n🅾️ Volver al Menú` })
}

async function sendInstallationGuidePC(sock: WASocket, from: string, existingUser: any): Promise<void> {
  try { const fs = await import('fs'); if (fs.existsSync('./recursos/video1.mp4')) { await sock.sendMessage(from, { video: fs.readFileSync('./recursos/video1.mp4'), caption: '💻 *GUÍA DE INSTALACIÓN - PC*' }); await new Promise(r => setTimeout(r, 1500)) } } catch {}
  const u = existingUser; const n = u?.nombre || '{nombre}'; const us = u?.usuario || '{usuario}'; const p = u?.password || '{password}'
  await sock.sendMessage(from, { text: `💻 INSTALACIÓN EN PC / LAPTOP\n\n👉 PASO 1\nDescarga la aplicación:\n🔵 https://bit.ly/mastvpc\n\n⬇️ PASO 2\nInstala y abre la aplicación.\n\n✍️ PASO 3\nIngresa tus datos:\n\n🧾 Nombre: ${n}\n👤 Usuario: ${us}\n🔑 Contraseña: ${p}\n\n🅾️ Volver al Menú` })
}

// =============================================
// MAPA DE PLANES
// =============================================
const PLANES_MAP: { [key: string]: { dispositivos: number, duracion: string, precio: number, bonus?: string } } = {
  '29':  { dispositivos: 1, duracion: '1 Mes',    precio: 29  },
  '82':  { dispositivos: 1, duracion: '3 Meses',  precio: 82  },
  '155': { dispositivos: 1, duracion: '6 Meses',  precio: 155, bonus: '+ 1 Mes 🎁' },
  '300': { dispositivos: 1, duracion: '12 Meses', precio: 300, bonus: '+ 2 Meses 🎁' },
  '35':  { dispositivos: 2, duracion: '1 Mes',    precio: 35  },
  '100': { dispositivos: 2, duracion: '3 Meses',  precio: 100 },
  '190': { dispositivos: 2, duracion: '6 Meses',  precio: 190, bonus: '+ 1 Mes 🎁' },
  '380': { dispositivos: 2, duracion: '12 Meses', precio: 380, bonus: '+ 2 Meses 🎁' },
  '40':  { dispositivos: 3, duracion: '1 Mes',    precio: 40  },
  '115': { dispositivos: 3, duracion: '3 Meses',  precio: 115 },
  '225': { dispositivos: 3, duracion: '6 Meses',  precio: 225, bonus: '+ 1 Mes 🎁' },
  '440': { dispositivos: 3, duracion: '12 Meses', precio: 440, bonus: '+ 2 Meses 🎁' },
}