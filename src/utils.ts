import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export async function ensureDir(dirPath: string) {
  await fsp.mkdir(dirPath, { recursive: true });
}

export async function ensureParentDir(filePath: string) {
  await ensureDir(path.dirname(filePath));
}

export async function loadJson<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const raw = await fsp.readFile(filePath, 'utf8');
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export async function saveJson(filePath: string, value: unknown) {
  await ensureParentDir(filePath);
  await fsp.writeFile(filePath, JSON.stringify(value, null, 2), 'utf8');
}

export async function sha256File(filePath: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  const stream = fs.createReadStream(filePath);
  return await new Promise((resolve, reject) => {
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}
