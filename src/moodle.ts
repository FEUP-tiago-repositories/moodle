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

  // Detetar página de "Opções de inscrição" ou qualquer outra página de não-autenticado
  const needsLogin = await isEnrollmentOrLoginPage(page);
  console.log(`[auth] Necessita login: ${needsLogin}`);

  if (needsLogin) {
    await login(page);

    // Após login, voltar à página da atividade
    console.log(`[auth] A regressar à atividade: ${config.assignmentUrl}`);
    await page.goto(config.assignmentUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => {});
    console.log(`[auth] URL após login + redirect: ${page.url()}`);
    await saveDebugSnapshot(page, '10-post-login-activity');
  }

  if (!(await isAssignmentPage(page))) {
    await saveDebugSnapshot(page, '11-final-fail');
    throw new Error('Não foi possível autenticar e abrir a página da atividade.');
  }

  console.log('[auth] Autenticado com sucesso!');
}

async function isAssignmentPage(page: Page): Promise<boolean> {
  const url = page.url();
  if (!url.includes('/mod/assign/')) return false;
  // Confirmar que não é a página de opções de inscrição
  if (await isEnrollmentOrLoginPage(page)) return false;
  const bodyText = await page.locator('body').innerText().catch(() => '');
  return bodyText.length > 0;
}

async function isEnrollmentOrLoginPage(page: Page): Promise<boolean> {
  const bodyText = await page.locator('body').innerText().catch(() => '');
  const url = page.url();

  const enrollmentKeywords = [
    'opções de inscrição',
    'opcoes de inscricao',
    'enrollment options',
    'enrol options',
    'self enrolment',
    'auto-inscrição',
  ];

  const lowerBody = bodyText.toLowerCase();
  for (const kw of enrollmentKeywords) {
    if (lowerBody.includes(kw)) {
      console.log(`[auth] Detetada página de inscrição (keyword: "${kw}")`);
      return true;
    }
  }

  // Também é página de login se URL não contém moodle2526.up.pt
  if (!url.includes('moodle2526.up.pt')) {
    console.log(`[auth] URL não é do Moodle: ${url}`);
    return true;
  }

  return false;
}

export async function login(page: Page) {
  // Abrir a página de login nativa do Moodle (botão "Entrar" no canto superior direito)
  // O URL de login direto do Moodle é /login/index.php
  const moodleLoginUrl = new URL('/login/index.php', config.assignmentUrl).toString();
  console.log(`[login] A abrir página de login: ${moodleLoginUrl}`);

  await page.goto(moodleLoginUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => {});
  console.log(`[login] URL após abrir login: ${page.url()}`);
  await saveDebugSnapshot(page, '01-login-page');

  // Aguardar campos ficarem presentes no DOM
  await page.waitForSelector('input', { timeout: 10000 }).catch(() => {});

  // Dump de todos os inputs para diagnóstico
  const inputs = await page.$$eval('input', (els) =>
    els.map((el) => ({
      type: (el as HTMLInputElement).type,
      name: (el as HTMLInputElement).name,
      id: (el as HTMLInputElement).id,
      placeholder: (el as HTMLInputElement).placeholder,
      visible: (el as HTMLInputElement).offsetParent !== null,
    }))
  );
  console.log('[login] Inputs encontrados:', JSON.stringify(inputs, null, 2));

  // Verificar se há um botão de "Login via U.Porto" (SSO federado)
  // Moodle UP pode ter um botão que redireciona para o IdP SAML
  const ssoBtn = page.locator('a[href*="shibboleth"], a[href*="saml"], a[href*="up.pt"], a:has-text("U.Porto"), a:has-text("Universidade do Porto"), button:has-text("U.Porto")').first();
  if (await ssoBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
    const ssoHref = await ssoBtn.getAttribute('href');
    console.log(`[login] Detetado botão SSO U.Porto, href: ${ssoHref}`);
    await saveDebugSnapshot(page, '01b-sso-button-found');
    await ssoBtn.click();
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForLoadState('networkidle').catch(() => {});
    console.log(`[login] URL após clicar SSO: ${page.url()}`);
    await saveDebugSnapshot(page, '02-after-sso-click');
    // Aguardar campos de login do IdP
    await page.waitForSelector('input', { timeout: 10000 }).catch(() => {});
  }

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
    await saveDebugSnapshot(page, '03-fields-not-found');
    const html = await page.content();
    await fs.writeFile(path.join(DEBUG_DIR, '03-fields-not-found.html'), html, 'utf8');
    throw new Error(
      `Não encontrei os campos de login.\nInputs detetados: ${JSON.stringify(inputs)}\nURL: ${page.url()}`
    );
  }

  await usernameEl.fill(config.upUsername);
  await passwordEl.fill(config.upPassword);
  await saveDebugSnapshot(page, '04-credentials-filled');

  const submitSelectors = [
    'button[type="submit"]',
    'input[type="submit"]',
    'button[name="_eventId_proceed"]',
    'input[name="_eventId_proceed"]',
    'button',
  ];

  const submitEl = await firstVisibleSelector(page, submitSelectors);
  if (!submitEl) {
    await saveDebugSnapshot(page, '05-submit-not-found');
    throw new Error('Não encontrei o botão de submissão do login.');
  }

  console.log('[login] A submeter formulário...');
  await Promise.all([
    page.waitForLoadState('domcontentloaded').catch(() => {}),
    submitEl.click(),
  ]);

  await page.waitForTimeout(3000);
  console.log(`[login] URL após submissão: ${page.url()}`);
  await saveDebugSnapshot(page, '06-post-submit');

  // Segundo passo SAML (página de confirmação/relay state)
  const urlAfterSubmit = page.url();
  if (!urlAfterSubmit.includes('moodle2526.up.pt')) {
    console.log('[login] Possível segundo passo SAML, a aguardar...');
    await page.waitForTimeout(2000);
    const continueBtn = page.locator('input[type="submit"], button[type="submit"]').first();
    if (await continueBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      console.log('[login] A clicar em botão de continuação SAML...');
      await continueBtn.click();
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      await page.waitForTimeout(2000);
    }
    await saveDebugSnapshot(page, '07-saml-step2');
  }

  console.log(`[login] URL final após login: ${page.url()}`);
  await saveDebugSnapshot(page, '08-login-complete');
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
    console.log(`[debug] Screenshot: ${screenshotPath}`);
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
