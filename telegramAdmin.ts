import { prisma } from './lib/prisma.js'
import {
  isDemosEnabled, setDemosEnabled, getPagosPendientes,
  isVeripagosEnabled, setVeripagosEnabled,
  aprobarPagoManual, rechazarPagoManual,
  setAdminNotifyCallback, getPagosManualPendientes,
  iniciarPollerActivacion, cleanPhoneNumber, planPanelAFormato, sincronizarCuentaDesdePanel,
  setBotPausado, isBotPausado,
  registrarTransaccionDesdePanel,
} from './messageHandler.js'
import { leerCreditosPanel, setPanelCredentials } from './iptvservice.js'

console.log('📦 telegramAdmin.ts: módulo cargado')

const TOKEN    = process.env.TELEGRAM_TOKEN    ?? (() => { throw new Error('TELEGRAM_TOKEN no configurado en .env') })()
const ADMIN_ID = parseInt(process.env.TELEGRAM_ADMIN_ID ?? '0') || (() => { throw new Error('TELEGRAM_ADMIN_ID no configurado en .env') })()
const API_URL  = `https://api.telegram.org/bot${TOKEN}`

let running = false

// ── Callbacks desde boti.ts ────────────────────────────────
let resetSessionCallback: (() => Promise<void>) | null = null
let iniciarWACallback: (() => void) | null = null
let cancelarWACallback: (() => Promise<void>) | null = null
let waStatus: 'desconectado' | 'conectando' | 'conectado' = 'desconectado'

export function setResetSessionCallback(fn: () => Promise<void>): void {
  resetSessionCallback = fn
}

export function setIniciarWACallback(fn: () => void): void {
  iniciarWACallback = fn
}

export function setCancelarWACallback(fn: () => Promise<void>): void {
  cancelarWACallback = fn
}

export function setWAStatus(status: 'desconectado' | 'conectando' | 'conectado'): void {
  waStatus = status
}

export async function notifyQrCode(buffer: Buffer): Promise<void> {
  try {
    await sendPhoto(ADMIN_ID, buffer,
      `📱 *Nuevo QR de WhatsApp*\n\nEscanea este código con el número que quieres vincular al bot.\n\n⏳ El QR expira en ~60 segundos.`
    )
  } catch (e: any) {
    console.error('❌ Error enviando QR a Telegram:', e.message)
  }
}

export async function notifyBotConectado(numero: string): Promise<void> {
  waStatus = 'conectado'
  try {
    await send(ADMIN_ID,
      `✅ *Bot conectado correctamente*\n\n📱 Número activo: *+${numero}*`,
      getConfigKb()
    )
  } catch (e: any) {
    console.error('❌ Error notificando conexión a Telegram:', e.message)
  }
}

export async function notifyWAEsperando(): Promise<void> {
  try {
    await send(ADMIN_ID,
      `⚠️ *WhatsApp no vinculado*\n\n` +
      `El bot está activo pero no hay número vinculado.\n\n` +
      `Ve a ⚙️ *Configuración* y presiona *🔗 Conectar WhatsApp* para escanear el QR.`,
      getMenuKb()
    )
  } catch (e: any) {
    console.error('❌ Error notificando WA no vinculado:', e.message)
  }
}

