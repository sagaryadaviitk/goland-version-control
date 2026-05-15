import assert from 'node:assert/strict';
import test from 'node:test';
import { parseGofmtDiagnostics } from '../../src/goSyntaxDiagnostics';

test('parses gofmt diagnostics from standard input', () => {
  const diagnostics = parseGofmtDiagnostics('<standard input>:2:6: expected "IDENT", found "{"\n');

  assert.deepEqual(diagnostics, [{
    line: 1,
    character: 5,
    message: 'expected "IDENT", found "{"'
  }]);
});

test('ignores non-position gofmt output', () => {
  const diagnostics = parseGofmtDiagnostics('some unrelated output\n');

  assert.deepEqual(diagnostics, []);
});
