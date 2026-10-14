import { spawn, execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';

const execFileAsync = promisify(execFile);

/**
 * Forcefully terminate a spawned process AND its children. yt-dlp launches
 * ffmpeg as a child, and on Windows a plain SIGTERM only kills yt-dlp itself —
 * leaving ffmpeg to finish the current file, which makes cancellation feel like
 * it hangs. taskkill /T kills the whole tree so a batch stops immediately.
 */
function killProcessTree(pid?: number): void {
  if (!pid) return;
  if (process.platform === 'win32') {
    execFile('taskkill', ['/pid', String(pid), '/T', '/F'], () => { /* best effort */ });
  } else {
    try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  }
}

/**
 * Events emitted while yt-dlp runs.
 */
export type DownloadEvent =
  | { type: 'log'; line: string }
  | { type: 'progress'; percent: number; raw: string }
  | { type: 'item-done'; file: string }
  | { type: 'done'; code: number }
  | { type: 'cancelled' }
  | { type: 'error'; message: string };

export type DownloadEventHandler = (event: DownloadEvent) => void;

export interface DownloadOptions {
  url: string;
  folder: string;
  /** Download the whole playlist if the URL belongs to one. */
  playlist: boolean;
  /** Audio quality 0 (best) – 10 (worst). Default 0. */
  audioQuality?: string;
  /** Re-download and replace files that already exist. */
  overwrite?: boolean;
}

/** Matches "[download]  42.3% of ..." progress lines from yt-dlp --newline. */
const PROGRESS_RE = /\[download\]\s+([\d.]+)%/;
/** Matches the final destination line so we can report each finished file. */
const DESTINATION_RE = /\[(?:ExtractAudio|download)\]\s+Destination:\s+(.+)$/;
const ALREADY_RE = /\[download\]\s+(.+) has already been downloaded/;

/**
 * Verify that yt-dlp and ffmpeg are reachable on the system PATH.
 * Returns the version strings or an error message for each.
 */
export async function checkDependencies(): Promise<{
  ytDlp: { ok: boolean; version?: string };
  ffmpeg: { ok: boolean; version?: string };
}> {
  const probe = async (cmd: string, args: string[]): Promise<{ ok: boolean; version?: string }> => {
    try {
      const { stdout } = await execFileAsync(cmd, args, { timeout: 10_000 });
      return { ok: true, version: stdout.split('\n')[0].trim() };
    } catch {
      return { ok: false };
    }
  };

  const [ytDlp, ffmpeg] = await Promise.all([
    probe('yt-dlp', ['--version']),
    probe('ffmpeg', ['-version']),
  ]);

  return { ytDlp, ffmpeg };
}

/**
 * Download a single video's audio to an exact MP3 path (used by the converter).
 * `outBase` is the path WITHOUT extension; the result is `${outBase}.mp3`.
 * Resolves with the final mp3 path, or rejects on failure.
 */
export function downloadVideoToFile(
  videoUrl: string,
  outBase: string,
  audioQuality: string,
  onLog: (line: string) => void,
  signal?: AbortSignal
): Promise<string> {
  const args = [
    '-x',
    '--audio-format', 'mp3',
    '--audio-quality', audioQuality,
    '--no-playlist',
    '--no-mtime',
    '--no-progress',
    '--force-overwrites',
    '--force-ipv4',          // YouTube 403s are frequently IPv6-related
    '--retries', '10',
    '--fragment-retries', '10',
    '--extractor-retries', '3',
    '-o', `${outBase}.%(ext)s`,
    videoUrl,
  ];

  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('cancelled')); return; }

    let child;
    try {
      child = spawn('yt-dlp', args, { windowsHide: true });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    // Kill the whole yt-dlp/ffmpeg tree on cancel so the current file stops now.
    const onAbort = () => killProcessTree(child.pid);
    signal?.addEventListener('abort', onAbort, { once: true });
    const cleanup = () => signal?.removeEventListener('abort', onAbort);

    const onData = (chunk: Buffer) => {
      for (const line of chunk.toString().split(/\r?\n/)) {
        if (line.trim()) onLog(line.trimEnd());
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);

    child.on('error', (err) => {
      cleanup();
      reject(signal?.aborted ? new Error('cancelled') : err);
    });
    child.on('close', (code) => {
      cleanup();
      if (signal?.aborted) reject(new Error('cancelled'));
      else if (code === 0) resolve(`${outBase}.mp3`);
      else reject(new Error(`yt-dlp exited with code ${code}`));
    });
  });
}

