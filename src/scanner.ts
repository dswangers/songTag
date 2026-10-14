import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * Return the absolute paths of every .mp3 file found directly inside
 * `folderPath` (non-recursive).  Throws if the folder does not exist.
 */
export async function scanMp3Files(folderPath: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(folderPath);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Cannot read folder "${folderPath}": ${msg}`);
  }

  return entries
    .filter((name) => path.extname(name).toLowerCase() === '.mp3')
    .map((name) => path.join(folderPath, name));
}
