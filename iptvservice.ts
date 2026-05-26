import puppeteer, { Browser, Page } from 'puppeteer'

// ===============================
// VARIABLES GLOBALES
// ===============================
let browser: Browser | null = null

// ===============================
// PANEL URLs (índice 0 = principal)
// ===============================
const PANEL_BASES = [
  'https://resellermastv.com:8443',  // principal
  'http://resellermastv.com:8080',   // fallback
]
let activePanelIndex = 0

// ===============================
// UTILS
// ===============================
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

const PANEL_CREDENTIALS = { username: 'zandrotja', password: 'leon1234' }

async function navegarConLogin(page: Page, path: string): Promise<void> {
  const intentar = async (baseIndex: number): Promise<void> => {
    const url = `${PANEL_BASES[baseIndex]}${path}`
    console.log(`🌐 Conectando a: ${url}`)
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 })

    const esLoginPage = await page.$('input[placeholder="Email/Username"]') !== null
    if (!esLoginPage) return

    console.log('🔐 Detectada página de login, iniciando sesión automáticamente...')
    await page.type('#username', PANEL_CREDENTIALS.username, { delay: 80 })
    await page.type('#password', PANEL_CREDENTIALS.password, { delay: 80 })
    const rememberMe = await page.$('#remember_me')
    if (rememberMe) await rememberMe.click()
    await page.click('button[type="submit"]')
    await page.waitForNavigation({ waitUntil: 'networkidle2' })
    console.log('✅ Login exitoso')
    await page.goto(`${PANEL_BASES[baseIndex]}${path}`, { waitUntil: 'networkidle2' })
  }

  try {
    await intentar(activePanelIndex)
  } catch (e: any) {
    const fallbackIndex = activePanelIndex === 0 ? 1 : 0
    console.warn(`⚠️ Panel principal falló (${PANEL_BASES[activePanelIndex]}): ${e.message}`)
    console.log(`🔄 Cambiando a panel alternativo: ${PANEL_BASES[fallbackIndex]}`)
    activePanelIndex = fallbackIndex
    await intentar(activePanelIndex)
  }
}

function generarUsuario(): string {
  const l = 'abcdefghijklmnopqrstuvwxyz'
  const n = '0123456789'
  return (
    l[Math.floor(Math.random() * 26)] +
    l[Math.floor(Math.random() * 26)] +
    l[Math.floor(Math.random() * 26)] +
    n[Math.floor(Math.random() * 10)] +
    n[Math.floor(Math.random() * 10)] +
    n[Math.floor(Math.random() * 10)]
  )
}

// ===============================
// BROWSER
// ===============================
async function initBrowser(): Promise<void> {
  if (!browser) {
    browser = await puppeteer.launch({
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run',
        '--no-zygote',
      ]
    })
  }
}

async function closeBrowser(): Promise<void> {
  if (browser) {
    await browser.close()
    browser = null
  }
}

// ===============================
// SELECCIONAR PAQUETE
// ===============================
async function seleccionarPaquete(page: Page, texto: string): Promise<void> {
  await page.waitForSelector('.select2-selection', { visible: true })
  await page.click('.select2-selection')
  await page.type('.select2-search__field', texto, { delay: 120 })
  await page.keyboard.press('Enter')

  await page.waitForFunction(() => {
    const el = document.querySelector('.select2-selection__rendered')
    return !!(el && el.textContent && el.textContent.trim().length > 0)
  })
}

// ===============================
// FILTRAR TABLA (ESCRITURA HUMANA)
// ===============================
async function filtrarPorUsuario(page: Page, usuario: string): Promise<void> {
  await page.waitForFunction(() => {
    return document.querySelectorAll('tr.mantine-Table-tr').length > 0
  }, { timeout: 20000 })

  await delay(2000)

  const selector = '.mantine-TextInput-input[placeholder="Search"]'
  await page.waitForSelector(selector, { visible: true })

  await page.click(selector)
  await page.keyboard.down('Control')
  await page.keyboard.press('A')
  await page.keyboard.up('Control')
  await page.keyboard.press('Backspace')

  await page.type(selector, usuario, { delay: 200 })

  try {
    await page.waitForFunction(
      (usuario) => {
        const rows = document.querySelectorAll('tr.mantine-Table-tr')
        return Array.from(rows).some(r => r.textContent?.includes(usuario))
      },
      { timeout: 20000 },
      usuario
    )
  } catch {
    throw new Error(`No se encontró el usuario: ${usuario}`)
  }
}

