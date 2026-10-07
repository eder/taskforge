import * as fs from 'node:fs';
import * as path from 'node:path';
import { Document, parseDocument } from 'yaml';

const CONFIG_PATH = path.join('.taskforge', 'config.yaml');

/**
 * Adds values to a list in the project's `.taskforge/config.yaml`, keeping the
 * rest of the file (comments included) as it is. Used to apply a repair that
 * the person agreed to, such as linking `.env` into the isolated copies.
 *
 * A list in the file REPLACES the built-in default, so when the file has none
 * the defaults are written out first and the new values are appended to them.
 * Returns what was actually added (values already present are left alone).
 */
export function addToProjectConfigList(
  repoRoot: string,
  keyPath: string[],
  values: string[],
  defaults: string[] = [],
): { file: string; added: string[] } {
  const file = path.join(repoRoot, CONFIG_PATH);
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const doc: Document = text.trim() ? parseDocument(text) : new Document({});

  const existing = doc.getIn(keyPath);
  const current: string[] =
    existing && typeof (existing as { toJSON?: () => unknown }).toJSON === 'function'
      ? ((existing as { toJSON: () => unknown }).toJSON() as unknown[]).map(String)
      : defaults;

  const added = values.filter((value) => !current.includes(value));
  if (added.length === 0 && existing) return { file, added: [] };

  doc.setIn(keyPath, [...current, ...added]);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, doc.toString());
  return { file, added };
}

/**
 * Sets one scalar in the project's `.taskforge/config.yaml`, keeping the rest of
 * the file (comments included) as it is. Written to a temporary file and
 * renamed, so an interrupted write cannot leave a truncated config behind.
 */
export function setProjectConfigValue(
  repoRoot: string,
  keyPath: string[],
  value: string | number | boolean,
): { file: string } {
  const file = path.join(repoRoot, CONFIG_PATH);
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const doc: Document = text.trim() ? parseDocument(text) : new Document({});
  doc.setIn(keyPath, value);

  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, doc.toString());
  fs.renameSync(temp, file);
  return { file };
}
