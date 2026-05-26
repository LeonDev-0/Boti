import { prisma } from './lib/prisma.js'
import {
  isDemosEnabled, setDemosEnabled, getPagosPendientes,
  isVeripagosEnabled, setVeripagosEnabled,
  aprobarPagoManual, rechazarPagoManual,
  setAdminNotifyCallback, getPagosManualPendientes,
  iniciarPollerActivacion, cleanPhoneNumber, planPanelAFormato, sincronizarCuentaDesdePanel,
  setBotPausado, isBotPausado,
} from './messageHandler.js'
import { leerCreditosPanel } from './iptvservice.js'

console.log('📦 telegramAdmin.ts: módulo cargado')

const TOKEN    = '8673050602:AAFuGN6e_JbRV_MRJ-mq2NfZ1RWZE1ftGBE'
const ADMIN_ID = 1194525126
const API_URL  = `https://api.telegram.org/bot${TOKEN}`

let running = false

// ── Callbacks desde boti.ts ────────────────────────────────
let resetSessionCallback: (() => Promise<void>) | null = null

export function setResetSessionCallback(fn: () => Promise<void>): void {
  resetSessionCallback = fn
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
  try {
    await send(ADMIN_ID, `✅ *Bot conectado correctamente*\n\n📱 Número activo: *+${numero}*`)
  } catch (e: any) {
    console.error('❌ Error notificando conexión a Telegram:', e.message)
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
  return kb([
    [{ text: '🎬 Demos', cb: 'demos_menu' }, { text: '💲 VeriPagos', cb: 'vp_menu' }],
    [{ text: '📱 Cambiar número', cb: 'cambiar_numero' }],
    [{ text: pausado ? '▶️ Reanudar bot' : '⏸️ Pausar bot', cb: 'toggle_pausa' }],
    [{ text: '⬅️ Menú', cb: 'menu' }],
  ])
}
const FINANZAS_MENU_KB = kb([
  [{ text: '📊 Estadísticas', cb: 'stats' }, { text: '💰 Finanzas', cb: 'finanzas' }],
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

  const renovaciones = txTotal.filter((t: any) => t.tipo === 'renovacion').length
  const ingresos     = txTotal.reduce((s: number, t: any) => s + t.precio, 0)
  const costos       = txTotal.reduce((s: number, t: any) => s + t.costo, 0)
  const ganancia     = txTotal.reduce((s: number, t: any) => s + t.ganancia, 0)
  const creditos     = txTotal.reduce((s: number, t: any) => s + t.creditos, 0)
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
    `💸 Costos operativos: *Bs. ${f2(costos)}*\n` +
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
  const nuevasTx    = txs.filter((t: any) => t.tipo === 'nueva')
  const renovTx     = txs.filter((t: any) => t.tipo === 'renovacion')
  const activTx     = txs.filter((t: any) => t.tipo === 'activacion')
  return {
    nuevas:          nuevasTx.length,
    renov:           renovTx.length,
    activ:           activTx.length,
    ingresosNuevas:  nuevasTx.reduce((s: number, t: any) => s + t.precio, 0),
    ingresosRenov:   renovTx.reduce((s: number, t: any)  => s + t.precio, 0),
    ingresosActiv:   activTx.reduce((s: number, t: any)  => s + t.precio, 0),
    ingresos:        txs.reduce((s: number, t: any) => s + t.precio, 0),
    creditos:        txs.reduce((s: number, t: any) => s + t.creditos, 0),
    costo:           txs.reduce((s: number, t: any) => s + t.costo, 0),
    ganancia:        txs.reduce((s: number, t: any) => s + t.ganancia, 0),
  }
}

function bloqueFinanzas(titulo: string, r: ReturnType<typeof resumirTxs>, f2: (n: number) => string): string {
  const lineasMedio = [
    `├ 🆕 ${r.nuevas} nuevas: Bs. ${f2(r.ingresosNuevas)}`,
    `├ 🔄 ${r.renov} renov.: Bs. ${f2(r.ingresosRenov)}`,
    ...(r.activ > 0 ? [`├ ✨ ${r.activ} activ. demo: Bs. ${f2(r.ingresosActiv)}`] : []),
  ]
  return (
    `${titulo}\n` +
    lineasMedio.join('\n') + '\n' +
    `├ 💵 Total ingresos: *Bs. ${f2(r.ingresos)}*\n` +
    `├ 🪙 Créditos usados: ${f2(r.creditos)}\n` +
    `└ ✅ Ganancia: *Bs. ${f2(r.ganancia)}*`
  )
}

async function handleFinanzas(chatId: number, msgId: number): Promise<void> {
  const ahora = new Date()
  const inicioDia = new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate())
  const inicioMes = new Date(ahora.getFullYear(), ahora.getMonth(), 1)

  const [txHoy, txMes, txTotal, precioCredito] = await Promise.all([
    (prisma as any).transaccion.findMany({ where: { fecha: { gte: inicioDia } } }),
    (prisma as any).transaccion.findMany({ where: { fecha: { gte: inicioMes } } }),
    (prisma as any).transaccion.findMany({}),
    getPrecioCredito(),
  ])

  const hoy   = resumirTxs(txHoy)
  const mes   = resumirTxs(txMes)
  const total = resumirTxs(txTotal)
  const f2 = (n: number) => n.toFixed(2)

  await edit(chatId, msgId,
    `💰 *FINANZAS MASTV*\n\n` +
    bloqueFinanzas(`📅 *HOY*`, hoy, f2) + `\n\n` +
    bloqueFinanzas(`📆 *${MESES_ES[ahora.getMonth()].toUpperCase()} ${ahora.getFullYear()}*`, mes, f2) + `\n\n` +
    bloqueFinanzas(`🏆 *TOTAL ACUMULADO*`, total, f2) + `\n\n` +
    `⚙️ Precio crédito: *Bs. ${precioCredito}*`,
    kb([
      [{ text: '🔄 Actualizar', cb: 'finanzas' }, { text: '⚙️ Cambiar precio crédito', cb: 'fin_precio' }],
      [{ text: '⬅️ Volver', cb: 'finanzas_menu' }],
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
  function programarSiguiente(): void {
    const ahora = new Date()
    // Dispara a las 00:05 del día 1 del mes siguiente
    const siguiente = new Date(ahora.getFullYear(), ahora.getMonth() + 1, 1, 0, 5, 0)
    const msHasta = siguiente.getTime() - ahora.getTime()
    console.log(`📅 Resumen mensual programado para: ${siguiente.toLocaleString('es-BO')} (en ${Math.round(msHasta / 3600000)} h)`)

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

async function handleDeleteConfirm(chatId: number, msgId: number, usuario: string): Promise<void> {
  const user = await prisma.user.findUnique({ where: { usuario } })
  if (!user) {
    await send(chatId, `❌ No se encontró el usuario *${usuario}*`, BACK_KB); return
  }
  await send(chatId,
    `🗑️ *¿Eliminar usuario?*\n\n` +
    `👤 *${user.nombre}*\n` +
    `🔑 Usuario: \`${user.usuario}\`\n` +
    `📦 Plan: ${user.plan || '-'}\n\n` +
    `⚠️ Esta acción *no se puede deshacer*.`,
    kb([
      [{ text: '✅ Sí, eliminar', cb: `del_ok_${usuario}` }, { text: '❌ Cancelar', cb: 'menu' }],
    ])
  )
}

// ── Callback query ─────────────────────────────────────────
async function handleCallback(cbId: string, chatId: number, msgId: number, data: string): Promise<void> {
  await answerCb(cbId)

  if (data === 'menu') { await showMenu(chatId, msgId); return }
  if (data === 'config_menu') {
    await edit(chatId, msgId, `⚙️ *Configuración*\n\nSelecciona una opción:`, getConfigKb()); return
  }
  if (data === 'finanzas_menu') {
    await edit(chatId, msgId, `📈 *Finanzas*\n\nSelecciona una opción:`, FINANZAS_MENU_KB); return
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
      await prisma.user.delete({ where: { usuario } })
      await edit(chatId, msgId,
        `✅ *Usuario eliminado*\n\n👤 ${user?.nombre || usuario}\n🔑 \`${usuario}\``,
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
      const fechaStr = activated ? expiresAt.toLocaleDateString('es-BO') : '⏳ Pendiente de primera conexión'
      await send(chatId,
        `✅ *Cliente registrado*\n\n` +
        `👤 Nombre: *${nombre}*\n` +
        `🔑 Usuario: \`${usuarioIPTV}\`\n` +
        `🔐 Contraseña: \`${panelData.password || '-'}\`\n` +
        `📦 Plan: ${planFormateado || panelData.paquete || '-'}\n` +
        `📅 Expira: *${fechaStr}*\n` +
        `📱 Celular: \`${celular}\``,
        BACK_KB
      )
    } catch (e: any) {
      await send(chatId, `❌ No se encontró *${usuarioIPTV}* en el panel o hubo un error:\n_${e.message}_`, BACK_KB)
    }
    return
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
