import { config } from './config';
import { scanMp3Files } from './scanner';
import { tagFiles } from './tagService';
import { logSuccess, logNoMatch, logError, logSummary } from './logger';
import type { TagResult } from './types';

async function main(): Promise<void> {
  console.log(`SongTag — MP3 Metadata Tagger (CLI)`);
  console.log(`Provider : ${config.provider}`);
  console.log(`Folder   : ${config.mp3Folder}`);
  console.log('');

  const files = await scanMp3Files(config.mp3Folder);

  if (files.length === 0) {
    console.log(`No MP3 files found in: ${config.mp3Folder}`);
    process.exit(0);
  }

  console.log(`Found ${files.length} MP3 file(s). Processing...\n`);

  let results: TagResult[] = [];

  await tagFiles(
    files,
    { concurrency: config.concurrency, requestDelayMs: config.requestDelayMs },
    (event) => {
      switch (event.type) {
        case 'debug':
          if (process.env.DEBUG) console.log(`  [${event.filename}] ${event.message}`);
          break;
        case 'success':
          logSuccess({ filePath: '', filename: event.filename, success: true, metadata: event.metadata });
          break;
        case 'no-match':
          logNoMatch(event.filename);
          break;
        case 'error':
          logError(event.filename, event.error);
          break;
        case 'done':
          results = event.results;
          break;
      }
    }
  );

  logSummary(results);
}

main().catch((err) => {
  console.error('Fatal error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
