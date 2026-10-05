/**
 * A check command for a project that has no package.json scripts, read from the
 * files the project has (for example the ones an agent just wrote in an empty
 * repository). The answer is a proposal the person accepts, not something saved
 * silently. Only file names and file contents are read; nothing is executed.
 */
export interface ProjectTree {
  /** Repository-relative paths, forward slashes. */
  files: string[];
  read(path: string): string | undefined;
}

export interface InferredCheck {
  command: string;
  /** One sentence for the person: what was seen and what the command does. */
  reason: string;
}

const has = (tree: ProjectTree, name: string) => tree.files.includes(name);
const textOf = (tree: ProjectTree, name: string) => tree.read(name) ?? '';

function pythonCheck(tree: ProjectTree): InferredCheck | undefined {
  const requirements = tree.files.filter((f) => /^requirements[^/]*\.txt$/.test(f)).sort();
  const hasPyproject = has(tree, 'pyproject.toml');
  const pythonTests = tree.files.some(
    (f) => /(^|\/)(test_[^/]+|[^/]+_test)\.py$/.test(f) || /(^|\/)tests?\/[^/]+\.py$/.test(f),
  );
  const mentionsPytest =
    requirements.some((f) => /\bpytest\b/i.test(textOf(tree, f))) ||
    /\bpytest\b/i.test(textOf(tree, 'pyproject.toml'));
  if (!pythonTests && !mentionsPytest) return undefined;
  if (requirements.length === 0 && !hasPyproject) {
    return {
      command: 'python3 -m pytest -q',
      reason: 'Python tests were found; this runs them with pytest',
    };
  }
  const install = requirements.length > 0
    ? requirements.map((f) => `-r ${f}`).join(' ')
    : '-e .';
  return {
    command: `python3 -m venv .venv && .venv/bin/python -m pip install -q ${install} pytest && .venv/bin/python -m pytest -q`,
    reason:
      'Python tests were found; this installs the project into a throwaway virtual environment (.venv, in the isolated copy) and runs them with pytest',
  };
}

function makeTarget(tree: ProjectTree): InferredCheck | undefined {
  const makefile = tree.files.find((f) => /^(GNU)?makefile$/i.test(f));
  if (!makefile) return undefined;
  if (!/^test\s*:/m.test(textOf(tree, makefile))) return undefined;
  return { command: 'make test', reason: 'The Makefile has a test target' };
}

/** The first command that fits what the project contains, or undefined when nothing does. */
export function inferCheckCommand(tree: ProjectTree): InferredCheck | undefined {
  if (has(tree, 'package.json')) return undefined; // discovered from its scripts already
  const python = pythonCheck(tree);
  if (python) return python;
  if (has(tree, 'go.mod')) return { command: 'go test ./...', reason: 'A Go module was found' };
  if (has(tree, 'Cargo.toml')) return { command: 'cargo test', reason: 'A Rust crate was found' };
  if (has(tree, 'pom.xml')) return { command: 'mvn -q test', reason: 'A Maven project was found' };
  if (has(tree, 'gradlew')) return { command: './gradlew test', reason: 'A Gradle project was found' };
  return makeTarget(tree);
}
