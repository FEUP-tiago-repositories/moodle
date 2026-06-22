import { Resend } from 'resend';
import type { AnsweredQuestion } from './solver.js';
import { config } from './config.js';

const resend = new Resend(config.resendApiKey);

/**
 * Envia um email com as respostas às questões formatadas em HTML.
 */
export async function sendAnswersEmail(answers: AnsweredQuestion[], originalFilename: string) {
  const html = buildHtml(answers, originalFilename);
  const text = buildPlainText(answers, originalFilename);

  const { error } = await resend.emails.send({
    from: config.emailFrom,
    to: config.emailTo,
    subject: config.emailSubject,
    html,
    text,
  });

  if (error) {
    throw new Error(`Resend error: ${error.message}`);
  }

  console.log(`[mailer] Email com ${answers.length} respostas enviado para ${config.emailTo}`);
}

function buildHtml(answers: AnsweredQuestion[], filename: string): string {
  const rows = answers
    .map(
      (qa, i) => `
      <div style="margin-bottom:32px; padding:20px; background:#f9f9f9; border-radius:8px; border-left:4px solid #0070f3;">
        <p style="margin:0 0 8px 0; font-size:13px; color:#666; text-transform:uppercase; letter-spacing:.05em;">Questão ${i + 1}</p>
        <p style="margin:0 0 16px 0; font-size:16px; font-weight:600; color:#111;">${escapeHtml(qa.question)}</p>
        <p style="margin:0 0 6px 0; font-size:13px; color:#666; text-transform:uppercase; letter-spacing:.05em;">Resposta</p>
        <div style="font-size:15px; color:#333; line-height:1.7; white-space:pre-wrap;">${escapeHtml(qa.answer)}</div>
      </div>`
    )
    .join('');

  return `<!DOCTYPE html>
<html lang="pt">
<head><meta charset="UTF-8"><title>Respostas</title></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; max-width:720px; margin:0 auto; padding:32px 24px; color:#111;">
  <h1 style="font-size:22px; margin:0 0 4px 0;">Respostas às Questões</h1>
  <p style="margin:0 0 32px 0; color:#666; font-size:14px;">Ficheiro de origem: <code>${escapeHtml(filename)}</code></p>
  ${rows}
  <hr style="margin-top:40px; border:none; border-top:1px solid #eee;">
  <p style="font-size:12px; color:#999; margin-top:16px;">Gerado automaticamente • ${new Date().toLocaleString('pt-PT', { timeZone: 'Europe/Lisbon' })}</p>
</body>
</html>`;
}

function buildPlainText(answers: AnsweredQuestion[], filename: string): string {
  const lines = [`Respostas às Questões`, `Ficheiro: ${filename}`, ''];
  answers.forEach((qa, i) => {
    lines.push(`--- Questão ${i + 1} ---`);
    lines.push(qa.question);
    lines.push('');
    lines.push('Resposta:');
    lines.push(qa.answer);
    lines.push('');
  });
  return lines.join('\n');
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
