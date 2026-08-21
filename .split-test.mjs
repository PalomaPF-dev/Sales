import XLSX from 'xlsx';
const N = 183193, COLS = 50;
const t0 = Date.now();
const aoa = [Array.from({ length: COLS }, (_, c) => `列${c}`)];
for (let i = 0; i < N; i += 1) {
  const r = new Array(COLS);
  for (let c = 0; c < COLS; c += 1) r[c] = c % 3 === 0 ? 20000 + (i % 5000) : `値${i % 6000}-${c}`;
  aoa.push(r);
}
console.log('行の組み立て', ((Date.now() - t0) / 1000).toFixed(1), '秒');
let t = Date.now();
const ws = XLSX.utils.aoa_to_sheet(aoa);
console.log('aoa_to_sheet', ((Date.now() - t) / 1000).toFixed(1), '秒');
t = Date.now();
const csv = XLSX.utils.sheet_to_csv(ws);
console.log('CSV化', ((Date.now() - t) / 1000).toFixed(1), '秒', (Buffer.byteLength(csv) / 1024 / 1024).toFixed(1), 'MB');
t = Date.now();
const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'S');
const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', compression: true });
console.log('XLSX.write(圧縮)', ((Date.now() - t) / 1000).toFixed(1), '秒', (buf.length / 1024 / 1024).toFixed(1), 'MB');