// ===============================
// EXTRAER DATOS DE LA FILA
// ===============================
async function extraerDatosFila(page: Page, usuario: string): Promise<{
  usuario: string
  password: string
  plan: string
  expira: string
}> {
  const data = await page.evaluate((usuario) => {
    const rows = Array.from(document.querySelectorAll('tr.mantine-Table-tr'))

    for (const row of rows) {
      const username = row.querySelector('td[data-index="2"] p')?.textContent?.trim()
      if (username !== usuario) continue

      return {
        usuario: username,
        password: row.querySelector('td[data-index="3"] p')?.textContent?.trim() || '',
        expira:   row.querySelector('td[data-index="5"] p')?.getAttribute('title') || row.querySelector('td[data-index="5"] p')?.textContent?.trim() || '',
        paquete:  row.querySelector('td[data-index="7"]')?.textContent?.trim() || ''
      }
    }
    return null
  }, usuario)

  if (!data) throw new Error(`No se encontró la fila del usuario: ${usuario}`)
  if (!data.password) throw new Error(`No se pudo extraer el password del usuario: ${usuario}`)

  console.log('✅ Datos extraídos:')
  console.log('  👤 Usuario:', data.usuario)
  console.log('  🔐 Password:', data.password)
  console.log('  📅 Expira:', data.expira)
  console.log('  📦 Paquete:', data.paquete)

  return { usuario: data.usuario, password: data.password, plan: data.paquete, expira: data.expira }
}

// ===============================
// INTENTAR CREAR UN USUARIO (un solo intento)
// Devuelve los datos si tuvo éxito, lanza error si falló
// ===============================
async function quitarCanalesAdultos(page: Page): Promise<void> {
  const adultValues = ['103', '105', '153']
  await page.evaluate((vals) => {
    document.querySelectorAll<HTMLSelectElement>('select').forEach(sel => {
      if (sel.name?.includes('bouquet') || sel.id?.includes('bouquet')) {
        Array.from(sel.options).forEach(opt => {
          if (vals.includes(opt.value)) opt.selected = false
        })
      }
    })
  }, adultValues)
  await delay(500)
  console.log('🚫 Canales adultos removidos del formulario')
}

async function seleccionarCanalesAdultos(page: Page): Promise<void> {
  const adultValues = ['103', '105', '153']
  await page.evaluate((vals) => {
    document.querySelectorAll<HTMLSelectElement>('select').forEach(sel => {
      if (sel.name?.includes('bouquet') || sel.id?.includes('bouquet')) {
        Array.from(sel.options).forEach(opt => {
          if (vals.includes(opt.value)) opt.selected = true
        })
      }
    })
  }, adultValues)
  await delay(500)
  console.log('✅ Canales adultos seleccionados en el formulario')
}

async function intentarCrearUsuario(planTexto: string, incluirAdultos = true): Promise<{
  usuario: string
  password: string
  plan: string
  expira: string
}> {
  if (!browser) throw new Error('No se pudo inicializar el navegador')

  const page = await browser.newPage()
  const usuario = generarUsuario()

  console.log('👤 Usuario generado:', usuario)

  try {
    console.log('🌐 Navegando al panel...')
    await navegarConLogin(page, '/lines/create-with-package')

    console.log('📝 Escribiendo usuario...')
    await page.type('input[name="username"]', usuario)

    console.log('📦 Seleccionando paquete:', planTexto)
    await seleccionarPaquete(page, planTexto)

    console.log('⏳ Esperando 3 segundos...')
    await delay(3000)

    if (!incluirAdultos) {
      console.log('🚫 Removiendo canales adultos...')
      await quitarCanalesAdultos(page)
    }

    console.log('💾 Enviando formulario...')
    await page.evaluate(() => {
      document.querySelector<HTMLButtonElement>('#submitBtn')
        ?.closest('form')
        ?.submit()
    })

    console.log('🔄 Esperando navegación...')
    await page.waitForNavigation({ waitUntil: 'networkidle2' })

    console.log('🔍 Filtrando por usuario:', usuario)
    await filtrarPorUsuario(page, usuario)

    console.log('📊 Extrayendo datos...')
    const result = await extraerDatosFila(page, usuario)

    return result

  } finally {
    await page.close()
  }
}

