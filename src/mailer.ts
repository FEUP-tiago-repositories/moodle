import fs from 'node:fs/promises';
import path from 'node:path';
import { Resend } from 'resend';
import { config } from './config.js';

const resend = new Resend(config.resendApiKey);

export async function sendMailWithAttachment(filePath: string, fileName: string) {
  const fileBuffer = await fs.readFile(filePath);
  const base64Content = fileBuffer.toString('base64');
  const ext = path.extname(fileName).toLowerCase();
  const mimeType = ext === '.pdf' ? 'application/pdf' : 'application/octet-stream';

  const { error } = await resend.emails.send({
    from: config.emailFrom,
    to: config.emailTo,
    subject: config.emailSubject,
    text: `Novo ficheiro Moodle encontrado: ${fileName}`,
    attachments: [
      {
        filename: fileName,
        content: base64Content,
        contentType: mimeType,
      },
    ],
  });

  if (error) {
    throw new Error(`Resend error: ${error.message}`);
  }
}
