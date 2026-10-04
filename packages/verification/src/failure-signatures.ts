/**
 * The identity of each failure in a test run's output ("FAILED tests/a.py::test_x",
 * "ERROR test_uploads.py"), so two runs can be compared: which failures were there
 * before a change, and which are new. Only lines the common runners print for a failed
 * test are recognised (pytest, vitest/jest, go test, node --test, cargo test). Output in
 * any other format yields no signatures, and the check is then judged by its exit code
 * alone, as before.
 */
const PATTERNS: RegExp[] = [
  // pytest short summary: "FAILED path::test - message" / "ERROR path - message"
  /^(FAILED|ERROR)\s+(\S+)/,
  // vitest / jest: " FAIL  path > name" / "FAIL path"
  /^\s*(?:×|✗|✕)?\s*(FAIL)\s+(\S.*)$/,
  // go test: "--- FAIL: TestName (0.00s)" and "FAIL\tpackage"
  /^\s*(--- FAIL):\s*(\S+)/,
  /^(FAIL)\s+(\S+\/\S+|\S+\.\S+)\s/,
  // node --test with its default reporter (Node 20+ prints a line per failed test): "✖ name (1.2ms)"
  /^\s*(✖|✕)\s+(?!failing tests)(\S.*)$/,
  // node --test (TAP): "not ok 3 - name"
  /^\s*(not ok)\s+\d+\s*-?\s*(.+)$/,
  // cargo test: "test module::name ... FAILED"
  /^test\s+(\S+)\s+\.\.\.\s+(FAILED)$/,
];

function normalize(line: string): string {
  return line.replace(/\s+/g, ' ').replace(/\s*\(\d+(\.\d+)?m?s\)\s*$/, '').trim().slice(0, 200);
}

export function extractFailureSignatures(output: string): string[] {
  const found = new Set<string>();
  for (const raw of output.split('\n')) {
    // eslint-disable-next-line no-control-regex
    const line = raw.replace(/\u001b\[[0-9;]*m/g, '').trimEnd();
    if (!line) continue;
    for (const pattern of PATTERNS) {
      const match = pattern.exec(line);
      if (!match) continue;
      // TAP numbers its tests, and the numbers shift when tests are added: identify by name.
      // Elsewhere keep the runner's verdict word and the test id, and drop the message
      // after " - ".
      const id =
        match[1] === 'not ok' ? normalize(`not ok ${match[2]}`) : normalize(line.split(' - ')[0]);
      found.add(id);
      break;
    }
  }
  return [...found].sort();
}

/**
 * Whether a test run actually executed tests (some passed), as opposed to dying before
 * running any (collection errors, a missing command). A run that executed tests and failed
 * only in some of them can still be compared before and after a change; one that executed
 * nothing proves nothing either way.
 */
export function testsActuallyRan(output: string): boolean {
  // eslint-disable-next-line no-control-regex
  const text = output.replace(/\u001b\[[0-9;]*m/g, '');
  if (/\berrors? during collection\b|\bno tests ran\b|\bInterrupted:/i.test(text)) return false;
  return /\b[1-9]\d* passed\b/.test(text) || /^\s*(?:ok\b|✔\s)/m.test(text);
}