// ===============================
// FLUJO PRINCIPAL — reintentos con nuevo usuario si falla
// ===============================
export async function crearUsuarioIPTV(planTexto: string, incluirAdultos = true): Promise<{
  usuario: string
  password: string
  plan: string
  expira: string
}> {
  await initBrowser()

  const MAX_INTENTOS = 3
  let ultimoError: Error | null = null

  for (let intento = 1; intento <= MAX_INTENTOS; intento++) {
    console.log(`\n🔁 Intento ${intento}/${MAX_INTENTOS}`)
    try {
      const result = await intentarCrearUsuario(planTexto, incluirAdultos)
      console.log(`✅ Usuario creado exitosamente en intento ${intento}`)
      return result
    } catch (e: any) {
      ultimoError = e
      console.warn(`⚠️ Falló intento ${intento}: ${e.message}`)
      if (intento < MAX_INTENTOS) {
        console.log(`⏳ Reintentando con nuevo usuario en 2 segundos...`)
        await delay(2000)
      }
    }
  }

  console.error(`❌ crearUsuarioIPTV falló después de ${MAX_INTENTOS} intentos`)
  throw ultimoError ?? new Error('No se pudo crear el usuario IPTV')
}

// ===============================
// LEER CRÉDITOS DEL PANEL
// ===============================
export async function leerCreditosPanel(): Promise<number | null> {
  await initBrowser()
  const page = await browser!.newPage()
  try {
    await navegarConLogin(page, '/dashboard')
    await page.waitForFunction(() => {
      const candidatos = document.querySelectorAll('p[data-size="xs"]')
      for (const p of candidatos) {
        const style = p.getAttribute('style') || ''
        if (!style.includes('margin-left')) continue
        const val = parseFloat((p as HTMLElement).innerText?.trim() || '')
        if (!isNaN(val) && val > 0) return true
      }
      return false
    }, { timeout: 20000 })

    const creditos = await page.evaluate(() => {
      const candidatos = document.querySelectorAll('p[data-size="xs"]')
      for (const p of candidatos) {
        const style = p.getAttribute('style') || ''
        if (!style.includes('margin-left')) continue
        const val = parseFloat((p as HTMLElement).innerText?.trim() || '')
        if (!isNaN(val) && val > 0) return val
      }
      return null
    })
    console.log(`🪙 Créditos en panel: ${creditos}`)
    return typeof creditos === 'number' && !isNaN(creditos) ? creditos : null
  } catch (e: any) {
    console.error('❌ Error leyendo créditos del panel:', e.message)
    return null
  } finally {
    await page.close()
  }
}

// ===============================
// CERRAR BROWSER
// ===============================
export async function cerrarNavegador(): Promise<void> {
  await closeBrowser()
}

