import path from 'node:path';
import fs from 'node:fs/promises';
import { chromium, type BrowserContext, type Locator, type Page } from 'playwright';
import { config } from './config.js';
import { ensureDir } from './utils.js';

const DEBUG_DIR = './debug';

export async function launchContext(): Promise<BrowserContext> {
  await ensureDir(config.profileDir);
  await ensureDir(config.downloadsDir);
  await ensureDir(DEBUG_DIR);

  return chromium.launchPersistentContext(config.profileDir, {
    headless: true,
    acceptDownloads: true,
    downloadsPath: config.downloadsDir,
  });
}

export async function ensureAuthenticated(page: Page) {
  console.log(`[auth] A abrir: ${config.assignmentUrl}`);
  await page.goto(config.assignmentUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => {});
  console.log(`[auth] URL após redirect inicial: ${page.url()}`);

  if (await isAssignmentPage(page)) {
    console.log('[auth] Sessão válida, sem necessidade de login.');
    return;
  }

  console.log('[auth] Sessão inválida ou expirada, a tentar login...');
  await login(page);

  await page.goto(config.assignmentUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => {});
  console.log(`[auth] URL após login: ${page.url()}`);

  if (!(await isAssignmentPage(page))) {
    await saveDebugSnapshot(page, 'post-login-failed');
    throw new Error('Não foi possível autenticar e abrir a página da atividade.');
  }
}

async function isAssignmentPage(page: Page): Promise<boolean> {
  const url = page.url();
  if (!url.includes('/mod/assign/')) return false;
  const bodyText = await page.locator('body').innerText().catch(() => '');
  return bodyText.length > 0;
}

export async function login(page: Page) {
  // O fluxo da U.Porto é: aceder ao assignmentUrl → redireciona para o Shibboleth/SAML IdP.
  // Não abrimos loginUrl diretamente — deixamos o Moodle fazer o redirect natural
  // para garantir que o URL do IdP tem os parâmetros SAML corretos.
  console.log(`[login] URL atual (IdP): ${page.url()}`);

  // Guardar snapshot para debug
  await saveDebugSnapshot(page, '01-idp-initial');

  // Aguardar campos ficarem presentes no DOM (alguns IdPs carregam via JS)
  await page.waitForSelector('input', { timeout: 10000 }).catch(() => {});

  // Dump de todos os inputs visíveis para diagnóstico
  const inputs = await page.$$eval('input', (els) =>
    els.map((el) => ({
      type: (el as HTMLInputElement).type,
      name: (el as HTMLInputElement).name,
      id: (el as HTMLInputElement).id,
      placeholder: (el as HTMLInputElement).placeholder,
      visible: (el as HTMLInputElement).offsetParent !== null,
    }))
  );
  console.log('[login] Inputs encontrados na página:', JSON.stringify(inputs, null, 2));

  // Tentar encontrar campo username com múltiplos seletores
  const usernameSelectors = [
    'input[name="j_username"]',
    'input[name="username"]',
    'input[name="user"]',
    'input[id="username"]',
    'input[id="j_username"]',
    'input[autocomplete="username"]',
    'input[type="text"]',
    'input[type="email"]',
  ];

  const passwordSelectors = [
    'input[name="j_password"]',
    'input[name="password"]',
    'input[id="password"]',
    'input[id="j_password"]',
    'input[autocomplete="current-password"]',
    'input[type="password"]',
  ];

  const usernameEl = await firstVisibleSelector(page, usernameSelectors);
  const passwordEl = await firstVisibleSelector(page, passwordSelectors);

  if (!usernameEl || !passwordEl) {
    await saveDebugSnapshot(page, '02-login-fields-not-found');
    const html = await page.content();
    await fs.writeFile(path.join(DEBUG_DIR, '02-login-fields-not-found.html'), html, 'utf8');
    throw new Error(
      `Não encontrei os campos de login.\nInputs detetados: ${JSON.stringify(inputs)}\nURL: ${page.url()}`
    );
  }

  await usernameEl.fill(config.upUsername);
  await passwordEl.fill(config.upPassword);
  await saveDebugSnapshot(page, '03-credentials-filled');

  const submitSelectors = [
    'button[type="submit"]',
    'input[type="submit"]',
    'button[name="_eventId_proceed"]',
    'input[name="_eventId_proceed"]',
    'button',
  ];

  const submitEl = await firstVisibleSelector(page, submitSelectors);
  if (!submitEl) {
    await saveDebugSnapshot(page, '04-submit-not-found');
    throw new Error('Não encontrei o botão de submissão do login.');
  }

  console.log('[login] A submeter formulário...');
  await Promise.all([
    page.waitForLoadState('domcontentloaded').catch(() => {}),
    submitEl.click(),
  ]);

  await page.waitForTimeout(3000);
  console.log(`[login] URL após submissão: ${page.url()}`);
  await saveDebugSnapshot(page, '05-post-submit');

  // Verificar se há um segundo passo (ex: página de confirmação/accept SAML)
  const currentUrl = page.url();
  if (!currentUrl.includes('/mod/assign/') && !currentUrl.includes('moodle')) {
    console.log('[login] Possível segundo passo no fluxo SAML, a aguardar...');
    await page.waitForTimeout(2000);
    // Tentar clicar em qualquer botão de continuação se existir
    const continueBtn = page.locator('input[type="submit"], button[type="submit"]').first();
    if (await continueBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      console.log('[login] A clicar em botão de continuação SAML...');
      await continueBtn.click();
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      await page.waitForTimeout(2000);
    }
  }

  console.log(`[login] URL final: ${page.url()}`);
}

