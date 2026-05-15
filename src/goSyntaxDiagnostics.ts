export interface ParsedDiagnostic {
  line: number;
  character: number;
  message: string;
}

const GOFMT_DIAGNOSTIC_PATTERN = /^(?:<standard input>|[^:]+):(\d+):(\d+):\s+(.+)$/;

export function parseGofmtDiagnostics(stderr: string): ParsedDiagnostic[] {
  return stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      const match = line.match(GOFMT_DIAGNOSTIC_PATTERN);
      if (!match) {
        return [];
      }

      return [{
        line: Math.max(Number(match[1]) - 1, 0),
        character: Math.max(Number(match[2]) - 1, 0),
        message: match[3]
      }];
    });
}