// ===============================
// BUSCAR USUARIO IPTV EXISTENTE
// ===============================
export async function buscarUsuarioIPTV(usuario: string): Promise<{
  usuario: string
  password: string
  reseller: string
  expira: string
  baneado: string
  paquete: string
  trial: string
  conexiones: string
  creado: string
}> {
  await initBrowser()
  if (!browser) throw new Error('No se pudo inicializar el navegador')

  const page = await browser.newPage()

  try {
    console.log('🌐 Navegando al panel...')
    await navegarConLogin(page, '/lines')

    console.log('🔍 Buscando usuario:', usuario)
    await filtrarPorUsuario(page, usuario)

    console.log('📊 Extrayendo datos completos...')
    const data = await page.evaluate((usuario) => {
      const rows = Array.from(document.querySelectorAll('tr.mantine-Table-tr'))

      for (const row of rows) {
        const username = row.querySelector('td[data-index="2"] p')?.textContent?.trim()
        if (username !== usuario) continue

        return {
          usuario,
          password:   row.querySelector('td[data-index="3"] p')?.textContent?.trim() || '',
          reseller:   row.querySelector('td[data-index="4"] p')?.textContent?.trim() || '',
          expira:     row.querySelector('td[data-index="5"] p')?.getAttribute('title') || row.querySelector('td[data-index="5"] p')?.textContent?.trim() || '',
          baneado:    '',
          paquete:    row.querySelector('td[data-index="7"]')?.textContent?.trim() || '',
          trial:      '',
          conexiones: row.querySelector('td[data-index="9"] p')?.textContent?.trim() || '',
          creado:     row.querySelector('td[data-index="13"]')?.textContent?.trim() || ''
        }
      }
      return null
    }, usuario)

    if (!data) throw new Error(`No se encontró el usuario: ${usuario}`)

    console.log(`━━━━━━ CUENTA ENCONTRADA: ${data.usuario} ━━━━━━`)
    console.log(`  🔐 Password:   ${data.password}`)
    console.log(`  📅 Expira:     ${data.expira}`)
    console.log(`  📦 Paquete:    ${data.paquete}`)
    console.log(`  👤 Reseller:   ${data.reseller}`)
    console.log(`  🔗 Conexiones: ${data.conexiones}`)
    console.log(`  📆 Creado:     ${data.creado}`)
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`)

    return data

  } finally {
    await page.close()
  }
}

// ===============================
// RENOVAR USUARIO IPTV
// ===============================
export async function renovarUsuarioIPTV(usuario: string, planTexto: string): Promise<void> {
  await initBrowser()
  if (!browser) throw new Error('No se pudo inicializar el navegador')

  const page = await browser.newPage()

  try {
    console.log('🌐 Navegando al panel...')
    await navegarConLogin(page, '/lines')

    console.log('🔍 Buscando usuario:', usuario)
    await filtrarPorUsuario(page, usuario)

    await delay(2000)

    console.log('⚙️ Haciendo clic en el botón de ajustes...')
    const adjustButtonClicked = await page.evaluate((usuario) => {
      const rows = Array.from(document.querySelectorAll('tr.mantine-Table-tr'))

      for (const row of rows) {
        const username = row.querySelector('td[data-index="2"] p')?.textContent?.trim()
        if (username === usuario) {
          const actionsCell = row.querySelector('td[data-index="14"]')
          const adjustButtons = actionsCell?.querySelectorAll('button.mantine-ActionIcon-root[data-variant="light"]')

          if (adjustButtons) {
            for (const btn of Array.from(adjustButtons)) {
              const hasAdjustIcon = btn.querySelector('svg.tabler-icon-adjustments')
              if (hasAdjustIcon) {
                (btn as HTMLElement).click()
                return true
              }
            }
          }
        }
      }
      return false
    }, usuario)

    if (!adjustButtonClicked) throw new Error('No se encontró el botón de ajustes para el usuario')

    console.log('✅ Botón de ajustes presionado')
    await delay(1000)

    console.log('🔄 Haciendo clic en "Renew (extend)"...')
    await page.waitForSelector('[role="menu"]', { timeout: 5000 })

    const renewClicked = await page.evaluate(() => {
      const menuItems = Array.from(document.querySelectorAll('button[role="menuitem"]'))

      for (const item of menuItems) {
        const label = item.querySelector('.mantine-Menu-itemLabel')?.textContent?.trim()
        if (label && label.includes('Renew') && label.includes('extend')) {
          (item as HTMLElement).click()
          return true
        }
      }
      return false
    })

    if (!renewClicked) throw new Error('No se encontró la opción "Renew (extend)" en el menú')

    console.log('✅ Opción "Renew (extend)" seleccionada')
    await delay(2000)

    console.log('📦 Esperando modal de renovación...')
    await page.waitForSelector('.mantine-Select-input', { visible: true, timeout: 10000 })
    await delay(1000)

    await page.click('.mantine-Select-input')
    await delay(800)

    console.log('🔍 Buscando el plan:', planTexto)
    await page.type('.mantine-Select-input', planTexto, { delay: 100 })
    await delay(1000)

    const optionSelected = await page.evaluate((planTexto) => {
      const options = Array.from(document.querySelectorAll('[role="option"]'))

      for (const option of options) {
        const text = option.textContent?.trim() || ''
        if (text.includes(planTexto)) {
          (option as HTMLElement).click()
          return true
        }
      }
      return false
    }, planTexto)

    if (!optionSelected) {
      console.log('⚠️ No se encontró la opción exacta, seleccionando la primera opción visible...')
      await page.evaluate(() => {
        const firstOption = document.querySelector('[role="option"]')
        if (firstOption) (firstOption as HTMLElement).click()
      })
    }

    console.log('✅ Plan seleccionado')
    await delay(1500)

    console.log('💚 Haciendo clic en el botón "Renew" verde...')
    const renewButtonClicked = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button.mantine-Button-root'))

      for (const btn of buttons) {
        const label = btn.querySelector('.mantine-Button-label')?.textContent?.trim()
        const hasCartIcon = btn.querySelector('svg.tabler-icon-shopping-cart-plus')

        if (label === 'Renew' && hasCartIcon) {
          (btn as HTMLElement).click()
          return true
        }
      }
      return false
    })

    if (!renewButtonClicked) throw new Error('No se encontró el botón "Renew" verde')

    console.log('✅ Botón "Renew" presionado')
    await delay(3000)

    const success = await page.evaluate(() => {
      const notifications = Array.from(document.querySelectorAll('.mantine-Notification-root, [role="alert"]'))
      return notifications.some(notif => {
        const text = notif.textContent?.toLowerCase() || ''
        return text.includes('success') || text.includes('renewed') || text.includes('extended') || text.includes('renovad')
      })
    })

    if (success) {
      console.log('✅✅✅ Renovación completada exitosamente')
    } else {
      console.log('⚠️ Renovación completada (sin mensaje de confirmación visible)')
    }

  } catch (error) {
    console.error('❌ Error renovando usuario:', error)
    throw error

  } finally {
    await page.close()
  }
}

// ===============================
// ACTIVAR CANALES ADULTOS EN CUENTA EXISTENTE
// ===============================
export async function activarAdultosEnUsuario(usuario: string): Promise<void> {
  await initBrowser()
  if (!browser) throw new Error('No se pudo inicializar el navegador')

  const page = await browser.newPage()

  try {
    console.log('🌐 Navegando al panel...')
    await navegarConLogin(page, '/lines')

    console.log('🔍 Buscando usuario:', usuario)
    await filtrarPorUsuario(page, usuario)

    await delay(2000)

    console.log('⚙️ Haciendo clic en el botón de ajustes...')
    const adjustButtonClicked = await page.evaluate((usuario) => {
      const rows = Array.from(document.querySelectorAll('tr.mantine-Table-tr'))
      for (const row of rows) {
        const username = row.querySelector('td[data-index="2"] p')?.textContent?.trim()
        if (username === usuario) {
          const actionsCell = row.querySelector('td[data-index="14"]')
          const adjustButtons = actionsCell?.querySelectorAll('button.mantine-ActionIcon-root[data-variant="light"]')
          if (adjustButtons) {
            for (const btn of Array.from(adjustButtons)) {
              const hasAdjustIcon = btn.querySelector('svg.tabler-icon-adjustments')
              if (hasAdjustIcon) {
                (btn as HTMLElement).click()
                return true
              }
            }
          }
        }
      }
      return false
    }, usuario)

    if (!adjustButtonClicked) throw new Error('No se encontró el botón de ajustes para el usuario')

    await delay(1000)

    console.log('✏️ Haciendo clic en "Edit"...')
    await page.waitForSelector('[role="menu"]', { timeout: 5000 })

    const editClicked = await page.evaluate(() => {
      const menuItems = Array.from(document.querySelectorAll('[role="menuitem"]'))
      for (const item of menuItems) {
        const label = item.querySelector('.mantine-Menu-itemLabel')?.textContent?.trim()
        if (label === 'Edit') {
          (item as HTMLElement).click()
          return true
        }
      }
      return false
    })

    if (!editClicked) throw new Error('No se encontró la opción "Edit" en el menú')

    console.log('⏳ Esperando formulario de edición...')
    await page.waitForNavigation({ waitUntil: 'networkidle2' })
    await delay(2000)

    console.log('🔞 Activando canales adultos...')
    await seleccionarCanalesAdultos(page)

    console.log('💾 Guardando cambios...')
    await page.evaluate(() => {
      document.querySelector<HTMLButtonElement>('#submitBtn')
        ?.closest('form')
        ?.submit()
    })

    await page.waitForNavigation({ waitUntil: 'networkidle2' })
    console.log('✅ Canales adultos activados para:', usuario)

  } catch (error) {
    console.error('❌ Error activando canales adultos:', error)
    throw error

  } finally {
    await page.close()
  }
}

// ===============================
// DESACTIVAR CANALES ADULTOS EN CUENTA EXISTENTE
// ===============================
export async function desactivarAdultosEnUsuario(usuario: string): Promise<void> {
  await initBrowser()
  if (!browser) throw new Error('No se pudo inicializar el navegador')

  const page = await browser.newPage()

  try {
    console.log('🌐 Navegando al panel...')
    await navegarConLogin(page, '/lines')

    console.log('🔍 Buscando usuario:', usuario)
    await filtrarPorUsuario(page, usuario)

    await delay(2000)

    const adjustButtonClicked = await page.evaluate((usuario) => {
      const rows = Array.from(document.querySelectorAll('tr.mantine-Table-tr'))
      for (const row of rows) {
        const username = row.querySelector('td[data-index="2"] p')?.textContent?.trim()
        if (username === usuario) {
          const actionsCell = row.querySelector('td[data-index="14"]')
          const adjustButtons = actionsCell?.querySelectorAll('button.mantine-ActionIcon-root[data-variant="light"]')
          if (adjustButtons) {
            for (const btn of Array.from(adjustButtons)) {
              const hasAdjustIcon = btn.querySelector('svg.tabler-icon-adjustments')
              if (hasAdjustIcon) {
                (btn as HTMLElement).click()
                return true
              }
            }
          }
        }
      }
      return false
    }, usuario)

    if (!adjustButtonClicked) throw new Error('No se encontró el botón de ajustes para el usuario')

    await delay(1000)

    await page.waitForSelector('[role="menu"]', { timeout: 5000 })

    const editClicked = await page.evaluate(() => {
      const menuItems = Array.from(document.querySelectorAll('[role="menuitem"]'))
      for (const item of menuItems) {
        const label = item.querySelector('.mantine-Menu-itemLabel')?.textContent?.trim()
        if (label === 'Edit') {
          (item as HTMLElement).click()
          return true
        }
      }
      return false
    })

    if (!editClicked) throw new Error('No se encontró la opción "Edit" en el menú')

    await page.waitForNavigation({ waitUntil: 'networkidle2' })
    await delay(2000)

    console.log('🚫 Desactivando canales adultos...')
    await quitarCanalesAdultos(page)

    await page.evaluate(() => {
      document.querySelector<HTMLButtonElement>('#submitBtn')
        ?.closest('form')
        ?.submit()
    })

    await page.waitForNavigation({ waitUntil: 'networkidle2' })

    console.log('✅ Canales adultos desactivados para:', usuario)

  } catch (error) {
    console.error('❌ Error desactivando canales adultos:', error)
    throw error

  } finally {
    await page.close()
  }
}

//este arvchivo es iptvsercice.ts