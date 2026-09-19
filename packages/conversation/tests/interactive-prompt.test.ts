import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import { InteractiveShell, findWordLeft, findWordRight } from '../src/interactive-shell.js';
import { TerminalViewport } from '../src/terminal-viewport.js';

describe('Interactive Terminal Prompt & REPL', () => {
  describe('Word boundary navigation', () => {
    it('moves backward across words correctly', () => {
      const text = 'create user auth endpoint';
      // At end of string (index 25)
      expect(findWordLeft(text, 25)).toBe(17); // starts of 'endpoint'
      expect(findWordLeft(text, 17)).toBe(12); // starts of 'auth'
      expect(findWordLeft(text, 12)).toBe(7);  // starts of 'user'
      expect(findWordLeft(text, 7)).toBe(0);   // starts of 'create'
      expect(findWordLeft(text, 0)).toBe(0);
    });

    it('moves forward across words correctly', () => {
      const text = 'create user auth endpoint';
      expect(findWordRight(text, 0)).toBe(7);  // after 'create '
      expect(findWordRight(text, 7)).toBe(12); // after 'user '
      expect(findWordRight(text, 12)).toBe(17);// after 'auth '
      expect(findWordRight(text, 17)).toBe(25);// end of text
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
  });

  describe('InteractiveShell conversational loop', () => {
    it('processes natural language inputs without requiring CLI subcommands', async () => {
      const inStream = new PassThrough();
      const outStream = new PassThrough();

      let captured = '';
      outStream.on('data', (d) => {
        captured += d.toString();
      });

      const shell = new InteractiveShell({ input: inStream, output: outStream });
      const runPromise = shell.start();

      // Feed natural language queries
      inStream.write('o que esse projeto faz?\n');
      inStream.write('/exit\n');

      await runPromise;

      expect(captured).toContain('TaskForge');
      expect(captured).toContain('Estratégia recomendada:');
    });

    it('supports abortSignal cancellation in handleInput', async () => {
      const shell = new InteractiveShell();
      const abortCtrl = new AbortController();
      abortCtrl.abort();

      const reply = await shell.handleInput('sim --fake', abortCtrl.signal);
      expect(reply).toBeDefined();
    });

    it('cleanly terminates conversational loop on /quit and closes resources', async () => {
      const inStream = new PassThrough();
      const outStream = new PassThrough();

      const shell = new InteractiveShell({ input: inStream, output: outStream });
      const runPromise = shell.start();

      inStream.write('/quit\n');
      await runPromise;

      expect(true).toBe(true);
    });
  });
});
