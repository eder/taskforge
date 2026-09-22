import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { SlashMenu, SLASH_COMMANDS } from '../src/slash-menu.js';

describe('SlashMenu', () => {
  it('opens and lists all commands when typing "/"', () => {
    const out = new PassThrough();
    const menu = new SlashMenu(out);

    const res = menu.update('/');
    expect(menu.isOpen).toBe(true);
    expect(menu.matches.length).toBe(SLASH_COMMANDS.length);
    expect(res.autoCompleted).toBeUndefined();
    expect(menu.getSelected()?.cmd).toBe('/help');
  });

  it('autocompletes unique match when typing "/e"', () => {
    const out = new PassThrough();
    const menu = new SlashMenu(out);

    const res = menu.update('/e');
    expect(menu.isOpen).toBe(true);
    expect(menu.matches.length).toBe(1);
    expect(menu.matches[0].cmd).toBe('/exit');
    expect(res.autoCompleted).toBe('/exit');
  });

  it('filters multiple matches without autocompleting when prefix is ambiguous (e.g. "/p")', () => {
    const out = new PassThrough();
    const menu = new SlashMenu(out);

    const res = menu.update('/p');
    expect(menu.isOpen).toBe(true);
    expect(menu.matches.length).toBeGreaterThan(1);
    expect(res.autoCompleted).toBeUndefined();
    const commands = menu.matches.map((m) => m.cmd);
    expect(commands).toContain('/plan');
    expect(commands).toContain('/pending');
    expect(commands).toContain('/pause');
  });

  it('does not force autocomplete on backspace', () => {
    const out = new PassThrough();
    const menu = new SlashMenu(out);

    // Simulate backspacing into /exi
    const res = menu.update('/exi', true);
    expect(menu.isOpen).toBe(true);
    expect(menu.matches.length).toBe(1);
    expect(menu.matches[0].cmd).toBe('/exit');
    expect(res.autoCompleted).toBeUndefined();
  });

  it('navigates up and down with wrap-around', () => {
    const out = new PassThrough();
    const menu = new SlashMenu(out);

    menu.update('/p');
    const total = menu.matches.length;
    expect(menu.selectedIndex).toBe(0);

    menu.selectNext();
    expect(menu.selectedIndex).toBe(1);

    menu.selectPrev();
    expect(menu.selectedIndex).toBe(0);

    // Wrap around backwards
    menu.selectPrev();
    expect(menu.selectedIndex).toBe(total - 1);

    // Wrap around forwards
    menu.selectNext();
    expect(menu.selectedIndex).toBe(0);
  });

  it('closes cleanly when command contains a space or does not start with "/"', () => {
    const out = new PassThrough();
    const menu = new SlashMenu(out);

    menu.update('/plan');
    expect(menu.isOpen).toBe(true);

    menu.update('/plan arg');
    expect(menu.isOpen).toBe(false);
    expect(menu.matches.length).toBe(0);

    menu.update('regular message');
    expect(menu.isOpen).toBe(false);
  });

  it('displays command descriptions in English', () => {
    const out = new PassThrough();
    const menu = new SlashMenu(out);

    menu.update('/exit');
    const item = menu.getSelected();
    expect(item?.desc).toContain('Exit interactive session');
  });

  it('exposes operational commands that were previously hidden from the slash menu', () => {
    const commands = SLASH_COMMANDS.map((item) => item.cmd);

    expect(commands).toContain('/inspect');
    expect(commands).toContain('/focus');
    expect(commands).toContain('/back');
    expect(commands).toContain('/raw');
    expect(commands).toContain('/constraint');
    expect(commands).toContain('/reassign');
  });

  it('keeps README command documentation synchronized with the public slash catalog', () => {
    const readmePath = path.resolve(__dirname, '../../../README.md');
    const readme = fs.readFileSync(readmePath, 'utf8');

    for (const command of SLASH_COMMANDS) {
      expect(
        readme.includes(`\`${command.cmd}`),
        `README is missing public command ${command.cmd}`,
      ).toBe(true);
    }
  });

  it('recognizes and autocompletes /health command', () => {
    const out = new PassThrough();
    const menu = new SlashMenu(out);

    const res = menu.update('/hea');
    expect(menu.isOpen).toBe(true);
    expect(menu.matches.length).toBe(1);
    expect(menu.matches[0].cmd).toBe('/health');
    expect(res.autoCompleted).toBe('/health');
    expect(menu.matches[0].desc).toContain('Router');
  });
});
