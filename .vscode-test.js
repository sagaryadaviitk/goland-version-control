const { defineConfig } = require('@vscode/test-cli');
const fs = require('fs');
const os = require('os');
const path = require('path');

const userDataDir = path.join(os.tmpdir(), 'gvc-vt');
fs.rmSync(userDataDir, { recursive: true, force: true });
fs.mkdirSync(userDataDir, { recursive: true });

module.exports = defineConfig({
  files: 'out/test/integration/**/*.test.js',
  workspaceFolder: '.',
  launchArgs: ['--disable-extensions', '--disable-workspace-trust', '--user-data-dir', userDataDir]
});
