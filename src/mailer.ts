import nodemailer from 'nodemailer';
import { config } from './config.js';

export async function sendMailWithAttachment(filePath: string, fileName: string) {
  const transporter = nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpSecure,
    auth: {
      user: config.smtpUser,
      pass: config.smtpPass,
    },
  });

  await transporter.sendMail({
    from: config.emailFrom,
    to: config.emailTo,
    subject: config.emailSubject,
    text: `Novo ficheiro Moodle encontrado: ${fileName}`,
    attachments: [
      {
        filename: fileName,
        path: filePath,
      },
    ],
  });
}