/**
 * Download audio from `url` into `folder` as MP3 using yt-dlp.
 * Streams progress through `onEvent`. Resolves with the process exit code.
 */
export function downloadAudio(
  options: DownloadOptions,
  onEvent: DownloadEventHandler,
  signal?: AbortSignal
): Promise<number> {
  const { url, folder, playlist, audioQuality = '0', overwrite = false } = options;

  const args = [
    '-x',
    '--audio-format', 'mp3',
    '--audio-quality', audioQuality,
    '--no-mtime',
    '--ignore-errors',          
    overwrite ? '--force-overwrites' : '--no-overwrites',
    '--newline',                
    playlist ? '--yes-playlist' : '--no-playlist',
    '-o', path.join(folder, '%(title)s [%(id)s].%(ext)s'), // ⬅️ UPDATED
    url,
  ];

  return new Promise((resolve) => {
    if (signal?.aborted) { onEvent({ type: 'cancelled' }); resolve(1); return; }

    let child;
    try {
      child = spawn('yt-dlp', args, { windowsHide: true });
    } catch (err) {
      onEvent({
        type: 'error',
        message: `Failed to start yt-dlp: ${err instanceof Error ? err.message : String(err)}`,
      });
      resolve(1);
      return;
    }

    // Kill the whole yt-dlp/ffmpeg tree on cancel so the download stops now.
    const onAbort = () => killProcessTree(child.pid);
    signal?.addEventListener('abort', onAbort, { once: true });
    const cleanup = () => signal?.removeEventListener('abort', onAbort);

    let stdoutBuffer = '';

    const handleLine = (line: string): void => {
      const trimmed = line.trimEnd();
      if (!trimmed) return;

      const progressMatch = trimmed.match(PROGRESS_RE);
      if (progressMatch) {
        onEvent({ type: 'progress', percent: parseFloat(progressMatch[1]), raw: trimmed });
        return;
      }

      const destMatch = trimmed.match(DESTINATION_RE);
      if (destMatch && destMatch[1].toLowerCase().endsWith('.mp3')) {
        onEvent({ type: 'item-done', file: path.basename(destMatch[1]) });
      }
      const alreadyMatch = trimmed.match(ALREADY_RE);
      // if (alreadyMatch) {
      //   // onEvent({ type: 'item-done', file: path.basename(alreadyMatch[1]) });
      // }

      onEvent({ type: 'log', line: trimmed });
    };

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? '';
      for (const line of lines) handleLine(line);
    });

    child.stderr.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().split(/\r?\n/)) {
        if (line.trim()) onEvent({ type: 'log', line: line.trimEnd() });
      }
    });

    child.on('error', (err) => {
      cleanup();
      if (signal?.aborted) { onEvent({ type: 'cancelled' }); resolve(1); return; }
      onEvent({
        type: 'error',
        message:
          `Could not run yt-dlp (${err.message}). ` +
          `Make sure yt-dlp is installed and on your PATH.`,
      });
      resolve(1);
    });

    child.on('close', (code) => {
      cleanup();
      if (signal?.aborted) { onEvent({ type: 'cancelled' }); resolve(1); return; }
      if (stdoutBuffer.trim()) handleLine(stdoutBuffer);
      onEvent({ type: 'done', code: code ?? 0 });
      resolve(code ?? 0);
    });
  });
}
