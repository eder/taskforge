import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import { TaskForgeDatabase } from '@taskforge/persistence';
import { InteractiveShell, findWordLeft, findWordRight } from '../src/interactive-shell.js';
import { TerminalViewport } from '../src/terminal-viewport.js';

describe('Interactive Terminal Prompt & REPL', () => {
  describe('Word boundary navigation', () => {
    it('moves backward across words correctly', () => {
      const text = 'create user auth endpoint';
      // At end of string (index 25)
      expect(findWordLeft(text, 25)).toBe(17); // starts of 'endpoint'
      expect(findWordLeft(text, 17)).toBe(12); // starts of 'auth'
      expect(findWordLeft(text, 12)).toBe(7); // starts of 'user'
      expect(findWordLeft(text, 7)).toBe(0); // starts of 'create'
      expect(findWordLeft(text, 0)).toBe(0);
    });

    it('moves forward across words correctly', () => {
      const text = 'create user auth endpoint';
      expect(findWordRight(text, 0)).toBe(7); // after 'create '
      expect(findWordRight(text, 7)).toBe(12); // after 'user '
      expect(findWordRight(text, 12)).toBe(17); // after 'auth '
      expect(findWordRight(text, 17)).toBe(25); // end of text
      expect(findWordRight(text, 25)).toBe(25);
    });
  });

  describe('TerminalViewport layout', () => {
    it('initializes non-interactive viewport cleanly', () => {
      const out = new PassThrough();
      const viewport = new TerminalViewport(out);
      expect(viewport.isInteractive).toBe(false);

      // writeUpper works without throwing
      viewport.writeUpper('Test message');
      viewport.renderInputLine('test input', 4);
      viewport.cleanup();
    });

    it('positions input line at the bottom row with "> " prefix', () => {
      const out = new PassThrough();
      let written = '';
      out.on('data', (chunk) => {
        written += chunk.toString();
      });

      // Force interactive flags for testing rendering sequences
      const viewport = new TerminalViewport(out);
      (viewport as any).isInteractive = true;
      (viewport as any).rows = 30;
      (viewport as any).cols = 100;
      (viewport as any).scrollBottom = 29;

      viewport.renderInputLine('hello world', 5);

      // Should place cursor at row 30, column 3 + 5 = 8
      expect(written).toContain('\x1b[30;1H');
      expect(written).toContain('>');
      expect(written).toContain('hello world');
      expect(written).toContain('\x1b[30;8H');
    });

    it('writeUpper outputs to upper area and immediately refreshes bottom input line', () => {
      const out = new PassThrough();
      let written = '';
      out.on('data', (chunk) => {
        written += chunk.toString();
      });

      const viewport = new TerminalViewport(out);
      (viewport as any).isInteractive = true;
      (viewport as any).rows = 24;
      (viewport as any).scrollBottom = 23;

      viewport.renderInputLine('active typing', 3);
      written = ''; // reset capture

      viewport.writeUpper('Agent progress log line 1\nAgent progress log line 2');

      // Check write to upper scroll bottom
      expect(written).toContain('\x1b[23;1H');
      expect(written).toContain('Agent progress log line 1');
      expect(written).toContain('Agent progress log line 2');
      // Check that bottom input line is refreshed at row 24
      expect(written).toContain('\x1b[24;1H');
      expect(written).toContain('active typing');
    });

    it('wraps large text across multiple visual lines when typing without newline', () => {
      const out = new PassThrough();
      const viewport = new TerminalViewport(out);
      (viewport as any).cols = 50;

      // Type 90 characters of text without any newline
      const longText = 'Refactor the entire authentication system to use JWT tokens with Redis backed sessions';
      const res = viewport.computeVisualLines(longText, 10);

      // Should wrap into multiple visual lines
      expect(res.visualLines.length).toBeGreaterThanOrEqual(2);
      // First line should not have '↵' because it is a visual soft-wrap
      expect(res.visualLines[0]).not.toContain('↵');
      // Cursor at index 10 is on the first visual line
      expect(res.cursorVisualLine).toBe(0);
      expect(res.cursorVisualCol).toBe(2 + 10 + 1);

      // Check cursor at end of long text
      const resEnd = viewport.computeVisualLines(longText, longText.length);
      expect(resEnd.cursorVisualLine).toBe(res.visualLines.length - 1);
    });

    it('renders multiline wrapped input dynamically adjusting scroll bottom', () => {
      const out = new PassThrough();
      let written = '';
      out.on('data', (chunk) => {
        written += chunk.toString();
      });

      const viewport = new TerminalViewport(out);
      (viewport as any).isInteractive = true;
      (viewport as any).rows = 24;
      (viewport as any).cols = 40;

      const longText = 'Refactor auth system to use JWT tokens and Redis store';
      viewport.renderInputLine(longText, longText.length);

      // Scroll bottom should adjust to make room for multiple input rows
      expect(viewport.scrollBottom).toBeLessThan(23);
      // Text rendered across rows
      expect(written).toContain('Refactor');
    });
  });

  describe('InteractiveShell conversational loop', () => {
    it('processes natural language inputs without requiring CLI subcommands', async () => {
      const inStream = new PassThrough();
      const outStream = new PassThrough();
      const db = new TaskForgeDatabase(':memory:');

      let captured = '';
      outStream.on('data', (d) => {
        captured += d.toString();
      });

      const shell = new InteractiveShell({ input: inStream, output: outStream, database: db });
      const runPromise = shell.start();

      // Feed natural language queries
      inStream.write('what does this project do?\n');
      inStream.write('/exit\n');

      await runPromise;
      shell.close();

      expect(captured).toContain('TaskForge');
      expect(captured).toContain('Recommended strategy:');
    });

    it('supports abortSignal cancellation in handleInput', async () => {
      const db = new TaskForgeDatabase(':memory:');
      const shell = new InteractiveShell({ database: db });
      const abortCtrl = new AbortController();
      abortCtrl.abort();

      const reply = await shell.handleInput('yes --fake', abortCtrl.signal);
      shell.close();
      expect(reply).toBeDefined();
    });

    it('cleanly terminates conversational loop on /exit, exit, /quit and quit', async () => {
      for (const cmd of ['/exit', 'exit', '/quit', 'quit']) {
        const inStream = new PassThrough();
        const outStream = new PassThrough();
        const db = new TaskForgeDatabase(':memory:');

        const shell = new InteractiveShell({ input: inStream, output: outStream, database: db });
        const runPromise = shell.start();

        inStream.write(`${cmd}\n`);
        await runPromise;
        shell.close();
      }
    });

    it('collapses large bracketed paste into [Pasted text #1 +X lines] and expands on Enter submission', async () => {
      const inStream = new PassThrough();
      const outStream = new PassThrough();
      const db = new TaskForgeDatabase(':memory:');

      let captured = '';
      outStream.on('data', (d) => {
        captured += d.toString();
      });

      const shell = new InteractiveShell({
        input: inStream,
        output: outStream,
        database: db,
        interactive: true,
      });

      // Mock handleInput so execution is immediate and we verify the expanded text
      let submittedPrompt = '';
      shell.handleInput = async (input: string) => {
        submittedPrompt = input;
        return 'Mock reply';
      };

      const runPromise = shell.start();

      // Wait for async shell initialization (banner, git status, keypress events)
      const startWait = Date.now();
      while (!captured.includes('TaskForge') && Date.now() - startWait < 3000) {
        await new Promise((r) => setTimeout(r, 50));
      }
      await new Promise((r) => setTimeout(r, 100));

      // Send bracketed paste start
      const pasteContent = 'function hello() {\n  const a = 1;\n  const b = 2;\n  return a + b;\n}\n';
      inStream.write('\x1b[200~');
      inStream.write(pasteContent);
      inStream.write('\x1b[201~');

      // Wait a tick for readline keypress events to emit and render
      await new Promise((r) => setTimeout(r, 100));

      // The rendered output should show [Pasted text #1 +6 lines]
      expect(captured).toContain('[Pasted text #1 +6 lines]');

      // Now press Enter (\r) to submit the prompt
      inStream.write('\r');

      // Wait for handleInput to receive the expanded prompt
      await new Promise((r) => setTimeout(r, 100));
      expect(submittedPrompt).toBe(pasteContent.trim());

      // Now send /exit to exit cleanly
      inStream.write('/exit\r');

      await runPromise;
      shell.close();
    });
  });
});
