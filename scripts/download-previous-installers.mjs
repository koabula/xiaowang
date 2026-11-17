import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir } from 'node:fs/promises';

const version = '0.1.19';
const files = process.platform === 'darwin'
  ? ['XiaoWang-' + version + '-mac-' + process.arch + '.zip']
  : process.platform === 'win32'
    ? ['XiaoWang-' + version + '-win-x64.exe']
    : ['XiaoWang-' + version + '-linux-x86_64.AppImage', 'XiaoWang-' + version + '-linux-amd64.deb'];
await mkdir('previous', { recursive: true });
await promisify(execFile)('gh', ['release', 'download', 'v' + version, '--repo', process.env.GITHUB_REPOSITORY,
  '--dir', 'previous', '--pattern', 'SHA256SUMS.txt', ...files.flatMap(file => ['--pattern', file])]);
console.log('Downloaded original v' + version + ' installers and checksums');
