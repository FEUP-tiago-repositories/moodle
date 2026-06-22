import path from 'node:path';
import fs from 'node:fs/promises';
import { chromium, type BrowserContext, type Locator, type Page } from 'playwright';
import { config } from './config.js';
import { ensureDir } from './utils.js';

export async function launchContext(): Promise<BrowserContext> {
  await ensureDir(config.profileDir);
  await ensureDir(config.downloadsDir);

  return chromium.launchPersistentContext(config.profileDir, {
    headless: true,
    acceptDownloads: true,
    downloadsPath: config.downloadsDir,
  });
}

export async function ensureAuthenticated(page: Page) {
  await page.goto(config.assignmentUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => {});

  if (await isAssignmentPage(page)) {
    return;
  }

  await login(page);

  await page.goto(config.assignmentUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => {});

  if (!(await isAssignmentPage(page))) {
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
  await page.goto(config.loginUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => {});

  const usernameCandidates = [
    page.locator('input[name="j_username"]').first(),
    page.locator('input[name="username"]').first(),
    page.locator('input[type="text"]').first(),
    page.getByLabel(/user|utilizador|username|login/i).first(),
  ];
  const passwordCandidates = [
    page.locator('input[name="j_password"]').first(),
    page.locator('input[name="password"]').first(),
    page.locator('input[type="password"]').first(),
    page.getByLabel(/password|senha/i).first(),
  ];

  const username = await firstVisible(usernameCandidates);
  const password = await firstVisible(passwordCandidates);

  if (!username || !password) {
    throw new Error('Não encontrei os campos de login automaticamente.');
  }

  await username.fill(config.upUsername);
  await password.fill(config.upPassword);

  const submitCandidates = [
    page.locator('button[type="submit"]').first(),
    page.locator('input[type="submit"]').first(),
    page.getByRole('button', { name: /login|entrar|iniciar sess[aã]o|advance|avançar|seguinte/i }).first(),
  ];

  const submit = await firstVisible(submitCandidates);
  if (!submit) {
    throw new Error('Não encontrei o botão de submissão do login.');
  }

  await Promise.all([
    page.waitForLoadState('domcontentloaded').catch(() => {}),
    submit.click(),
  ]);

  await page.waitForTimeout(3000);
}

async function firstVisible(candidates: Locator[]): Promise<Locator | null> {
  for (const locator of candidates) {
    try {
      if (await locator.isVisible({ timeout: 1500 })) return locator;
    } catch {}
  }
  return null;
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