// ── API wrapper ────────────────────────────────────────────
async function api(method: string, params: Record<string, any> = {}): Promise<any> {
  const res = await fetch(`${API_URL}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  })
  const data = await res.json() as any
  if (!data.ok) throw new Error(`[${method}] ${data.description}`)
  return data.result
}

// ── Helpers de mensajes ────────────────────────────────────
type KbRow = Array<{ text: string; cb: string }>

function kb(rows: KbRow[]): object {
  return { inline_keyboard: rows.map(r => r.map(b => ({ text: b.text, callback_data: b.cb }))) }
}

async function send(chatId: number, text: string, markup?: object): Promise<any> {
  return api('sendMessage', {
    chat_id: chatId, text, parse_mode: 'Markdown',
    ...(markup ? { reply_markup: markup } : {}),
  })
}

function detectarTipoArchivo(buf: Buffer): { mime: string; nombre: string } {
  if (buf[0] === 0xFF && buf[1] === 0xD8)                                           return { mime: 'image/jpeg',       nombre: 'comprobante.jpg' }
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47)    return { mime: 'image/png',        nombre: 'comprobante.png' }
  if (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46)    return { mime: 'application/pdf',  nombre: 'comprobante.pdf' }
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46)                       return { mime: 'image/gif',        nombre: 'comprobante.gif' }
  return { mime: 'application/octet-stream', nombre: 'comprobante' }
}

async function sendPhoto(chatId: number, photoBuffer: Buffer, caption: string): Promise<void> {
  const form = new FormData()
  form.append('chat_id', String(chatId))
  form.append('caption', caption)
  form.append('parse_mode', 'Markdown')
  form.append('photo', new Blob([photoBuffer], { type: 'image/png' }), 'qr.png')
  const res = await fetch(`${API_URL}/sendPhoto`, { method: 'POST', body: form })
  const data = await res.json() as any
  if (!data.ok) throw new Error(`[sendPhoto] ${data.description}`)
}

async function sendDocument(chatId: number, docBuffer: Buffer, caption: string, markup?: object): Promise<void> {
  const { mime, nombre } = detectarTipoArchivo(docBuffer)
  const form = new FormData()
  form.append('chat_id', String(chatId))
  form.append('caption', caption)
  form.append('parse_mode', 'Markdown')
  form.append('document', new Blob([docBuffer], { type: mime }), nombre)
  if (markup) form.append('reply_markup', JSON.stringify(markup))
  const res = await fetch(`${API_URL}/sendDocument`, { method: 'POST', body: form })
  const data = await res.json() as any
  if (!data.ok) throw new Error(`[sendDocument] ${data.description}`)
}

async function edit(chatId: number, msgId: number, text: string, markup?: object): Promise<void> {
  try {
    await api('editMessageText', {
      chat_id: chatId, message_id: msgId, text, parse_mode: 'Markdown',
      ...(markup ? { reply_markup: markup } : {}),
    })
  } catch (e: any) {
    if (e.message?.includes('there is no text in the message')) {
      try {
        await api('editMessageCaption', {
          chat_id: chatId, message_id: msgId, caption: text, parse_mode: 'Markdown',
          ...(markup ? { reply_markup: markup } : {}),
        })
      } catch (e2: any) {
        if (!e2.message?.includes('not modified')) console.error('editCaption error:', e2.message)
      }
    } else if (!e.message?.includes('not modified')) {
      console.error('edit error:', e.message)
    }
  }
}

async function answerCb(id: string, text?: string): Promise<void> {
  await api('answerCallbackQuery', { callback_query_id: id, ...(text ? { text } : {}) })
}

async function deleteAndSend(chatId: number, msgId: number, text: string, markup?: object): Promise<void> {
  try { await api('deleteMessage', { chat_id: chatId, message_id: msgId }) } catch {}
  await send(chatId, text, markup)
}

// ── Teclados ───────────────────────────────────────────────
function getMenuKb() {
  return kb([
    [{ text: '👥 Clientes', cb: 'clientes_0' }, { text: '💳 Pagos QR', cb: 'pagos' }],
    [{ text: '⏳ Aprobaciones', cb: 'espera' }, { text: '📈 Finanzas', cb: 'finanzas_menu' }],
    [{ text: '⚙️ Configuración', cb: 'config_menu' }],
  ])
}
function getConfigKb() {
  const pausado = isBotPausado()
  const waRow: KbRow =
    waStatus === 'conectado'   ? [{ text: '📱 Cambiar número',            cb: 'cambiar_numero' }] :
    waStatus === 'conectando'  ? [{ text: '❌ Cancelar vinculación',      cb: 'cancelar_wa'    }] :
                                 [{ text: '🔗 Conectar WhatsApp',          cb: 'iniciar_wa'     }]
  return kb([
    [{ text: '🎬 Demos', cb: 'demos_menu' }, { text: '💲 VeriPagos', cb: 'vp_menu' }],
    waRow,
    [{ text: pausado ? '▶️ Reanudar bot' : '⏸️ Pausar bot', cb: 'toggle_pausa' }],
    [{ text: '🔧 Panel IPTV', cb: 'panel_iptv' }],
    [{ text: '🗑️ Reinicio de año', cb: 'reinicio_anio' }],
    [{ text: '⬅️ Menú', cb: 'menu' }],
  ])
}
const FINANZAS_MENU_KB = kb([
  [{ text: '📊 Estadísticas', cb: 'stats' }, { text: '💰 Finanzas', cb: 'finanzas' }],
  [{ text: '💸 Devolución', cb: 'devolucion' }],
  [{ text: '⬅️ Menú', cb: 'menu' }],
])
const BACK_KB = kb([[{ text: '⬅️ Menú', cb: 'menu' }]])

// ── Estado de conversación ─────────────────────────────────
const pendingAction = new Map<number, { type: string; usuarioTarget?: string; extra?: string }>()

// ── Handlers ───────────────────────────────────────────────
async function showMenu(chatId: number, msgId?: number): Promise<void> {
  pendingAction.delete(ADMIN_ID)
  const text = '🤖 *Panel Admin MasTV*\n\nSelecciona una opción:'
  if (msgId) await edit(chatId, msgId, text, getMenuKb())
  else await send(chatId, text, getMenuKb())
}

async function handleStats(chatId: number, msgId: number): Promise<void> {
  const ahora = new Date()
  const [
    totalRegistrados,
    cuentasActivas,
    cuentasVencidas,
    demosCount,
    txTotal,
    primeraFecha,
    demosOn,
    vpOn,
  ] = await Promise.all([
    prisma.user.count({ where: { plan: { notIn: ['DEMO 3 HORA', 'DEMO EXPIRADA'] } } }),
    prisma.user.count({ where: { plan: { notIn: ['DEMO 3 HORA', 'DEMO EXPIRADA'] }, expiresAt: { gt: ahora } } }),
    prisma.user.count({ where: { plan: { notIn: ['DEMO 3 HORA', 'DEMO EXPIRADA'] }, expiresAt: { lt: ahora, not: null } } }),
    prisma.user.count({ where: { plan: { in: ['DEMO 3 HORA', 'DEMO EXPIRADA'] } } }),
    (prisma as any).transaccion.findMany({}),
    (prisma as any).transaccion.findFirst({ orderBy: { fecha: 'asc' } }),
    isDemosEnabled(),
    isVeripagosEnabled(),
  ])

  const r = resumirTxs(txTotal)
  const renovaciones = r.renov
  const ingresos     = r.ingresos - r.montoDev
  const costos       = r.costo
  const ganancia     = r.ganancia
  const creditos     = r.creditos
  const diasOperando = primeraFecha
    ? Math.floor((ahora.getTime() - new Date(primeraFecha.fecha).getTime()) / 86400000)
    : 0

  const pagosQR     = getPagosPendientes().length
  const pagosEspera = getPagosManualPendientes().length
  const f2 = (n: number) => n.toFixed(2)

  await edit(chatId, msgId,
    `📊 *Estadísticas MasTV*\n\n` +
    `👥 Clientes registrados: *${totalRegistrados}*\n` +
    `📺 Cuentas activas: *${cuentasActivas}*\n` +
    `🔄 Renovaciones realizadas: *${renovaciones}*\n` +
    `🎁 Demos generadas: *${demosCount}*\n\n` +
    `💵 Ingresos históricos: *Bs. ${f2(ingresos)}*\n` +
    (r.devoluciones > 0 ? `💸 Devoluciones: *${r.devoluciones}* (−Bs. ${f2(r.montoDev)})\n` : '') +
    `⚙️ Costos operativos: *Bs. ${f2(costos)}*\n` +
    `✅ Ganancia neta: *Bs. ${f2(ganancia)}*\n\n` +
    `📆 Tiempo operando: *${diasOperando} días*\n` +
    `🪙 Créditos consumidos: *${f2(creditos)}*\n` +
    `⚠️ Cuentas vencidas: *${cuentasVencidas}*\n\n` +
    `━━━━━━━━━━━━━━━━\n` +
    `🎬 Demos: ${demosOn ? '🟢 Activas' : '🔴 Desact.'}  |  💲 VeriPagos: ${vpOn ? '🟢' : '🔴'}\n` +
    `💳 QR pendientes: *${pagosQR}*  |  ⏳ Aprobaciones: *${pagosEspera}*`,
    kb([
      [{ text: '🔄 Actualizar', cb: 'stats' }, { text: '⬅️ Volver', cb: 'finanzas_menu' }],
    ])
  )
}

async function handleClientes(chatId: number, msgId: number, offset: number): Promise<void> {
  const total = await prisma.user.count({ where: { plan: { not: 'DEMO 3 HORA' } } })
  const clientes = await prisma.user.findMany({
    where: { plan: { not: 'DEMO 3 HORA' } },
    orderBy: { createdAt: 'desc' },
    take: 8, skip: offset,
  })
  if (clientes.length === 0) {
    await edit(chatId, msgId, 'No hay clientes registrados.', BACK_KB); return
  }
  const texto = clientes.map((u, i) =>
    `${offset + i + 1}. *${u.usuario}* — ${u.nombre}\n   📅 ${u.expiresAt ? new Date(u.expiresAt).toLocaleDateString('es-BO') : 'Sin fecha'}`
  ).join('\n\n')

  const navRow: KbRow = []
  if (offset > 0) navRow.push({ text: '⬅️ Anterior', cb: `clientes_${offset - 8}` })
  if (offset + 8 < total) navRow.push({ text: 'Siguiente ➡️', cb: `clientes_${offset + 8}` })

  const rows: KbRow[] = []
  if (navRow.length) rows.push(navRow)
  rows.push([{ text: '🔍 Buscar cliente', cb: 'buscar' }, { text: '➕ Agregar', cb: 'agregar' }])
  rows.push([{ text: '⬅️ Menú', cb: 'menu' }])

  await edit(chatId, msgId,
    `👥 *Clientes (${offset + 1}–${Math.min(offset + 8, total)} de ${total})*\n\n${texto}`,
    kb(rows)
  )
}

async function handleDemosMenu(chatId: number, msgId: number): Promise<void> {
  const on = await isDemosEnabled()
  const total = await (prisma as any).demoHistory.count()
  await edit(chatId, msgId,
    `🎬 *Demos*\n\nEstado: ${on ? '🟢 Habilitadas' : '🔴 Deshabilitadas'}\n👥 Clientes con historial demo: *${total}*`,
    kb([
      [{ text: on ? '🔴 Deshabilitar' : '🟢 Habilitar', cb: on ? 'demos_off' : 'demos_on' }],
      [{ text: '👥 Ver clientes demo', cb: 'demos_clientes_0' }],
      [{ text: '🔓 Liberar todos', cb: 'demos_liberar_confirm' }],
      [{ text: '⬅️ Volver', cb: 'config_menu' }],
    ])
  )
}

async function handleDemosClientes(chatId: number, msgId: number, offset: number): Promise<void> {
  const todos = await (prisma as any).demoHistory.findMany({ orderBy: { updatedAt: 'desc' } })
  if (todos.length === 0) {
    await edit(chatId, msgId, '👥 No hay registros de demos.', kb([[{ text: '⬅️ Demos', cb: 'demos_menu' }]])); return
  }
  const total = todos.length
  const pagina = todos.slice(offset, offset + 8)
  const unMesAtras = new Date(); unMesAtras.setMonth(unMesAtras.getMonth() - 1)
  const texto = pagina.map((c: any, i: number) => {
    const bloqueado = c.count >= 2 || (c.count === 1 && new Date(c.lastDemoAt) > unMesAtras)
    const estado = c.count >= 2 ? '🔒 bloqueado perm.' : bloqueado ? '⏳ espera 1 mes' : '✅ puede pedir'
    return `${offset + i + 1}. \`${c.celular}\`\n   🎬 Usadas: *${c.count}/2* | ${estado}`
  }).join('\n\n')
  const navRow: KbRow = []
  if (offset > 0) navRow.push({ text: '⬅️ Anterior', cb: `demos_clientes_${offset - 8}` })
  if (offset + 8 < total) navRow.push({ text: 'Siguiente ➡️', cb: `demos_clientes_${offset + 8}` })
  const rows: KbRow[] = []
  if (navRow.length) rows.push(navRow)
  rows.push([{ text: '🔓 Liberar todos', cb: 'demos_liberar_confirm' }, { text: '⬅️ Demos', cb: 'demos_menu' }])
  await edit(chatId, msgId,
    `👥 *Clientes demo (${offset + 1}–${Math.min(offset + 8, total)} de ${total})*\n\n${texto}`,
    kb(rows)
  )
}

async function handleEspera(chatId: number, msgId: number): Promise<void> {
  const pendientes = getPagosManualPendientes()
  if (pendientes.length === 0) {
    await edit(chatId, msgId, '⏳ No hay clientes en espera de aprobación.', BACK_KB)
    return
  }
  await edit(chatId, msgId,
    `⏳ *Clientes en espera: ${pendientes.length}*\n\nSelecciona uno para aprobar o rechazar:`,
    kb([
      ...pendientes.map(p => [{
        text: `${p.esActivacionDemo ? '✨' : p.tipo === 'renovacion' ? '🔄' : '🆕'} ${p.nombre} — Bs. ${p.precio}`,
        cb: `ver_espera_${p.phoneNumber}`,
      }]),
      [{ text: '⬅️ Menú', cb: 'menu' }],
    ])
  )
}

async function handleVerEspera(chatId: number, msgId: number, phoneNumber: string): Promise<void> {
  const pendientes = getPagosManualPendientes()
  const p = pendientes.find(x => x.phoneNumber === phoneNumber)
  if (!p) {
    await edit(chatId, msgId, '❌ Este pago ya fue procesado o no existe.', BACK_KB)
    return
  }
  const tipoLabel = p.esActivacionDemo ? '✨ Activación demo' : p.tipo === 'renovacion' ? '🔄 Renovación' : '🆕 Cuenta nueva'
  const usuarioLine = p.usuarioIPTV ? `🔑 *Usuario IPTV:* ${p.usuarioIPTV}\n` : ''
  const espera = Math.floor((Date.now() - p.timestamp) / 60000)
  await edit(chatId, msgId,
    `⏳ *PAGO EN ESPERA*\n\n` +
    `👤 *Cliente:* ${p.nombre}\n` +
    `📱 *Número:* ${phoneNumber}\n` +
    `${usuarioLine}` +
    `💰 *Monto:* Bs. ${p.precio}\n` +
    `${tipoLabel}\n` +
    `🕐 *Esperando:* ${espera} min\n\n` +
    `¿Aprobar o rechazar?`,
    kb([
      [{ text: '✅ Aprobar', cb: `ap_${phoneNumber}` }, { text: '❌ Rechazar', cb: `rj_${phoneNumber}` }],
      [{ text: '⬅️ Aprobaciones', cb: 'espera' }],
    ])
  )
}

