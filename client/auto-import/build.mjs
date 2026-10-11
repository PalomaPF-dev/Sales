// 自動取込のスクリプトを1つのファイル（dist/auto-import.mjs）に組み立てる。
//
//   npm run build:auto-import        （リポジトリの一番上で）
//
// 画面のファイル読み取りのコード（src/shipColorClient.ts など）と Excel の部品を
// 丸ごと入れるので、社内PCには Node.js と、できあがった dist フォルダだけあればよい
// （npm install は要らない）。画面の src/api.ts は、ここで nodeApi.ts に差し替える。
// 読み取りのコードを直したら、組み立て直して社内PCのファイルを置き換えること。
import { execFileSync } from 'node:child_process';
import { copyFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, '../src');
const out = path.join(here, 'dist');

// 型の確かめ（組み立てだけだと型の誤りに気づけないため）
execFileSync(process.execPath, [path.resolve(here, '../node_modules/typescript/bin/tsc'), '-p', here], {
  stdio: 'inherit',
});

// 版。古いスクリプトが社内PCで動き続けていないかを、ログと通知メールで見分けるため
let commit = '';
try {
  commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: here, encoding: 'utf8' }).trim();
} catch { /* gitの無い場所で組み立てたとき */ }
const version = `${new Date().toISOString().slice(0, 10)}${commit ? ` ${commit}` : ''}`;

await build({
  configFile: false,
  root: here,
  logLevel: 'warn',
  define: { __AUTO_IMPORT_VERSION__: JSON.stringify(version) },
  plugins: [{
    // 画面のコードが使う ./api（ブラウザのCookieで送る）を、自動取込の鍵で送るものへ差し替える
    name: 'auto-import-node-api',
    enforce: 'pre',
    resolveId(id, importer) {
      if (id === './api' && importer && path.dirname(importer) === src) return path.join(here, 'nodeApi.ts');
      return null;
    },
  }],
  ssr: { noExternal: true, target: 'node' },
  build: {
    ssr: path.join(here, 'main.ts'),
    outDir: out,
    emptyOutDir: true,
    target: 'node20',
    minify: false,
    rollupOptions: { output: { entryFileNames: 'auto-import.mjs', codeSplitting: false } },
  },
});

// 社内PCへそのまま持っていけるよう、使い方と設定の見本も同じフォルダへ
for (const f of ['README.md', 'auto-import.config.example.json', 'run.cmd', 'register-task.cmd']) {
  copyFileSync(path.join(here, f), path.join(out, f));
}
console.log(`組み立てました: ${path.relative(process.cwd(), out)}（版 ${version}）`);
