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
  await saveDebugSnapshot(page, '00-initial-load');

  if (await isAssignmentPage(page)) {
    console.log('[auth] Sessão válida, sem necessidade de login.');
    return;
  }

  console.log('[auth] Não autenticado (página de inscrição ou outra). A iniciar login...');
  await login(page);

  console.log(`[auth] A regressar à atividade: ${config.assignmentUrl}`);
  await page.goto(config.assignmentUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => {});
  console.log(`[auth] URL após login: ${page.url()}`);
  await saveDebugSnapshot(page, '10-post-login-activity');

  if (!(await isAssignmentPage(page))) {
    await saveDebugSnapshot(page, '11-final-fail');
    throw new Error('Não foi possível autenticar e abrir a página da atividade.');
  }

  console.log('[auth] Autenticado com sucesso!');
}

async function isAssignmentPage(page: Page): Promise<boolean> {
  const url = page.url();
  if (!url.includes('/mod/assign/')) return false;

  // Se redireccionou para inscrição, não é a página certa
  if (url.includes('/enrol/')) return false;

  const bodyText = await page.locator('body').innerText().catch(() => '');
  const lowerBody = bodyText.toLowerCase();
  if (lowerBody.includes('opções de inscrição') || lowerBody.includes('enrol')) return false;

  return bodyText.length > 100;
}

export async function login(page: Page) {
  // Usar o LOGIN_URL configurado — aponta diretamente para o IdP AAI da U.Porto.
  // É o URL que aparece quando se clica em "Entrar" > "Entrar U.Porto" no Moodle.
  console.log(`[login] A navegar para o IdP AAI: ${config.loginUrl}`);
  await page.goto(config.loginUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => {});
  console.log(`[login] URL do IdP: ${page.url()}`);
  await saveDebugSnapshot(page, '01-idp-page');

  // Aguardar que os campos apareçam no DOM
  await page.waitForSelector('input[type="password"]', { timeout: 15000 }).catch(() => {});

  // Dump de inputs para diagnóstico
  const inputs = await page.$$eval('input', (els) =>
    els.map((el) => ({
      type: (el as HTMLInputElement).type,
      name: (el as HTMLInputElement).name,
      id: (el as HTMLInputElement).id,
      placeholder: (el as HTMLInputElement).placeholder,
      visible: (el as HTMLInputElement).offsetParent !== null,
    }))
  );
  console.log('[login] Inputs no IdP:', JSON.stringify(inputs, null, 2));

  // A página AAI da U.Porto tem os campos com name="j_username" e name="j_password"
  const usernameSelectors = [
    'input[name="j_username"]',
    'input[name="username"]',
    'input[id="j_username"]',
    'input[id="username"]',
    'input[autocomplete="username"]',
    'input[type="text"]',
    'input[type="email"]',
  ];

  const passwordSelectors = [
    'input[name="j_password"]',
    'input[name="password"]',
    'input[id="j_password"]',
    'input[id="password"]',
    'input[autocomplete="current-password"]',
    'input[type="password"]',
  ];

  const usernameEl = await firstVisibleSelector(page, usernameSelectors);
  const passwordEl = await firstVisibleSelector(page, passwordSelectors);

  if (!usernameEl || !passwordEl) {
    await saveDebugSnapshot(page, '02-fields-not-found');
    const html = await page.content();
    await fs.writeFile(path.join(DEBUG_DIR, '02-fields-not-found.html'), html, 'utf8');
    throw new Error(
      `Não encontrei campos de login no IdP.\nInputs: ${JSON.stringify(inputs)}\nURL: ${page.url()}`
    );
  }

  console.log('[login] A preencher credenciais...');
  await usernameEl.fill(config.upUsername);
  await passwordEl.fill(config.upPassword);
  await saveDebugSnapshot(page, '03-credentials-filled');

  // O botão de submit na página AAI é "Iniciar sessão"
  const submitSelectors = [
    'button[type="submit"]',
    'input[type="submit"]',
    'button[name="_eventId_proceed"]',
    'input[name="_eventId_proceed"]',
  ];

  const submitEl = await firstVisibleSelector(page, submitSelectors);
  if (!submitEl) {
    await saveDebugSnapshot(page, '04-submit-not-found');
    throw new Error('Não encontrei o botão "Iniciar sessão" no IdP.');
  }

  console.log('[login] A submeter...');
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {}),
    submitEl.click(),
  ]);

  await page.waitForLoadState('networkidle').catch(() => {});
  console.log(`[login] URL após submissão: ${page.url()}`);
  await saveDebugSnapshot(page, '05-post-submit');

  // Tratar possível passo intermediário do SAML (relay state / consent page)
  // que pode ter um form com apenas um botão de submit
  const midUrl = page.url();
  if (!midUrl.includes('moodle2526.up.pt')) {
    console.log(`[login] Passo intermediário SAML em: ${midUrl}`);
    await page.waitForTimeout(1500);
    const continueBtn = page.locator('input[type="submit"], button[type="submit"]').first();
    if (await continueBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      console.log('[login] A submeter relay state SAML...');
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {}),
        continueBtn.click(),
      ]);
      await page.waitForLoadState('networkidle').catch(() => {});
    }
    await saveDebugSnapshot(page, '06-saml-relay');
    console.log(`[login] URL após relay: ${page.url()}`);
  }

  await saveDebugSnapshot(page, '07-login-done');
  console.log(`[login] Login concluído. URL final: ${page.url()}`);
}

async function firstVisibleSelector(page: Page, selectors: string[]): Promise<Locator | null> {
  for (const selector of selectors) {
    try {
      const locator = page.locator(selector).first();
      if (await locator.isVisible({ timeout: 1000 })) {
        console.log(`[login] Seletor encontrado: ${selector}`);
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
    console.log(`[debug] Screenshot: ${screenshotPath}`);
  } catch (e) {
    console.warn(`[debug] Falha ao guardar screenshot ${name}:`, e);
  }
}

export async function findExpectedFileLink(page: Page): Promise<Locator | null> {
  const exact = page.getByRole('link', { name: config.expectedFilename, exact: true }).first();
  if (await safeCount(exact)) return exact;

  const inFilesSection = page.locator(
    `xpath=//*[contains(normalize-space(.), 'Ficheiros')]/following::a[normalize-space(.)='${config.expectedFilename}'][1]`
  ).first();
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
