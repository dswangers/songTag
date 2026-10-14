import type { TagResult } from './types';

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

export function logSuccess(result: TagResult): void {
  const meta = result.metadata!;
  console.log(
    `${GREEN}✓${RESET} ${meta.title} — ${meta.artist}` +
    `${DIM} [${meta.album}${meta.year ? `, ${meta.year}` : ''}]${RESET}`
  );
}

export function logNoMatch(filename: string): void {
  console.log(`${YELLOW}?${RESET} No match found for: ${DIM}${filename}${RESET}`);
}

export function logError(filename: string, error: string): void {
  console.log(`${RED}✗${RESET} Error tagging ${DIM}${filename}${RESET}: ${error}`);
}

export function logSummary(results: TagResult[]): void {
  const total = results.length;
  const ok = results.filter((r) => r.success).length;
  const skipped = results.filter((r) => !r.success && !r.error).length;
  const failed = total - ok - skipped;

  console.log('');
  console.log('─'.repeat(50));
  console.log(`  Total files : ${total}`);
  console.log(`  ${GREEN}Tagged       : ${ok}${RESET}`);
  if (skipped) console.log(`  ${YELLOW}No match     : ${skipped}${RESET}`);
  if (failed)  console.log(`  ${RED}Errors       : ${failed}${RESET}`);
  console.log('─'.repeat(50));
}