async function handleVpMenu(chatId: number, msgId: number): Promise<void> {
  const on = await isVeripagosEnabled()
  await edit(chatId, msgId,
    `💲 *VeriPagos*\n\nEstado: ${on ? '🟢 Habilitado' : '🔴 Deshabilitado'}\n\n` +
    `${on ? 'El bot usa QR automático de VeriPagos.' : 'El bot envía QR estático y espera comprobante manual.'}`,
    kb([
      [{ text: on ? '🔴 Deshabilitar' : '🟢 Habilitar', cb: on ? 'vp_off' : 'vp_on' }],
      [{ text: '⬅️ Volver', cb: 'config_menu' }],
    ])
  )
}

async function handlePagos(chatId: number, msgId: number): Promise<void> {
  const pagos = getPagosPendientes()
  if (pagos.length === 0) {
    await edit(chatId, msgId, '💳 No hay pagos pendientes.', BACK_KB); return
  }
  const ahora = Date.now()
  const texto = pagos.map(p => {
    const min = Math.max(0, Math.floor((p.vigenciaMs - (ahora - p.generadoEn)) / 60000))
    return `• *${p.phoneNumber}* | Bs. ${p.precio} | ${p.tipo === 'nueva' ? '🆕' : '🔄'} | ⏳ ${min} min`
  }).join('\n\n')
  await edit(chatId, msgId, `💳 *Pagos pendientes: ${pagos.length}*\n\n${texto}`,
    kb([[{ text: '🔄 Actualizar', cb: 'pagos' }, { text: '⬅️ Menú', cb: 'menu' }]])
  )
}

async function mostrarCliente(chatId: number, user: any): Promise<void> {
  const texto =
    `👤 *${user.nombre}*\n\n` +
    `📱 Celular: \`${user.celular}\`\n` +
    `🔑 Usuario: \`${user.usuario}\`\n` +
    `🔐 Password: \`${user.password || '-'}\`\n` +
    `📦 Plan: ${user.plan || '-'}\n` +
    `📅 Expira: *${user.expiresAt ? new Date(user.expiresAt).toLocaleDateString('es-BO') : 'Sin fecha'}*\n` +
    `🔔 Recordatorio: ${user.reminderSent ? '🔕 Desactivado/Enviado' : '⏳ Pendiente'}`
  const remBtn = user.reminderSent
    ? { text: '🔔 Reactivar recordatorio', cb: `rem_on_${user.usuario}` }
    : { text: '🔕 Desactivar recordatorio', cb: `rem_off_${user.usuario}` }
  await send(chatId, texto, kb([
    [{ text: '📅 Cambiar fecha', cb: `cf_${user.usuario}` }, { text: '✏️ Cambiar usuario', cb: `eu_${user.usuario}` }],
    [{ text: '📱 Cambiar celular', cb: `ec_${user.usuario}` }, remBtn],
    [{ text: '🔄 Actualizar desde panel', cb: `sync_${user.usuario}` }],
    [{ text: '🗑️ Eliminar', cb: `del_${user.usuario}` }, { text: '🔍 Buscar otro', cb: 'buscar' }],
    [{ text: '⬅️ Menú', cb: 'menu' }],
  ]))
}

async function getPrecioCredito(): Promise<number> {
  const cfg = await prisma.config.findUnique({ where: { key: 'precio_credito' } })
  return cfg ? parseFloat(cfg.value) : 17
}

const MESES_ES = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre']

function resumirTxs(txs: any[]) {
  const nuevasTx  = txs.filter((t: any) => t.tipo === 'nueva')
  const renovTx   = txs.filter((t: any) => t.tipo === 'renovacion')
  const activTx   = txs.filter((t: any) => t.tipo === 'activacion')
  const devTx     = txs.filter((t: any) => t.tipo === 'devolucion')
  const ventasTx  = txs.filter((t: any) => t.tipo !== 'devolucion')
  const montoDev    = devTx.reduce((s: number, t: any) => s + t.precio, 0)
  const creditosDev = devTx.reduce((s: number, t: any) => s + t.creditos, 0)
  const costoDev    = devTx.reduce((s: number, t: any) => s + t.costo, 0)
  return {
    nuevas:         nuevasTx.length,
    renov:          renovTx.length,
    activ:          activTx.length,
    devoluciones:   devTx.length,
    ingresosNuevas: nuevasTx.reduce((s: number, t: any) => s + t.precio, 0),
    ingresosRenov:  renovTx.reduce((s: number, t: any)  => s + t.precio, 0),
    ingresosActiv:  activTx.reduce((s: number, t: any)  => s + t.precio, 0),
    montoDev,
    creditosDev,
    costoDev,
    ingresos:       ventasTx.reduce((s: number, t: any) => s + t.precio, 0),
    creditos:       ventasTx.reduce((s: number, t: any) => s + t.creditos, 0) - creditosDev,
    costo:          ventasTx.reduce((s: number, t: any) => s + t.costo, 0) - costoDev,
    // ganancia: perdemos el precio devuelto pero recuperamos el costo de créditos
    ganancia:       ventasTx.reduce((s: number, t: any) => s + t.ganancia, 0) - (montoDev - costoDev),
  }
}

function bloqueFinanzas(titulo: string, r: ReturnType<typeof resumirTxs>, f2: (n: number) => string): string {
  const nuevasNetas = Math.max(0, r.nuevas + r.activ - r.devoluciones)
  const ingresosNuevasNetos = Math.max(0, r.ingresosNuevas + r.ingresosActiv - r.montoDev)
  return (
    `${titulo}\n` +
    `├ 🆕 ${nuevasNetas} nuevas: Bs. ${f2(ingresosNuevasNetos)}\n` +
    `├ 🔄 ${r.renov} renov.: Bs. ${f2(r.ingresosRenov)}\n` +
    `├ 💵 Ingresos netos: *Bs. ${f2(r.ingresos - r.montoDev)}*\n` +
    `├ 🪙 Créditos: ${f2(r.creditos)} = *Bs. ${f2(r.costo)}*\n` +
    `└ ✅ Ganancia: *Bs. ${f2(r.ganancia)}*`
  )
}

async function handleHistorialMensual(chatId: number, msgId: number, offset: number): Promise<void> {
  const todas = await (prisma as any).transaccion.findMany({ orderBy: { fecha: 'desc' } })
  const porMes = new Map<string, any[]>()
  for (const tx of todas) {
    const d = new Date(tx.fecha)
    const clave = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    if (!porMes.has(clave)) porMes.set(clave, [])
    porMes.get(clave)!.push(tx)
  }
  const meses = Array.from(porMes.entries()).sort((a, b) => b[0].localeCompare(a[0]))
  if (meses.length === 0) {
    await edit(chatId, msgId, '📅 No hay transacciones registradas.', kb([[{ text: '⬅️ Volver', cb: 'finanzas_menu' }]])); return
  }
  const POR_PAG = 4
  const pagina  = meses.slice(offset, offset + POR_PAG)
  const f2 = (n: number) => n.toFixed(2)
  const texto = pagina.map(([clave, txs]) => {
    const [anio, mes] = clave.split('-')
    const r = resumirTxs(txs)
    const totalNuevas = r.nuevas + r.activ
    return (
      `📆 *${MESES_ES[parseInt(mes) - 1].toUpperCase()} ${anio}*\n` +
      `├ 🆕 ${totalNuevas} nuevas  🔄 ${r.renov} renov.\n` +
      `├ 💵 Bs. ${f2(r.ingresos - r.montoDev)}\n` +
      `└ ✅ Ganancia: Bs. ${f2(r.ganancia)}`
    )
  }).join('\n\n')
  const navRow: KbRow = []
  if (offset > 0) navRow.push({ text: '⬅️ Más recientes', cb: `historial_${offset - POR_PAG}` })
  if (offset + POR_PAG < meses.length) navRow.push({ text: 'Más antiguos ➡️', cb: `historial_${offset + POR_PAG}` })
  const rows: KbRow[] = []
  if (navRow.length) rows.push(navRow)
  rows.push([{ text: '⬅️ Volver', cb: 'finanzas_menu' }])
  await edit(chatId, msgId, `📅 *HISTORIAL MENSUAL*\n\n${texto}`, kb(rows))
}

async function handleDevolucionBuscar(chatId: number, msgId: number): Promise<void> {
  pendingAction.set(ADMIN_ID, { type: 'devolucion_buscar' })
  await edit(chatId, msgId,
    `💸 *REGISTRAR DEVOLUCIÓN*\n\nEscribe el *usuario IPTV* o *número de celular* del cliente:`,
    kb([[{ text: '❌ Cancelar', cb: 'finanzas_menu' }]])
  )
}

