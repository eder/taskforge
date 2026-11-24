import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ProcessRunner } from '@taskforge/execution';

export interface VoiceTranscriptionResult {
  ok: boolean;
  transcript?: string;
  backend?: string;
  error?: string;
}

async function hasBinary(bin: string): Promise<boolean> {
  const res = await ProcessRunner.run({ command: 'which', args: [bin], timeoutMs: 3000 }).catch(() => ({
    exitCode: 1,
  }));
  return res.exitCode === 0;
}

/**
 * Local-first voice input service for `/voice [seconds]`.
 * Supports:
 * 1. Custom command via `TASKFORGE_VOICE_CMD` (prints transcribed text to stdout).
 * 2. Local `rec` (sox) + `whisper` / `whisper-cli` (zero cloud audio upload!).
 */
export class VoiceInputService {
  public async detectBackend(): Promise<{ available: boolean; backend?: string; hint?: string }> {
    if (process.env.TASKFORGE_VOICE_CMD?.trim()) {
      return { available: true, backend: 'custom (TASKFORGE_VOICE_CMD)' };
    }
    const [hasRec, hasWhisperCli, hasWhisper] = await Promise.all([
      hasBinary('rec'),
      hasBinary('whisper-cli'),
      hasBinary('whisper'),
    ]);
    if (hasRec && (hasWhisperCli || hasWhisper)) {
      return { available: true, backend: hasWhisperCli ? 'sox + whisper-cli' : 'sox + whisper' };
    }
    return {
      available: false,
      hint: 'Install local audio tools (`brew install sox whisper-cpp`) or set TASKFORGE_VOICE_CMD to a command that outputs transcribed text.',
    };
  }

  public async recordAndTranscribe(durationSeconds = 8): Promise<VoiceTranscriptionResult> {
    const customCmd = process.env.TASKFORGE_VOICE_CMD?.trim();
    if (customCmd) {
      const res = await ProcessRunner.run({
        command: process.env.SHELL || '/bin/sh',
        args: ['-lc', customCmd],
        timeoutMs: Math.max(20_000, (durationSeconds + 15) * 1000),
      });
      const text = res.stdout.trim();
      if (res.exitCode !== 0 || !text) {
        return { ok: false, backend: 'custom', error: res.stderr.trim() || 'Voice command produced no text.' };
      }
      return { ok: true, transcript: text, backend: 'custom (TASKFORGE_VOICE_CMD)' };
    }

    const detected = await this.detectBackend();
    if (!detected.available) {
      return { ok: false, error: detected.hint };
    }

    const secs = Math.max(2, Math.min(45, Math.round(durationSeconds)));
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-voice-'));
    const wavPath = path.join(tmpDir, `clip-${randomUUID().slice(0, 6)}.wav`);

    try {
      const recRes = await ProcessRunner.run({
        command: 'rec',
        args: ['-q', '-r', '16000', '-c', '1', wavPath, 'trim', '0', String(secs)],
        timeoutMs: (secs + 10) * 1000,
      });
      if (recRes.exitCode !== 0 || !fs.existsSync(wavPath)) {
        return { ok: false, backend: detected.backend, error: recRes.stderr.trim() || 'Audio recording failed.' };
      }

      if (detected.backend === 'sox + whisper-cli') {
        const wRes = await ProcessRunner.run({
          command: 'whisper-cli',
          args: ['-f', wavPath, '--no-timestamps'],
          timeoutMs: 60_000,
        });
        const text = wRes.stdout.trim();
        return text
          ? { ok: true, transcript: text, backend: detected.backend }
          : { ok: false, backend: detected.backend, error: wRes.stderr.trim() || 'Empty transcription.' };
      }

      const wRes = await ProcessRunner.run({
        command: 'whisper',
        args: [wavPath, '--output_format', 'txt', '--output_dir', tmpDir, '--fp16', 'False'],
        timeoutMs: 60_000,
      });
      const txtFile = wavPath.replace(/\.wav$/, '.txt');
      const text = fs.existsSync(txtFile) ? fs.readFileSync(txtFile, 'utf8').trim() : wRes.stdout.trim();
      return text
        ? { ok: true, transcript: text, backend: detected.backend }
        : { ok: false, backend: detected.backend, error: wRes.stderr.trim() || 'Empty transcription.' };
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }
}