async function firstVisibleSelector(page: Page, selectors: string[]): Promise<Locator | null> {
  for (const selector of selectors) {
    try {
      const locator = page.locator(selector).first();
      if (await locator.isVisible({ timeout: 1000 })) {
        console.log(`[login] Encontrado seletor: ${selector}`);
        return locator;
      }
    } catch {}
  }
  return null;
}

async function saveDebugSnapshot(page: Page, name: string) {
  try {
    const screenshotPath = path.join(DEBUG_DIR, `${name}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log(`[debug] Screenshot guardado: ${screenshotPath}`);
  } catch (e) {
    console.warn(`[debug] Falha ao guardar screenshot ${name}:`, e);
  }
}

export async function findExpectedFileLink(page: Page): Promise<Locator | null> {
  const exact = page.getByRole('link', { name: config.expectedFilename, exact: true }).first();
  if (await safeCount(exact)) return exact;

  const inFilesSection = page.locator(`xpath=//*[contains(normalize-space(.), 'Ficheiros')]/following::a[normalize-space(.)='${config.expectedFilename}'][1]`).first();
  if (await safeCount(inFilesSection)) return inFilesSection;

  const fallback = page.locator(`a:has-text("${config.expectedFilename}")`).first();
  if (await safeCount(fallback)) return fallback;

  return null;
}

async function safeCount(locator: Locator): Promise<boolean> {
  try {
    return (await locator.count()) > 0;
  } catch {
    return false;
  }
}

export async function downloadFile(page: Page, link: Locator): Promise<string> {
  const downloadPromise = page.waitForEvent('download', { timeout: 15000 }).catch(() => null);
  await link.click();
  const download = await downloadPromise;

  if (download) {
    const target = path.join(config.downloadsDir, download.suggestedFilename() || config.expectedFilename);
    await download.saveAs(target);
    return target;
  }

  const href = await link.getAttribute('href');
  if (!href) throw new Error('O link do ficheiro não tem href.');
  const url = new URL(href, page.url()).toString();
  const response = await page.context().request.get(url);
  if (!response.ok()) {
    throw new Error(`Falha no download: ${response.status()} ${response.statusText()}`);
  }

  const filePath = path.join(config.downloadsDir, config.expectedFilename);
  await fs.writeFile(filePath, Buffer.from(await response.body()));
  return filePath;
}