async function handleFinanzas(chatId: number, msgId: number): Promise<void> {
  const ahora = new Date()
  const inicioDia = new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate())
  const [txHoy, precioCredito] = await Promise.all([
    (prisma as any).transaccion.findMany({ where: { fecha: { gte: inicioDia } } }),
    getPrecioCredito(),
  ])
  const hoy = resumirTxs(txHoy)
  const f2 = (n: number) => n.toFixed(2)
  await edit(chatId, msgId,
    `💰 *FINANZAS MASTV*\n\n` +
    bloqueFinanzas(`📅 *HOY*`, hoy, f2) + `\n\n` +
    `⚙️ Precio crédito: *Bs. ${precioCredito}*`,
    kb([
      [{ text: '📆 Ver por mes', cb: 'fin_meses_0' }],
      [{ text: '🔄 Actualizar', cb: 'finanzas' }, { text: '⚙️ Precio crédito', cb: 'fin_precio' }],
      [{ text: '⬅️ Volver', cb: 'finanzas_menu' }],
    ])
  )
}

async function handleFinanzasMeses(chatId: number, msgId: number, offset: number): Promise<void> {
  const todas = await (prisma as any).transaccion.findMany({ orderBy: { fecha: 'desc' } })
  const claves = new Map<string, boolean>()
  for (const tx of todas) {
    const d = new Date(tx.fecha)
    claves.set(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`, true)
  }
  const meses = Array.from(claves.keys()).sort((a, b) => b.localeCompare(a))
  if (meses.length === 0) {
    await edit(chatId, msgId, '📆 No hay transacciones registradas.', kb([[{ text: '⬅️ Volver', cb: 'finanzas' }]])); return
  }
  const POR_PAG = 8
  const pagina = meses.slice(offset, offset + POR_PAG)
  const mesRows: KbRow[] = []
  for (let i = 0; i < pagina.length; i += 2) {
    const row: KbRow = []
    const [a1, m1] = pagina[i].split('-')
    row.push({ text: `${MESES_ES[parseInt(m1) - 1]} ${a1}`, cb: `fin_mes_${pagina[i]}` })
    if (i + 1 < pagina.length) {
      const [a2, m2] = pagina[i + 1].split('-')
      row.push({ text: `${MESES_ES[parseInt(m2) - 1]} ${a2}`, cb: `fin_mes_${pagina[i + 1]}` })
    }
    mesRows.push(row)
  }
  const navRow: KbRow = []
  if (offset > 0) navRow.push({ text: '⬅️ Más recientes', cb: `fin_meses_${offset - POR_PAG}` })
  if (offset + POR_PAG < meses.length) navRow.push({ text: 'Más antiguos ➡️', cb: `fin_meses_${offset + POR_PAG}` })
  const rows: KbRow[] = [...mesRows]
  if (navRow.length) rows.push(navRow)
  rows.push([{ text: '⬅️ Volver', cb: 'finanzas' }])
  await edit(chatId, msgId, `📆 *Selecciona un mes:*`, kb(rows))
}

async function handleFinanzasMes(chatId: number, msgId: number, clave: string): Promise<void> {
  const [anioStr, mesStr] = clave.split('-')
  const anio = parseInt(anioStr)
  const mes  = parseInt(mesStr) - 1
  const inicio = new Date(anio, mes, 1)
  const fin    = new Date(anio, mes + 1, 1)
  const txs = await (prisma as any).transaccion.findMany({ where: { fecha: { gte: inicio, lt: fin } } })
  const r = resumirTxs(txs)
  const f2 = (n: number) => n.toFixed(2)
  await edit(chatId, msgId,
    `💰 *FINANZAS MASTV*\n\n` +
    bloqueFinanzas(`📆 *${MESES_ES[mes].toUpperCase()} ${anio}*`, r, f2),
    kb([
      [{ text: '📆 Otros meses', cb: 'fin_meses_0' }, { text: '⬅️ Volver', cb: 'finanzas' }],
    ])
  )
}


async function leerYGuardarCreditosInicio(): Promise<number | null> {
  const ahora = new Date()
  const clave = `creditos_inicio_${ahora.getFullYear()}_${ahora.getMonth() + 1}`
  const existe = await prisma.config.findUnique({ where: { key: clave } })
  const creditos = await leerCreditosPanel()
  if (creditos === null) return null

  if (!existe) {
    await prisma.config.upsert({
      where: { key: clave },
      update: { value: creditos.toString() },
      create: { key: clave, value: creditos.toString() },
    })
    console.log(`💾 Créditos inicio de mes guardados: ${creditos} (${clave})`)
  }
  return creditos
}

async function notificarCreditosAlArrancar(): Promise<void> {
  try {
    const creditos = await leerYGuardarCreditosInicio()
    if (creditos === null) {
      await send(ADMIN_ID, `⚠️ *Bot reiniciado*\n\nNo se pudieron leer los créditos del panel.`)
      return
    }
    const ahora = new Date()
    const clave = `creditos_inicio_${ahora.getFullYear()}_${ahora.getMonth() + 1}`
    const cfg = await prisma.config.findUnique({ where: { key: clave } })
    const inicio = cfg ? parseFloat(cfg.value) : creditos
    const txMes = await (prisma as any).transaccion.findMany({
      where: { fecha: { gte: new Date(ahora.getFullYear(), ahora.getMonth(), 1) } }
    })
    const creditosUsados = txMes.reduce((s: number, t: any) => s + t.creditos, 0)
    await send(ADMIN_ID,
      `🤖 *Bot MasTV reiniciado*\n\n` +
      `🪙 Créditos actuales en panel: *${creditos}*\n` +
      `📌 Créditos al inicio del mes: *${inicio}*\n` +
      `📉 Usados este mes (registrados): *${creditosUsados.toFixed(2)}*`
    )
  } catch (e: any) {
    console.error('❌ Error notificando créditos al arrancar:', e.message)
  }
}

async function enviarResumenMensual(anio: number, mes: number): Promise<void> {
  const inicio = new Date(anio, mes, 1)
  const fin    = new Date(anio, mes + 1, 1)
  const claveMes = `creditos_inicio_${anio}_${mes + 1}`

  const [txs, precioCredito, cfgInicio] = await Promise.all([
    (prisma as any).transaccion.findMany({ where: { fecha: { gte: inicio, lt: fin } } }),
    getPrecioCredito(),
    prisma.config.findUnique({ where: { key: claveMes } }),
  ])

  // Leer créditos actuales del panel (= saldo al cerrar el mes)
  const creditosActuales = await leerCreditosPanel()
  const creditosInicio   = cfgInicio ? parseFloat(cfgInicio.value) : null
  const r  = resumirTxs(txs)
  const f2 = (n: number) => n.toFixed(2)
  const nombreMes = `${MESES_ES[mes]} ${anio}`

  // Reconciliación
  let reconciliacion = ''
  if (creditosInicio !== null && creditosActuales !== null) {
    const consumoReal      = creditosInicio - creditosActuales
    const consumoRegistrado = r.creditos
    const diferencia        = consumoReal - consumoRegistrado
    const estado = Math.abs(diferencia) < 0.1
      ? '✅ Coincide perfectamente'
      : diferencia > 0
        ? `⚠️ Diferencia: +${f2(diferencia)} créditos sin registrar`
        : `⚠️ Diferencia: ${f2(diferencia)} (registrado de más)`
    reconciliacion =
      `\n🔍 *RECONCILIACIÓN DE CRÉDITOS*\n` +
      `├ Inicio mes: ${f2(creditosInicio)}\n` +
      `├ Fin mes: ${f2(creditosActuales)}\n` +
      `├ Consumo real: ${f2(consumoReal)}\n` +
      `├ Registrado en ventas: ${f2(consumoRegistrado)}\n` +
      `└ ${estado}`
  }

  const totalNuevas = r.nuevas + r.activ
  await send(ADMIN_ID,
    `📊 *CIERRE DE MES — ${nombreMes.toUpperCase()}*\n\n` +
    `🆕 Cuentas nuevas: *${totalNuevas}*\n` +
    `🔄 Renovaciones: *${r.renov}*\n` +
    `📦 Total ventas: *${totalNuevas + r.renov}*\n\n` +
    `💵 Ingresos: *Bs. ${f2(r.ingresos)}*\n` +
    `🪙 Créditos gastados: ${f2(r.creditos)} × Bs. ${precioCredito} = *Bs. ${f2(r.costo)}*\n` +
    `✅ Ganancia neta: *Bs. ${f2(r.ganancia)}*` +
    reconciliacion +
    `\n\n_Generado automáticamente al cierre del mes._`
  )

  // Guardar créditos actuales como inicio del nuevo mes
  if (creditosActuales !== null) {
    const nuevoMes = mes + 1 > 11 ? 1 : mes + 2
    const nuevoAnio = mes + 1 > 11 ? anio + 1 : anio
    const claveNuevo = `creditos_inicio_${nuevoAnio}_${nuevoMes}`
    await prisma.config.upsert({
      where: { key: claveNuevo },
      update: { value: creditosActuales.toString() },
      create: { key: claveNuevo, value: creditosActuales.toString() },
    })
  }

  console.log(`📊 Resumen mensual enviado: ${nombreMes}`)
}

function iniciarSchedulerMensual(): void {
  const MAX_TIMEOUT_MS = 2147483647

  function programarSiguiente(): void {
    const ahora = new Date()
    // Dispara a las 00:05 del día 1 del mes siguiente
    const siguiente = new Date(ahora.getFullYear(), ahora.getMonth() + 1, 1, 0, 5, 0)
    const msHasta = siguiente.getTime() - ahora.getTime()
    console.log(`📅 Resumen mensual programado para: ${siguiente.toLocaleString('es-BO')} (en ${Math.round(msHasta / 3600000)} h)`)

    // Si el delay supera el límite de 32 bits de Node.js, re-programar en tramos
    if (msHasta > MAX_TIMEOUT_MS) {
      setTimeout(() => programarSiguiente(), MAX_TIMEOUT_MS)
      return
    }

    setTimeout(async () => {
      // Enviar resumen del mes que acaba de terminar
      const mesCerrado = new Date(siguiente.getFullYear(), siguiente.getMonth() - 1, 1)
      try {
        await enviarResumenMensual(mesCerrado.getFullYear(), mesCerrado.getMonth())
      } catch (e: any) {
        console.error('❌ Error enviando resumen mensual:', e.message)
      }
      programarSiguiente()
    }, msHasta)
  }

  programarSiguiente()
}

async function cargarCredencialesPanel(): Promise<void> {
  const [cfgUser, cfgPass] = await Promise.all([
    prisma.config.findUnique({ where: { key: 'panel_usuario' } }),
    prisma.config.findUnique({ where: { key: 'panel_password' } }),
  ])
  if (cfgUser?.value && cfgPass?.value) {
    setPanelCredentials(cfgUser.value, cfgPass.value)
    console.log(`🔧 Credenciales del panel cargadas desde DB: ${cfgUser.value}`)
  }
}

async function handlePanelIptv(chatId: number, msgId: number): Promise<void> {
  const cfgUser = await prisma.config.findUnique({ where: { key: 'panel_usuario' } })
  const usuario = cfgUser?.value ?? '(predeterminado)'
  await edit(chatId, msgId,
    `🔧 *Panel IPTV*\n\n` +
    `👤 Usuario: \`${usuario}\`\n` +
    `🔑 Contraseña: ••••••••`,
    kb([
      [{ text: '✏️ Cambiar usuario', cb: 'panel_usuario' }, { text: '🔑 Cambiar contraseña', cb: 'panel_password' }],
      [{ text: '⬅️ Volver', cb: 'config_menu' }],
    ])
  )
}

async function handleDeleteConfirm(chatId: number, msgId: number, usuario: string): Promise<void> {
  const user = await prisma.user.findUnique({ where: { usuario } })
  if (!user) {
    await send(chatId, `❌ No se encontró el usuario *${usuario}*`, BACK_KB); return
  }
  await send(chatId,
    `🗑️ *¿Eliminar cuenta?*\n\n` +
    `👤 *${user.nombre}*\n` +
    `🔑 Usuario: \`${user.usuario}\`\n` +
    `📦 Plan: ${user.plan || '-'}\n\n` +
    `⚠️ Se eliminará la cuenta y se revertirá la transacción en finanzas.`,
    kb([
      [{ text: '✅ Sí, eliminar', cb: `del_ok_${usuario}` }, { text: '❌ Cancelar', cb: 'menu' }],
    ])
  )
}

// ── Callback query ─────────────────────────────────────────
async function handleCallback(cbId: string, chatId: number, msgId: number, data: string): Promise<void> {
  await answerCb(cbId)

  if (data === 'cancelar_wa') {
    if (!cancelarWACallback) {
      await edit(chatId, msgId, '❌ No se puede cancelar en este momento.', getConfigKb()); return
    }
    waStatus = 'desconectado'
    await edit(chatId, msgId,
      `🛑 *Vinculación cancelada*\n\nEl proceso de conexión fue detenido.\n\nPresioná *🔗 Conectar WhatsApp* cuando quieras intentar nuevamente.`,
      getConfigKb()
    )
    await cancelarWACallback()
    return
  }

  if (data === 'iniciar_wa') {
    if (!iniciarWACallback) {
      await edit(chatId, msgId, '❌ El bot no está listo para iniciar WhatsApp.', getConfigKb()); return
    }
    if (waStatus === 'conectado') {
      await edit(chatId, msgId, '✅ WhatsApp ya está conectado.', getConfigKb()); return
    }
    if (waStatus === 'conectando') {
      await edit(chatId, msgId, '⏳ Ya se está conectando, esperá el QR...', getConfigKb()); return
    }
    waStatus = 'conectando'
    await edit(chatId, msgId,
      `⏳ *Iniciando conexión con WhatsApp...*\n\nEn unos segundos recibirás el QR para escanear con tu celular.\n\n📲 Abrí WhatsApp → *Dispositivos vinculados* → *Vincular dispositivo*`,
      kb([[{ text: '⬅️ Volver', cb: 'config_menu' }]])
    )
    iniciarWACallback()
    return
  }

  if (data === 'menu') { await showMenu(chatId, msgId); return }
  if (data === 'config_menu') {
    await edit(chatId, msgId, `⚙️ *Configuración*\n\nSelecciona una opción:`, getConfigKb()); return
  }
  if (data === 'finanzas_menu') {
    await edit(chatId, msgId, `📈 *Finanzas*\n\nSelecciona una opción:`, FINANZAS_MENU_KB); return
  }
  if (data.startsWith('fin_meses_')) {
    const offset = parseInt(data.replace('fin_meses_', '')) || 0
    await handleFinanzasMeses(chatId, msgId, offset); return
  }
  if (data.startsWith('fin_mes_')) {
    const clave = data.replace('fin_mes_', '')
    await handleFinanzasMes(chatId, msgId, clave); return
  }
  if (data === 'panel_iptv') { await handlePanelIptv(chatId, msgId); return }
  if (data === 'panel_usuario') {
    pendingAction.set(ADMIN_ID, { type: 'nuevo_panel_usuario' })
    await send(chatId, `✏️ *Cambiar usuario del panel*\n\nEscribe el nuevo nombre de usuario:`, kb([[{ text: '❌ Cancelar', cb: 'panel_iptv' }]]))
    return
  }
  if (data === 'panel_password') {
    pendingAction.set(ADMIN_ID, { type: 'nuevo_panel_password' })
    await send(chatId, `🔑 *Cambiar contraseña del panel*\n\nEscribe la nueva contraseña:`, kb([[{ text: '❌ Cancelar', cb: 'panel_iptv' }]]))
    return
  }
  if (data === 'devolucion') { await handleDevolucionBuscar(chatId, msgId); return }
  if (data.startsWith('dev_ok_')) {
    const usuario = data.replace('dev_ok_', '')
    const user = await prisma.user.findUnique({ where: { usuario } })
    const ultimaTx = await (prisma as any).transaccion.findFirst({
      where: { phoneNumber: user?.celular, tipo: { not: 'devolucion' } },
      orderBy: { fecha: 'desc' },
    })
    const monto             = ultimaTx?.precio   ?? 0
    const creditosRetornados = ultimaTx?.creditos ?? 0
    const costoRetornado    = ultimaTx?.costo     ?? 0
    await (prisma as any).transaccion.create({
      data: { tipo: 'devolucion', plan: 'Devolución', precio: monto, creditos: creditosRetornados, costo: costoRetornado, ganancia: 0, phoneNumber: user?.celular ?? '' }
    })
    await prisma.user.deleteMany({ where: { usuario } })
    await edit(chatId, msgId,
      `✅ *Devolución registrada*\n\n` +
      `👤 *${user?.nombre ?? usuario}*\n` +
      `💸 Monto devuelto: *Bs. ${monto.toFixed(2)}*\n` +
      `🪙 Créditos retornados: *${creditosRetornados.toFixed(2)}*\n` +
      `🗑️ Cuenta eliminada de la base de datos.`,
      kb([[{ text: '⬅️ Finanzas', cb: 'finanzas_menu' }]])
    ); return
  }
  if (data.startsWith('dev_monto_')) {
    const usuario = data.replace('dev_monto_', '')
    pendingAction.set(ADMIN_ID, { type: 'devolucion_monto', usuarioTarget: usuario })
    await edit(chatId, msgId,
      `✏️ *MONTO PERSONALIZADO*\n\nEscribe el monto a devolver en Bs. para *${usuario}*:`,
      kb([[{ text: '❌ Cancelar', cb: 'finanzas_menu' }]])
    ); return
  }
  if (data === 'stats') { await handleStats(chatId, msgId); return }
  if (data === 'pagos') { await handlePagos(chatId, msgId); return }
  if (data === 'demos_menu') { await handleDemosMenu(chatId, msgId); return }
  if (data === 'demos_on') { await setDemosEnabled(true); await handleDemosMenu(chatId, msgId); return }
  if (data === 'demos_off') { await setDemosEnabled(false); await handleDemosMenu(chatId, msgId); return }
  if (data.startsWith('demos_clientes_')) {
    const offset = parseInt(data.replace('demos_clientes_', ''))
    await handleDemosClientes(chatId, msgId, offset); return
  }
  if (data === 'demos_liberar_confirm') {
    const total = await (prisma as any).demoHistory.count()
    await edit(chatId, msgId,
      `🔓 *¿Liberar todos los demos?*\n\nSe resetearán *${total}* historiales demo.\nTodos los clientes podrán pedir una nueva demo desde cero.`,
      kb([
        [{ text: '✅ Sí, liberar todos', cb: 'demos_liberar_ok' }, { text: '❌ Cancelar', cb: 'demos_menu' }],
      ])
    ); return
  }
  if (data === 'demos_liberar_ok') {
    const { count } = await (prisma as any).demoHistory.deleteMany()
    await edit(chatId, msgId, `✅ *${count} historiales demo eliminados.*\n\nTodos los clientes pueden pedir demos desde cero.`,
      kb([[{ text: '⬅️ Demos', cb: 'demos_menu' }]])
    ); return
  }
  if (data === 'espera') { await handleEspera(chatId, msgId); return }
  if (data.startsWith('ver_espera_')) { await handleVerEspera(chatId, msgId, data.replace('ver_espera_', '')); return }
  if (data === 'vp_menu') { await handleVpMenu(chatId, msgId); return }
  if (data === 'vp_on') { await setVeripagosEnabled(true); await handleVpMenu(chatId, msgId); return }
  if (data === 'vp_off') { await setVeripagosEnabled(false); await handleVpMenu(chatId, msgId); return }
  if (data.startsWith('ap_ok_')) {
    const phoneNumber = data.replace('ap_ok_', '')
    const result = await aprobarPagoManual(phoneNumber)
    await deleteAndSend(chatId, msgId, result, BACK_KB); return
  }
  if (data.startsWith('rj_ok_')) {
    const phoneNumber = data.replace('rj_ok_', '')
    const result = await rechazarPagoManual(phoneNumber)
    await deleteAndSend(chatId, msgId, result, BACK_KB); return
  }
  if (data.startsWith('ap_')) {
    const phoneNumber = data.replace('ap_', '')
    await edit(chatId, msgId,
      `✅ *¿Confirmar aprobación?*\n\n¿Estás seguro que deseas aprobar el pago de *${phoneNumber}*?`,
      kb([
        [{ text: '✅ Sí, aprobar', cb: `ap_ok_${phoneNumber}` }, { text: '🚫 Cancelar', cb: `ver_espera_${phoneNumber}` }],
      ])
    ); return
  }
  if (data.startsWith('rj_')) {
    const phoneNumber = data.replace('rj_', '')
    await edit(chatId, msgId,
      `❌ *¿Confirmar rechazo?*\n\n¿Estás seguro que deseas rechazar el pago de *${phoneNumber}*?`,
      kb([
        [{ text: '❌ Sí, rechazar', cb: `rj_ok_${phoneNumber}` }, { text: '🚫 Cancelar', cb: `ver_espera_${phoneNumber}` }],
      ])
    ); return
  }
  if (data.startsWith('sync_')) {
    const usuario = data.replace('sync_', '')
    await edit(chatId, msgId, `⏳ Actualizando *${usuario}* desde el panel IPTV...`)
    try {
      const updated = await sincronizarCuentaDesdePanel(usuario)
      const expStr = updated.expiresAt ? new Date(updated.expiresAt).toLocaleDateString('es-BO') : 'Sin fecha'
      const estadoLinea = updated.activated
        ? `📅 Expira: *${expStr}*`
        : `⏳ *Pendiente de primera conexión* — poller iniciado`
      await send(chatId,
        `✅ *Cuenta actualizada*\n\n` +
        `🔑 Usuario: \`${usuario}\`\n` +
        `🔐 Contraseña: \`${updated.password || '-'}\`\n` +
        `📦 Plan: ${updated.plan || '-'}\n` +
        `${estadoLinea}`,
        kb([[{ text: '🔍 Buscar otro', cb: 'buscar' }, { text: '⬅️ Menú', cb: 'menu' }]])
      )
    } catch (e: any) {
      await send(chatId, `❌ No se pudo actualizar *${usuario}*:\n_${e.message}_`, BACK_KB)
    }
    return
  }
  if (data.startsWith('del_ok_')) {
    const usuario = data.replace('del_ok_', '')
    try {
      const user = await prisma.user.findUnique({ where: { usuario } })
      const ultimaTx = await (prisma as any).transaccion.findFirst({
        where: { phoneNumber: user?.celular, tipo: { not: 'devolucion' } },
        orderBy: { fecha: 'desc' },
      })
      if (ultimaTx) {
        await (prisma as any).transaccion.create({
          data: { tipo: 'devolucion', plan: 'Reversal - cuenta eliminada', precio: ultimaTx.precio, creditos: ultimaTx.creditos, costo: ultimaTx.costo, ganancia: 0, phoneNumber: user?.celular ?? '' }
        })
      }
      await prisma.user.deleteMany({ where: { usuario } })
      await edit(chatId, msgId,
        `✅ *Cuenta eliminada*\n\n` +
        `👤 ${user?.nombre || usuario}\n` +
        `🔑 \`${usuario}\`\n\n` +
        `↩️ Transacción revertida en finanzas.`,
        BACK_KB
      )
    } catch {
      await edit(chatId, msgId, `❌ No se pudo eliminar el usuario *${usuario}*`, BACK_KB)
    }
    return
  }
  if (data.startsWith('del_') && !data.startsWith('del_ok_')) {
    const usuario = data.replace('del_', '')
    await handleDeleteConfirm(chatId, msgId, usuario); return
  }
  if (data === 'reinicio_anio') {
    const total = await (prisma as any).transaccion.count()
    await edit(chatId, msgId,
      `🗑️ *REINICIO DE AÑO*\n\n` +
      `Esto eliminará *todos* los registros de finanzas (*${total}* transacciones).\n\n` +
      `Las cuentas de clientes *no* se verán afectadas.\n\n` +
      `⚠️ Esta acción es *irreversible*. ¿Estás seguro?`,
      kb([
        [{ text: '⚠️ Sí, confirmar reinicio', cb: 'reinicio_anio_confirm' }],
        [{ text: '❌ Cancelar', cb: 'config_menu' }],
      ])
    ); return
  }
  if (data === 'reinicio_anio_confirm') {
    await edit(chatId, msgId,
      `🗑️ *ÚLTIMA CONFIRMACIÓN*\n\n` +
      `¿Seguro que deseas borrar *TODOS* los registros de finanzas?\n\n` +
      `No hay vuelta atrás.`,
      kb([
        [{ text: '🗑️ SÍ, BORRAR TODO', cb: 'reinicio_anio_ok' }],
        [{ text: '❌ Cancelar', cb: 'config_menu' }],
      ])
    ); return
  }
  if (data === 'reinicio_anio_ok') {
    const { count } = await (prisma as any).transaccion.deleteMany()
    await edit(chatId, msgId,
      `✅ *Reinicio completado*\n\n` +
      `🗑️ Se eliminaron *${count}* transacciones.\n\n` +
      `Los registros de finanzas empiezan desde cero.`,
      kb([[{ text: '⬅️ Configuración', cb: 'config_menu' }]])
    ); return
  }
  if (data === 'finanzas') { await handleFinanzas(chatId, msgId); return }
  if (data === 'toggle_pausa') {
    const pausado = !isBotPausado()
    setBotPausado(pausado)
    await edit(chatId, msgId,
      pausado
        ? `⏸️ *Bot pausado*\n\nEl bot ya no responderá mensajes de WhatsApp hasta que lo reanudes.`
        : `▶️ *Bot reanudado*\n\nEl bot vuelve a responder mensajes de WhatsApp.`,
      getConfigKb()
    ); return
  }
  if (data === 'cambiar_numero') {
    await edit(chatId, msgId,
      `📱 *CAMBIAR NÚMERO DE WHATSAPP*\n\n` +
      `⚠️ Esto desvinculará el número actual del bot.\n\n` +
      `Se te enviará un nuevo QR para escanear con el número nuevo.\n\n` +
      `¿Estás seguro?`,
      kb([
        [{ text: '✅ Sí, cambiar número', cb: 'cambiar_numero_ok' }, { text: '🚫 Cancelar', cb: 'config_menu' }],
      ])
    ); return
  }
  if (data === 'cambiar_numero_ok') {
    if (!resetSessionCallback) {
      await edit(chatId, msgId, '❌ El bot no está listo para reiniciar sesión.', BACK_KB); return
    }
    await edit(chatId, msgId, `⏳ *Desvinculando número actual...*\n\nEn unos segundos recibirás el QR para escanear.`)
    try {
      await resetSessionCallback()
    } catch (e: any) {
      await send(chatId, `❌ Error al reiniciar sesión: ${e.message}`, BACK_KB)
    }
    return
  }
  if (data === 'fin_precio') {
    pendingAction.set(ADMIN_ID, { type: 'nuevo_precio_credito' })
    await send(chatId, `⚙️ *Precio por crédito actual*\n\nEscribe el nuevo precio en Bs.\nEjemplo: *17* o *18.50*`, kb([[{ text: '❌ Cancelar', cb: 'finanzas' }]]))
    return
  }
  if (data === 'buscar') {
    pendingAction.set(ADMIN_ID, { type: 'buscando_cliente' })
    await send(chatId, '🔍 Escribe el *usuario IPTV* o el *número de celular*:', kb([[{ text: '⬅️ Menú', cb: 'menu' }]]))
    return
  }
  if (data === 'agregar') {
    pendingAction.set(ADMIN_ID, { type: 'agregar_usuario' })
    await send(chatId, '➕ *Agregar cliente*\n\nEscribe el *usuario IPTV* del cliente:', kb([[{ text: '❌ Cancelar', cb: 'menu' }]]))
    return
  }
  if (data.startsWith('clientes_')) {
    const offset = parseInt(data.replace('clientes_', ''))
    await handleClientes(chatId, msgId, offset); return
  }
  if (data.startsWith('cf_')) {
    const usuario = data.replace('cf_', '')
    pendingAction.set(ADMIN_ID, { type: 'nueva_fecha', usuarioTarget: usuario })
    await send(chatId, `📅 Nueva fecha para *${usuario}*\n\nFormato: DD/MM/YYYY\nEjemplo: *15/09/2026*`)
    return
  }
  if (data.startsWith('eu_')) {
    const usuario = data.replace('eu_', '')
    pendingAction.set(ADMIN_ID, { type: 'editar_usuario', usuarioTarget: usuario })
    await send(chatId, `✏️ Nuevo nombre de usuario IPTV para *${usuario}*\n\nEscribe el nuevo usuario:`, kb([[{ text: '❌ Cancelar', cb: 'menu' }]]))
    return
  }
  if (data.startsWith('ec_')) {
    const usuario = data.replace('ec_', '')
    pendingAction.set(ADMIN_ID, { type: 'editar_celular', usuarioTarget: usuario })
    await send(chatId, `📱 Nuevo número de celular para *${usuario}*\n\nEscribe el número (solo dígitos, ej: 591XXXXXXXX):`, kb([[{ text: '❌ Cancelar', cb: 'menu' }]]))
    return
  }
  if (data.startsWith('rem_off_')) {
    const usuario = data.replace('rem_off_', '')
    await prisma.user.update({ where: { usuario }, data: { reminderSent: true } })
    const user = await prisma.user.findUnique({ where: { usuario } })
    if (user) await mostrarCliente(chatId, user)
    return
  }
  if (data.startsWith('rem_on_')) {
    const usuario = data.replace('rem_on_', '')
    await prisma.user.update({ where: { usuario }, data: { reminderSent: false } })
    const user = await prisma.user.findUnique({ where: { usuario } })
    if (user) await mostrarCliente(chatId, user)
    return
  }
}

// ── Mensaje de texto ───────────────────────────────────────
async function handleText(chatId: number, userId: number, text: string): Promise<void> {
  console.log(`📩 [Telegram] Msg de ID=${userId}: ${text}`)

  if (userId !== ADMIN_ID) {
    console.log(`⛔ [Telegram] ID ${userId} no autorizado (esperado ${ADMIN_ID})`)
    return
  }

  if (text === '/start' || text === '/menu') { await showMenu(chatId); return }

  const state = pendingAction.get(ADMIN_ID)
  if (!state) { await send(chatId, 'Usa /menu para abrir el panel.'); return }

  if (state.type === 'buscando_cliente') {
    pendingAction.delete(ADMIN_ID)
    const users = await prisma.user.findMany({ where: { OR: [{ usuario: text }, { celular: text }] } })
    if (users.length === 0) {
      await send(chatId, `❌ No se encontró ningún cliente con *${text}*`,
        kb([[{ text: '🔍 Buscar otro', cb: 'buscar' }, { text: '⬅️ Menú', cb: 'menu' }]])
      ); return
    }
    for (const u of users) await mostrarCliente(chatId, u)
    return
  }

  if (state.type === 'nueva_fecha') {
    const usuario = state.usuarioTarget!
    pendingAction.delete(ADMIN_ID)
    if (!/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(text)) {
      await send(chatId, '⚠️ Formato inválido. Usá DD/MM/YYYY\nEjemplo: 15/09/2026', BACK_KB); return
    }
    const [td, tm, ty] = text.split('/')
    const fechaDate = new Date(parseInt(ty), parseInt(tm) - 1, parseInt(td))
    await prisma.user.update({ where: { usuario }, data: { expiresAt: fechaDate, reminderSent: false } })
    await send(chatId,
      `✅ *Fecha actualizada*\n\n👤 Usuario: \`${usuario}\`\n📅 Nueva fecha: *${text}*`,
      BACK_KB
    ); return
  }

  if (state.type === 'editar_usuario') {
    const usuarioAnterior = state.usuarioTarget!
    pendingAction.delete(ADMIN_ID)
    const nuevoUsuario = text.trim()
    if (!nuevoUsuario || nuevoUsuario.length < 3) {
      await send(chatId, '⚠️ Nombre de usuario demasiado corto. Mínimo 3 caracteres.', BACK_KB); return
    }
    const existe = await prisma.user.findUnique({ where: { usuario: nuevoUsuario } })
    if (existe) {
      await send(chatId, `⚠️ El usuario \`${nuevoUsuario}\` ya existe en la base de datos.`, BACK_KB); return
    }
    await prisma.user.update({ where: { usuario: usuarioAnterior }, data: { usuario: nuevoUsuario } })
    await send(chatId,
      `✅ *Usuario actualizado*\n\n🔑 Anterior: \`${usuarioAnterior}\`\n🔑 Nuevo: \`${nuevoUsuario}\``,
      BACK_KB
    ); return
  }

  if (state.type === 'nuevo_precio_credito') {
    pendingAction.delete(ADMIN_ID)
    const valor = parseFloat(text.trim().replace(',', '.'))
    if (isNaN(valor) || valor <= 0) {
      await send(chatId, '⚠️ Valor inválido. Escribe un número mayor a 0.\nEjemplo: *17* o *18.50*', BACK_KB); return
    }
    await prisma.config.upsert({
      where: { key: 'precio_credito' },
      update: { value: valor.toString() },
      create: { key: 'precio_credito', value: valor.toString() },
    })
    await send(chatId, `✅ *Precio de crédito actualizado*\n\n⚙️ Nuevo precio: *Bs. ${valor}*\n\n_Las transacciones anteriores no se recalculan._`, BACK_KB)
    return
  }

  if (state.type === 'editar_celular') {
    const usuario = state.usuarioTarget!
    pendingAction.delete(ADMIN_ID)
    const celularRaw = text.trim().replace(/\s+/g, '')
    if (!/^\d{7,15}$/.test(celularRaw)) {
      await send(chatId, '⚠️ Número inválido. Solo dígitos, entre 7 y 15 caracteres.', BACK_KB); return
    }
    const nuevoCelular = cleanPhoneNumber(`${celularRaw}@s.whatsapp.net`)
    await prisma.user.update({ where: { usuario }, data: { celular: nuevoCelular } })
    await send(chatId,
      `✅ *Celular actualizado*\n\n🔑 Usuario: \`${usuario}\`\n📱 Nuevo celular: \`${nuevoCelular}\``,
      BACK_KB
    ); return
  }

  if (state.type === 'agregar_usuario') {
    const usuarioIPTV = text.trim()
    if (!usuarioIPTV || usuarioIPTV.length < 2) {
      await send(chatId, '⚠️ Usuario inválido. Escribe el nombre de usuario IPTV:', kb([[{ text: '❌ Cancelar', cb: 'menu' }]])); return
    }
    pendingAction.set(ADMIN_ID, { type: 'agregar_celular', usuarioTarget: usuarioIPTV })
    await send(chatId,
      `👤 Usuario: *${usuarioIPTV}*\n\n📱 Escribe el número de celular del cliente:\nEjemplo: *59179012345*`,
      kb([[{ text: '❌ Cancelar', cb: 'menu' }]])
    ); return
  }

  if (state.type === 'agregar_celular') {
    const usuarioIPTV = state.usuarioTarget!
    const celularRaw = text.trim().replace(/\s+/g, '')
    if (!/^\d{7,15}$/.test(celularRaw)) {
      await send(chatId, '⚠️ Número inválido. Solo dígitos, entre 7 y 15 caracteres.', kb([[{ text: '❌ Cancelar', cb: 'menu' }]])); return
    }
    const celular = cleanPhoneNumber(`${celularRaw}@s.whatsapp.net`)
    pendingAction.set(ADMIN_ID, { type: 'agregar_nombre', usuarioTarget: usuarioIPTV, extra: celular })
    await send(chatId,
      `👤 Usuario: *${usuarioIPTV}*\n📱 Celular: *${celular}*\n\n✏️ Escribe el nombre completo del cliente:`,
      kb([[{ text: '❌ Cancelar', cb: 'menu' }]])
    ); return
  }

  if (state.type === 'agregar_nombre') {
    const usuarioIPTV = state.usuarioTarget!
    const celular = state.extra!
    pendingAction.delete(ADMIN_ID)
    const nombre = text.trim()
    if (!nombre || nombre.length < 2) {
      await send(chatId, '⚠️ Nombre inválido. Escribe el nombre completo del cliente.', BACK_KB); return
    }
    await send(chatId, `🔍 Buscando *${usuarioIPTV}* en el panel IPTV...`)
    try {
      const { buscarUsuarioIPTV } = await import('./iptvservice.js')
      const panelData = await buscarUsuarioIPTV(usuarioIPTV)
      const match = panelData.expira?.match(/(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/)
      const expiresAt = match ? new Date(`${match[1]}T${match[2]}:00Z`) : new Date()
      const activated = match !== null
      const planFormateado = panelData.paquete ? planPanelAFormato(panelData.paquete, panelData.conexiones) : null
      const registro = await prisma.user.upsert({
        where: { usuario: usuarioIPTV },
        update: { nombre, password: panelData.password || undefined, celular, plan: planFormateado ?? undefined, expiresAt: expiresAt ?? undefined, activated, reminderSent: false, adultChannels: true },
        create: { nombre, usuario: usuarioIPTV, password: panelData.password, celular, plan: planFormateado, expiresAt, activated, adultChannels: true },
      })
      if (!activated) iniciarPollerActivacion(usuarioIPTV, registro.id)
      const txRegistrada = await registrarTransaccionDesdePanel(panelData.paquete, panelData.conexiones, celular)
      const fechaStr = activated ? expiresAt.toLocaleDateString('es-BO') : '⏳ Pendiente de primera conexión'
      await send(chatId,
        `✅ *Cliente registrado*\n\n` +
        `👤 Nombre: *${nombre}*\n` +
        `🔑 Usuario: \`${usuarioIPTV}\`\n` +
        `🔐 Contraseña: \`${panelData.password || '-'}\`\n` +
        `📦 Plan: ${planFormateado || panelData.paquete || '-'}\n` +
        `📅 Expira: *${fechaStr}*\n` +
        `📱 Celular: \`${celular}\`\n` +
        (txRegistrada ? `💰 _Transacción registrada en finanzas_` : `⚠️ _Plan no reconocido, transacción no registrada_`),
        BACK_KB
      )
    } catch (e: any) {
      await send(chatId, `❌ No se encontró *${usuarioIPTV}* en el panel o hubo un error:\n_${e.message}_`, BACK_KB)
    }
    return
  }

  if (state.type === 'nuevo_panel_usuario') {
    pendingAction.delete(ADMIN_ID)
    const valor = text.trim()
    if (!valor || valor.length < 2) {
      await send(chatId, '⚠️ Usuario inválido. Mínimo 2 caracteres.', BACK_KB); return
    }
    await prisma.config.upsert({
      where: { key: 'panel_usuario' },
      update: { value: valor },
      create: { key: 'panel_usuario', value: valor },
    })
    const cfgPass = await prisma.config.findUnique({ where: { key: 'panel_password' } })
    if (cfgPass?.value) setPanelCredentials(valor, cfgPass.value)
    await send(chatId, `✅ *Usuario del panel actualizado*\n\n👤 Nuevo usuario: \`${valor}\``, BACK_KB)
    return
  }

  if (state.type === 'nuevo_panel_password') {
    pendingAction.delete(ADMIN_ID)
    const valor = text.trim()
    if (!valor || valor.length < 2) {
      await send(chatId, '⚠️ Contraseña inválida. Mínimo 2 caracteres.', BACK_KB); return
    }
    await prisma.config.upsert({
      where: { key: 'panel_password' },
      update: { value: valor },
      create: { key: 'panel_password', value: valor },
    })
    const cfgUser = await prisma.config.findUnique({ where: { key: 'panel_usuario' } })
    if (cfgUser?.value) setPanelCredentials(cfgUser.value, valor)
    await send(chatId, `✅ *Contraseña del panel actualizada*`, BACK_KB)
    return
  }

  if (state.type === 'devolucion_buscar') {
    pendingAction.delete(ADMIN_ID)
    const users = await prisma.user.findMany({
      where: { OR: [{ usuario: text }, { celular: text }], plan: { notIn: ['DEMO 3 HORA', 'DEMO EXPIRADA'] } },
    })
    if (users.length === 0) {
      await send(chatId, `❌ No se encontró ningún cliente con *${text}*`,
        kb([[{ text: '🔍 Intentar de nuevo', cb: 'devolucion' }, { text: '❌ Cancelar', cb: 'finanzas_menu' }]])
      ); return
    }
    const u = users[0]
    const ultimaTx = await (prisma as any).transaccion.findFirst({
      where: { phoneNumber: u.celular, tipo: { not: 'devolucion' } },
      orderBy: { fecha: 'desc' },
    })
    const monto = ultimaTx?.precio ?? 0
    await send(chatId,
      `💸 *REGISTRAR DEVOLUCIÓN*\n\n` +
      `👤 Cliente: *${u.nombre}*\n` +
      `🔑 Usuario: *${u.usuario}*\n` +
      `💰 Última transacción: *Bs. ${monto.toFixed(2)}*\n\n` +
      `¿Confirmar devolución de *Bs. ${monto.toFixed(2)}*?`,
      kb([
        [{ text: `✅ Sí, devolver Bs. ${monto.toFixed(2)}`, cb: `dev_ok_${u.usuario}` }],
        [{ text: '✏️ Monto personalizado', cb: `dev_monto_${u.usuario}` }],
        [{ text: '❌ Cancelar', cb: 'finanzas_menu' }],
      ])
    ); return
  }

  if (state.type === 'devolucion_monto') {
    const usuario = state.usuarioTarget!
    pendingAction.delete(ADMIN_ID)
    const monto = parseFloat(text.replace(',', '.'))
    if (isNaN(monto) || monto <= 0) {
      await send(chatId, '⚠️ Monto inválido. Escribe un número mayor a 0.',
        kb([[{ text: '❌ Cancelar', cb: 'finanzas_menu' }]])
      ); return
    }
    const user = await prisma.user.findUnique({ where: { usuario } })
    const ultimaTx = await (prisma as any).transaccion.findFirst({
      where: { phoneNumber: user?.celular, tipo: { not: 'devolucion' } },
      orderBy: { fecha: 'desc' },
    })
    const creditosRetornados = ultimaTx?.creditos ?? 0
    const costoRetornado    = ultimaTx?.costo     ?? 0
    await (prisma as any).transaccion.create({
      data: { tipo: 'devolucion', plan: 'Devolución', precio: monto, creditos: creditosRetornados, costo: costoRetornado, ganancia: 0, phoneNumber: user?.celular ?? '' }
    })
    await prisma.user.deleteMany({ where: { usuario } })
    await send(chatId,
      `✅ *Devolución registrada*\n\n` +
      `👤 *${user?.nombre ?? usuario}*\n` +
      `💸 Monto devuelto: *Bs. ${monto.toFixed(2)}*\n` +
      `🪙 Créditos retornados: *${creditosRetornados.toFixed(2)}*\n` +
      `🗑️ Cuenta eliminada de la base de datos.`,
      kb([[{ text: '⬅️ Finanzas', cb: 'finanzas_menu' }]])
    ); return
  }
}

// ── Polling loop ───────────────────────────────────────────
async function pollLoop(): Promise<void> {
  let offset = 0
  console.log('✅ [Telegram] Polling iniciado')

  while (running) {
    try {
      const updates: any[] = await api('getUpdates', {
        offset, timeout: 25,
        allowed_updates: ['message', 'callback_query'],
      })

      for (const upd of updates) {
        offset = upd.update_id + 1

        try {
          if (upd.message?.text) {
            const { chat, from, text } = upd.message
            await handleText(chat.id, from.id, text)
          } else if (upd.callback_query) {
            const { id, from, message, data } = upd.callback_query
            if (from.id !== ADMIN_ID) { await answerCb(id); continue }
            await handleCallback(id, message.chat.id, message.message_id, data)
          }
        } catch (e: any) {
          console.error('❌ [Telegram] Error procesando update:', e.message)
        }
      }
    } catch (e: any) {
      if (running) console.error('❌ [Telegram] Error en polling:', e.message)
      await new Promise(r => setTimeout(r, 3000))
    }
  }
}

// ── Exports ────────────────────────────────────────────────
export function iniciarTelegramAdmin(): void {
  console.log('🤖 [Telegram] Iniciando...')
  running = true

  cargarCredencialesPanel().catch(e => console.error('Error cargando credenciales panel:', e.message))
  iniciarSchedulerMensual()
  setTimeout(() => notificarCreditosAlArrancar(), 8000)

  setAdminNotifyCallback(async (text: string, phoneNumber?: string, mediaBuffer?: Buffer) => {
    const markup = phoneNumber
      ? kb([
          [{ text: '✅ Aprobar', cb: `ap_${phoneNumber}` }, { text: '❌ Rechazar', cb: `rj_${phoneNumber}` }],
        ])
      : undefined
    if (mediaBuffer && phoneNumber) {
      try {
        await sendDocument(ADMIN_ID, mediaBuffer, text, markup)
        return
      } catch {
        // fallback a texto si falla el envío del documento
      }
    }
    await send(ADMIN_ID, text, markup)
  })

  pollLoop().catch(e => console.error('❌ [Telegram] Poll loop caído:', e.message))
}

export function detenerTelegramAdmin(): void {
  running = false
  console.log('🛑 [Telegram] Detenido')
}
