import fs from 'node:fs/promises';
import path from 'node:path';
import OpenAI from 'openai';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import { fromPath } from 'pdf2pic';
import { config } from './config.js';

const client = new OpenAI({ apiKey: config.openaiApiKey });

const SYSTEM_PROMPT = `
És um assistente académico especializado em responder a questões de testes e exames universitários.
Quando recebes um documento com questões (texto e/ou imagens), deves:
1. Identificar cada questão individualmente (numeradas ou não).
2. Responder a cada uma de forma clara, detalhada e correta.
3. Se houver escolha múltipla, indica a opção correta e explica porquê.
4. Se houver questões de desenvolvimento, fornece uma resposta estruturada e completa.
5. Devolver EXCLUSIVAMENTE JSON válido, sem texto antes ou depois.

Formato obrigatório:
{ "answers": [ { "question": "...", "answer": "..." } ] }
`.trim();

export type AnsweredQuestion = {
  question: string;
  answer: string;
};

/**
 * Pipeline principal: tenta extrair texto do PDF;
 * se o texto for escasso (PDF de imagens), converte páginas em imagens
 * e envia-as para a LLM via vision.
 */
export async function answerQuestionsFromPdf(filePath: string): Promise<AnsweredQuestion[]> {
  const pdfText = await extractText(filePath);
  const hasUsableText = pdfText.length > 100;
  console.log(`[solver] Texto extraído: ${pdfText.length} chars | Vision necessário: ${!hasUsableText}`);

  if (hasUsableText) {
    return answerWithText(pdfText);
  } else {
    const images = await pdfToImages(filePath);
    return answerWithVision(images);
  }
}

// ---------------------------------------------------------------------------
// Extracção de texto
// ---------------------------------------------------------------------------

async function extractText(filePath: string): Promise<string> {
  const buffer = await fs.readFile(filePath);
  const data = await pdfParse(buffer);
  return data.text.trim();
}

// ---------------------------------------------------------------------------
// Modalidade texto
// ---------------------------------------------------------------------------

async function answerWithText(pdfText: string): Promise<AnsweredQuestion[]> {
  console.log('[solver] A usar modalidade: texto');

  const response = await client.responses.create({
    model: config.openaiModel,
    instructions: SYSTEM_PROMPT,
    input: `Aqui está o conteúdo do documento com as questões:\n\n${pdfText}`,
  });

  return parseResponse(response.output_text);
}

// ---------------------------------------------------------------------------
// Modalidade vision (PDF de imagens)
// ---------------------------------------------------------------------------

async function pdfToImages(filePath: string): Promise<string[]> {
  const outputDir = path.join(path.dirname(filePath), 'pdf-pages');
  await fs.mkdir(outputDir, { recursive: true });

  const converter = fromPath(filePath, {
    density: 150,
    saveFilename: 'page',
    savePath: outputDir,
    format: 'png',
    width: 1200,
  });

  const results = await converter.bulk(-1, { responseType: 'base64' });
  const base64Images = results
    .filter((r) => r.base64)
    .map((r) => r.base64 as string);

  console.log(`[solver] ${base64Images.length} página(s) do PDF convertida(s) em imagem.`);
  return base64Images;
}

async function answerWithVision(base64Images: string[]): Promise<AnsweredQuestion[]> {
  console.log(`[solver] A usar modalidade: vision (${base64Images.length} imagens)`);

  // A Responses API espera input como array de items do tipo "message"
  // com role + content (array de blocos text / image_url)
  type TextBlock = { type: 'text'; text: string };
  type ImageBlock = { type: 'image_url'; image_url: { url: string } };
  type ContentBlock = TextBlock | ImageBlock;

  const content: ContentBlock[] = [
    {
      type: 'text',
      text: 'O documento com as questões encontra-se nas imagens seguintes. Responde às questões.',
    },
    ...base64Images.map(
      (b64): ImageBlock => ({
        type: 'image_url',
        image_url: { url: `data:image/png;base64,${b64}` },
      })
    ),
  ];

  const response = await client.responses.create({
    model: config.openaiModel,
    instructions: SYSTEM_PROMPT,
    input: [{ role: 'user', content }] as Parameters<typeof client.responses.create>[0]['input'],
  });

  return parseResponse(response.output_text);
}

// ---------------------------------------------------------------------------
// Parser da resposta JSON da LLM
// ---------------------------------------------------------------------------

function parseResponse(raw: string): AnsweredQuestion[] {
  let parsed: unknown;
  try {
    const clean = raw.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
    parsed = JSON.parse(clean);
  } catch {
    throw new Error(`A LLM devolveu JSON inválido:\n${raw.slice(0, 300)}`);
  }

  const p = parsed as Record<string, unknown>;
  const arr: AnsweredQuestion[] = Array.isArray(parsed)
    ? parsed
    : Array.isArray(p['answers']) ? (p['answers'] as AnsweredQuestion[])
    : Array.isArray(p['questions']) ? (p['questions'] as AnsweredQuestion[])
    : Array.isArray(p['results']) ? (p['results'] as AnsweredQuestion[])
    : [];

  if (arr.length === 0) {
    throw new Error(`Nenhuma questão/resposta encontrada no JSON:\n${raw.slice(0, 400)}`);
  }

  console.log(`[solver] ${arr.length} questão(ões) respondida(s).`);
  return arr;
}
