import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

export async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

export async function imageMetadataGetter(filePath) {
  const data = await fs.readFile(filePath);
  const metadata = await sharp(data).metadata();
  return {
    height: metadata.height,
    width: metadata.width,
    size: metadata.size || data.length,
  };
}

export function safeFilename(name, fallback = 'file') {
  const clean = String(name || fallback)
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .slice(0, 120);
  return clean || fallback;
}

export function uniqueDownloadPath(downloadDir, prefix, extension = '') {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const suffix = extension && extension.startsWith('.') ? extension : `.${extension || 'bin'}`;
  return path.join(downloadDir, `${safeFilename(prefix)}-${stamp}${suffix}`);
}
