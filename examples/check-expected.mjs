// 核对各章「预期输出」代码块与脚本实测输出是否一致
// 用法：node scripts/check-expected.mjs   （未命中时 exit 1，已接入 npm run all）
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const BOOK = path.resolve(HERE, '..');
const ROOT = path.resolve(BOOK, '..', '..');
const MOD = path.join(BOOK, 'site', 'content', 'modules');

const chapters = fs.readdirSync(MOD).filter((f) => /^q\d\d-.*\.md$/.test(f)).sort();
let issues = 0;

// 正文用 qw-examples/check/QNN-*.mjs；单章专用的特例允许显式指定（如 Q03 的 check-eventbus.mjs）
const SPECIAL = { 'q03-query-eventbus.md': 'check-eventbus.mjs' };
for (const ch of chapters) {
  const md = fs.readFileSync(path.join(MOD, ch), 'utf8');
  const m = md.match(/node qw-examples\/check\/([\w-]+\.mjs)/);
  if (!m) continue;
  const script = SPECIAL[ch] ?? m[1];

  let actual = '';
  try {
    actual = execFileSync(process.execPath, [path.join(BOOK, 'qw-examples/check', script)], {
      cwd: ROOT,
      encoding: 'utf8',
    });
  } catch (e) {
    console.log(`[ERR ] ${ch} -> ${script} 执行失败`);
    issues++;
    continue;
  }

  // 找「预期输出」后的第一个 text 块（从整个脚本引用位置往后找）
  const after = md.slice(m.index);
  const blk = after.match(/预期输出[\s\S]{0,200}?```(?:text)?\r?\n([\s\S]*?)```/);
  if (!blk) {
    console.log(`[NONE] ${ch} -> 未找到预期输出块`);
    continue;
  }

  const expected = blk[1].trim().split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const got = actual.trim().split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  // 把实测输出归一成一段空白分隔的文本，便于判断「正文排版断行」是否属实
  const gotFlat = got.join(' ');

  // 省略号写法（"a, ... , b"）按前缀 + 结尾两段比对
  const hit = (line) => {
    if (got.includes(line)) return true;
    // 正文因排版断行的行：空白归一后整体查找
    if (gotFlat.includes(line.replace(/\s+/g, ' '))) return true;
    if (!line.includes('...')) return false;
    // 字符类 [...] 里的点不是省略号，不做省略号展开
    if (/\[[^\]]*\.\.\.[^\]]*\]/.test(line)) return false;
    const [head, tail] = line.split('...').map((x) => x.trim());
    const h = head.replace(/[,\s]+$/, '');
    const t = tail.replace(/^[,\s]+/, '');
    const idx = gotFlat.indexOf(h);
    if (idx < 0) return false;
    if (!t) return true;
    return gotFlat.indexOf(t, idx + h.length) >= 0;
  };

  const missing = expected.filter((l) => !hit(l));
  // 反向核对：实测有、正文没有的行。只看「断言型」输出行（带 [OK]/[FAIL] 或含数字统计），
  // 避免把脚本里的辅助文案也当成断言。预期块用省略号写法时放宽。
  const loose = expected.some((l) => l.includes('...'));
  const extra = loose ? [] : got.filter((l) => !expected.includes(l) && /[\d]/.test(l) && /[:：\->]/.test(l));
  if (missing.length) {
    issues++;
    console.log(`[DIFF] ${ch} -> ${script}`);
    for (const l of missing) console.log(`         正文有、实测无: ${l}`);
  }
  if (extra.length) {
    issues++;
    console.log(`[EXTRA] ${ch} -> ${script}`);
    for (const l of extra) console.log(`         实测有、正文无: ${l}`);
  }
  if (!missing.length && !extra.length) {
    console.log(`[ OK ] ${ch} -> ${script} (${expected.length} 行全部命中)`);
  }
}
console.log(issues ? `\n共 ${issues} 处需修正` : '\n全部一致');
if (issues) process.exitCode = 1;
