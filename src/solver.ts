import fs from 'node:fs/promises';
import OpenAI from 'openai';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import { config } from './config.js';

const client = new OpenAI({ apiKey: config.openaiApiKey });

/**
 * Extrai o texto de um ficheiro PDF.
 */
export async function extractTextFromPdf(filePath: string): Promise<string> {
  const buffer = await fs.readFile(filePath);
  const data = await pdfParse(buffer);
  const text = data.text.trim();
  console.log(`[solver] Texto extraído do PDF (${text.length} chars)`);
  return text;
}

export type AnsweredQuestion = {
  question: string;
  answer: string;
};

/**
 * Envia o texto do PDF para a LLM e obtém as respostas às questões.
 * Devolve um array estruturado com cada questão e a respetiva resposta.
 */
export async function answerQuestions(pdfText: string): Promise<AnsweredQuestion[]> {
  console.log('[solver] A enviar questões para a LLM...');

  const systemPrompt = `
És um assistente académico especializado em responder a questões de testes e exames universitários.
Quando recebes um documento com questões, deves:
1. Identificar cada questão individualmente (numeradas ou não).
2. Responder a cada uma de forma clara, detalhada e correta.
3. Devolver a resposta EXCLUSIVAMENTE em formato JSON válido, sem texto adicional antes ou depois.

Formato de resposta obrigatório:
[
  { "question": "Texto da questão 1", "answer": "Resposta completa à questão 1" },
  { "question": "Texto da questão 2", "answer": "Resposta completa à questão 2" }
]

Se o documento contiver escolha múltipla, indica a opção correta e explica porquê.
Se contiver questões de desenvolvimento, fornece uma resposta estruturada e completa.
`.trim();

  const userPrompt = `Aqui está o conteúdo do documento com as questões:\n\n${pdfText}`;

  const response = await client.chat.completions.create({
    model: config.openaiModel,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.2,
    response_format: { type: 'json_object' },
  });

  const raw = response.choices[0]?.message?.content ?? '{}';
  console.log('[solver] Resposta da LLM recebida.');

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`A LLM devolveu JSON inválido: ${raw.slice(0, 200)}`);
  }

  // A LLM pode devolver { "questions": [...] } ou diretamente [...]
  const arr: AnsweredQuestion[] = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as Record<string, unknown>)['questions'])
      ? ((parsed as Record<string, unknown>)['questions'] as AnsweredQuestion[])
      : Array.isArray((parsed as Record<string, unknown>)['answers'])
        ? ((parsed as Record<string, unknown>)['answers'] as AnsweredQuestion[])
        : [];

  if (arr.length === 0) {
    throw new Error(`Não foi possível extrair questões/respostas do JSON: ${raw.slice(0, 400)}`);
  }

  console.log(`[solver] ${arr.length} questão(ões) respondida(s).`);
  return arr;
}
