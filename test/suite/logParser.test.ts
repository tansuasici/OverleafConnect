import * as assert from 'assert';
import * as path from 'path';
import { LogParser } from '../../src/latex/logParser';

suite('LogParser Test Suite', () => {
  let logParser: LogParser;

  setup(() => {
    logParser = new LogParser();
  });

  teardown(() => {
    logParser.dispose();
  });

  test('should parse LaTeX errors', () => {
    const fixturesDir = path.resolve(__dirname, '../../test/fixtures');
    const entries = logParser.parse(
      path.join(fixturesDir, 'sample-errors.log'),
      fixturesDir
    );

    const errors = entries.filter((e) => e.type === 'error');
    assert.ok(errors.length > 0, 'Should find at least one error');
    assert.ok(
      errors.some((e) => e.message.includes('Undefined control sequence')),
      'Should find undefined control sequence error'
    );
  });

  test('should parse LaTeX warnings', () => {
    const fixturesDir = path.resolve(__dirname, '../../test/fixtures');
    const entries = logParser.parse(
      path.join(fixturesDir, 'sample-warnings.log'),
      fixturesDir
    );

    const warnings = entries.filter((e) => e.type === 'warning');
    assert.ok(warnings.length > 0, 'Should find at least one warning');
  });

  test('should return empty array for missing file', () => {
    const entries = logParser.parse('/nonexistent/file.log', '/tmp');
    assert.strictEqual(entries.length, 0);
  });

  test('should parse clean log without errors', () => {
    const fixturesDir = path.resolve(__dirname, '../../test/fixtures');
    const entries = logParser.parse(
      path.join(fixturesDir, 'sample.log'),
      fixturesDir
    );

    const errors = entries.filter((e) => e.type === 'error');
    assert.strictEqual(errors.length, 0, 'Clean log should have no errors');
  });
});
