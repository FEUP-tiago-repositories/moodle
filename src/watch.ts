import path from 'node:path';
import { config } from './config.js';
import { sendAnswersEmail } from './mailer.js';
import { downloadFile, ensureAuthenticated, findExpectedFileLink, launchContext } from './moodle.js';
import { answerQuestionsFromPdf } from './solver.js';
import { loadJson, saveJson, sha256File } from './utils.js';

type State = {
  lastHash?: string;
  lastFilename?: string;
  lastSentAt?: string;
};

async function main() {
  const context = await launchContext();
  try {
    const page = context.pages()[0] ?? await context.newPage();
    await ensureAuthenticated(page);

    await page.goto(config.assignmentUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => {});

    const link = await findExpectedFileLink(page);
    if (!link) {
      console.log(`[watch] "${config.expectedFilename}" ainda não existe na submissão.`);
      return;
    }

    const filePath = await downloadFile(page, link);
    const fileHash = await sha256File(filePath);
    const state = await loadJson<State>(config.stateFile, {});

    if (state.lastHash === fileHash) {
      console.log('[watch] Ficheiro já processado anteriormente, nada a fazer.');
      return;
    }

    const fileName = path.basename(filePath);
    console.log(`[watch] Novo ficheiro detetado: ${fileName}`);

    // Extrair texto ou imagens do PDF e obter respostas via LLM
    const answers = await answerQuestionsFromPdf(filePath);

    // Enviar email com as respostas
    await sendAnswersEmail(answers, fileName);

    await saveJson(config.stateFile, {
      lastHash: fileHash,
      lastFilename: fileName,
      lastSentAt: new Date().toISOString(),
    } satisfies State);

    console.log(`[watch] Concluído: ${answers.length} respostas enviadas.`);
  } finally {
    await context.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
