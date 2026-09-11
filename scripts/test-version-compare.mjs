/**
 * 版本比较回归用例 —— 与 src/index.ts 的 parseVersion/compareVersions 保持同步。
 *
 * 背景：早期实现丢弃了预发布阶段名，只保留序号，导致 `0.1.5-rc.2` 与
 * `0.1.5-alpha.2` 解析结果相同（都为 [0,1,5,2]）→ compareVersions 返回 0
 * → 新 tag 既不会被排序选中，也不会判定 hasUpdate，表现为「明明有新版本却检测不到」。
 *
 * 运行：node scripts/test-version-compare.mjs   （退出码非 0 表示失败）
 */

function parseVersion(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-(alpha|beta|rc)\.?(\d+))?$/.exec(v.trim())
  if (!m) return null
  const stage = m[4] === undefined ? 3 : m[4] === 'alpha' ? 0 : m[4] === 'beta' ? 1 : 2
  return [Number(m[1]), Number(m[2]), Number(m[3]), stage, m[5] !== undefined ? Number(m[5]) : null]
}

function compareVersions(a, b) {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  if (pa && pb) {
    for (let i = 0; i < 4; i++) {
      if (pa[i] !== pb[i]) return pa[i] - pb[i]
    }
    const ra = pa[4]
    const rb = pb[4]
    if (ra !== null && rb !== null) return ra - rb
    if (ra !== null) return -1
    if (rb !== null) return 1
    return 0
  }
  return a === b ? 0 : a < b ? -1 : 1
}

/** [a, b, 期望符号：1 表示 a>b，-1 表示 a<b，0 表示相等] */
const cases = [
  ['0.1.5-rc.2', '0.1.5-alpha.2', 1],   // 本次 bug 核心：rc 必须高于 alpha
  ['0.1.5-rc.1', '0.1.5-alpha.2', 1],
  ['0.1.5-alpha.2', '0.1.5-alpha.1', 1],
  ['0.1.5-rc.1', '0.1.5-rc.2', -1],
  ['0.1.5-beta.1', '0.1.5-alpha.9', 1],
  ['0.1.5-beta.1', '0.1.5-rc.1', -1],
  ['0.1.5', '0.1.5-rc.2', 1],           // 正式版高于任何预发布
  ['0.1.5-rc.2', '0.1.5', -1],
  ['0.1.5-rc.2', '0.1.5-rc.2', 0],
  ['0.1.5-rc.1', '0.1.4', 1],           // 版本号优先级高于阶段
  ['0.2.0-alpha.1', '0.1.9', 1],
]

let failed = 0
for (const [a, b, want] of cases) {
  const got = Math.sign(compareVersions(a, b))
  const ok = got === want
  if (!ok) failed++
  const sym = (n) => (n > 0 ? '>' : n < 0 ? '<' : '=')
  console.log(`${ok ? '✓' : '✗'} ${a} ${sym(want)} ${b}  (got ${sym(got)})`)
}

// 端到端：模拟从 GitHub tags 挑 latest 并判定更新
const tags = [
  'dsh-v0.1.5-rc.2', 'dsh-v0.1.5-rc.1', 'dsh-v0.1.5-alpha.2', 'dsh-v0.1.5-alpha.1',
  'dsh-v0.1.3-alpha.2', 'dsh-v0.1.2-rc.1',
]
const versions = tags.map((t) => t.replace(/^dsh-v?/, '')).sort(compareVersions)
const latest = versions[versions.length - 1]
const installed = '0.1.5-alpha.2'

console.log('\n排序:', versions.join(' < '))
console.log('latest =', latest, '| installed =', installed)

const expectLatest = '0.1.5-rc.2'
if (latest !== expectLatest) {
  console.log(`✗ latest 应为 ${expectLatest}，实际 ${latest}`)
  failed++
} else {
  console.log('✓ latest 选取正确')
}

if (compareVersions(latest, installed) > 0) {
  console.log('✓ hasUpdate 判定为 true')
} else {
  console.log('✗ hasUpdate 应判定为 true')
  failed++
}

console.log(failed ? `\n失败 ${failed} 项` : '\n全部通过')
process.exit(failed ? 1 : 0)
