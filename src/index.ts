/**
 * @wizzy/dsh-updater — host 侧：官方版本检测 + 全自动升级
 *
 * 数据源：
 * - 官方 GitHub 仓库 deepseek-ai/deepseek-harness 的 `dsh-v*` tag（用户要求的主检测源）；
 * - 失败时回退 npm registry（@deepseek-ai/dsh/latest），两者版本一致（tag 即 npm 发布版）。
 *
 * 自动检测：插件启动 5s 后检测一次，之后每 30 分钟一次。
 *
 * 全自动升级（POST /dsh-updater/api/upgrade）：
 *   1. 生成升级脚本 upgrade.ps1（等旧进程退出 → npm install -g @deepseek-ai/dsh@latest
 *      → 以原启动命令重开 dsh web 控制台窗口），并以脱离进程方式启动；
 *   2. 宿主进程 2.5s 后自动退出（释放端口与文件锁，保证 npm 可覆盖全局包）；
 *   3. 脚本重开的 dsh 使用新版本，页面刷新即恢复。
 *
 * HTTP API（挂 host webserver，与同生态插件一致）：
 *   GET  /dsh-updater/api/status   当前状态：本地版本 / 最新版本 / 是否有更新 / 检查中 / 升级中
 *   POST /dsh-updater/api/check    立即触发一次检测
 *   POST /dsh-updater/api/upgrade  立即全自动升级（安装 + 重启）
 *   GET  /dsh-updater/api/log      升级日志尾部（排障用）
 *   GET  /dsh-updater/api/token    内存会话令牌（同源 client 取回后经 X-Dsh-Updater-Token 头调用升级）
 *
 * 写操作安全（POST /check、POST /upgrade，两道防线）：
 *   1. Origin/Referer 本机同源校验：仅接受 Origin 缺失或 http://127.0.0.1:<port>/
 *      http://localhost:<port>（端口取自 Host 头）——浏览器跨站表单/fetch POST 必带 Origin；
 *   2. /upgrade 另须携带 X-Dsh-Updater-Token = 启动时生成的内存随机 token；
 *      /token 响应不带 CORS 头，恶意跨站页面读不到 body，拿不到该 token。
 */
import type { Context } from 'cordis'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
export const name = '@wizzy-1547/dsh-updater'
export const inject = ['webServer']
/** 插件构建标识：/status 暴露 + 启动日志打印，用于确认运行中的宿主加载的是最新构建
 *  （2026-08-29 实测踩坑：旧实例占着 3080，新构建没被加载，升级跑了旧逻辑） */
export const PLUGIN_BUILD = '2026-08-29-detailed-window'

type AppContext = Context & {
  webServer: {
    register(route: { kind: string; path: string; handler: (req: unknown, res: unknown) => void }): unknown
  }
  effect(fn: () => unknown, label?: string): void
  logger?: { info?(msg: string): void; warn?(msg: string): void }
}

const REPO = 'deepseek-ai/deepseek-harness'
const GITHUB_TAGS_URL = `https://api.github.com/repos/${REPO}/tags?per_page=30`
// api.github.com 匿名限流 60 次/小时；HTML 标签页不走该限流，作为检测回退源
const GITHUB_TAGS_HTML_URL = `https://github.com/${REPO}/tags`
const NPM_LATEST_URL = 'https://registry.npmjs.org/@deepseek-ai/dsh/latest'

const INITIAL_CHECK_DELAY_MS = 5000
const CHECK_INTERVAL_MS = 30 * 60 * 1000
const FETCH_TIMEOUT_MS = 10_000
/** 宿主进程收到升级指令后延迟退出，保证 HTTP 响应先送达浏览器 */
const EXIT_DELAY_MS = 2500
/** 升级脚本先等旧进程退出，再执行 npm 安装（避开全局包文件锁） */
const WRAPPER_SLEEP_S = 5
/** 升级期间独立进度服务端口（宿主已退出，由该只读服务向页面提供进度） */
const PROGRESS_PORT = 38999

type CheckStatus = 'idle' | 'checking' | 'upgrading'

interface CheckState {
  status: CheckStatus
  installed: string
  latest: string
  hasUpdate: boolean
  source: 'github' | 'npm' | 'none'
  /** GitHub/检测源最新版是否已在 npm 发布（可安装） */
  npmReady: boolean
  /** GitHub 已发布但 npm 尚未发布的版本（提示用） */
  pendingVersion?: string
  /** npm 当前实际可安装的最新版（npmReady=false 时用于展示 npm 侧进度） */
  npmLatest?: string
  lastCheckAt: number
  upgradeStartedAt?: number
  error?: string
}

/** 读取当前安装版本：dsh 启动入口 bin.js 上一级的 package.json */
function readInstalledVersion(): string {
  try {
    const bin = process.argv[1]
    if (bin && existsSync(bin)) {
      const pkg = join(dirname(bin), '..', 'package.json')
      if (existsSync(pkg)) {
        const raw = JSON.parse(readFileSync(pkg, 'utf8')) as { version?: unknown }
        if (typeof raw.version === 'string' && raw.version) return raw.version
      }
    }
  } catch {
    /* 读不到版本时按空处理 */
  }
  return ''
}

/** GitHub tag（dsh-v0.1.0-rc.7）→ 版本号（0.1.0-rc.7）；不匹配返回 null */
function tagToVersion(tag: string): string | null {
  let s = tag.trim()
  if (s.startsWith('dsh-')) s = s.slice(4)
  if (s.startsWith('v')) s = s.slice(1)
  return /^\d+\.\d+\.\d+/.test(s) ? s : null
}

/** 解析 0.1.0 / 0.1.0-rc.7 → [主, 次, 补丁, 预发布号|null] */
function parseVersion(v: string): [number, number, number, number | null] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-(?:rc|beta|alpha)\.?(\d+))?$/.exec(v.trim())
  if (!m) return null
  return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] !== undefined ? Number(m[4]) : null]
}

/** a>b 返回正数，a<b 返回负数，相等 0；预发布 < 正式版 */
function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  if (pa && pb) {
    for (let i = 0; i < 3; i++) {
      const ai = pa[i] as number
      const bi = pb[i] as number
      if (ai !== bi) return ai - bi
    }
    const ra = pa[3]
    const rb = pb[3]
    if (ra !== null && rb !== null) return ra - rb
    if (ra !== null) return -1
    if (rb !== null) return 1
    return 0
  }
  return a === b ? 0 : a < b ? -1 : 1
}

async function fetchJson(url: string): Promise<unknown> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': 'dsh-updater/0.1', accept: 'application/json' },
      signal: ctrl.signal,
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return (await res.json()) as unknown
  } finally {
    clearTimeout(timer)
  }
}

/** 抓取文本（HTML 标签页等）；用浏览器 UA 规避 api.github.com 的匿名限流 */
async function fetchText(url: string): Promise<string> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) dsh-updater/0.1',
        accept: 'text/html,application/xhtml+xml',
      },
      signal: ctrl.signal,
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.text()
  } finally {
    clearTimeout(timer)
  }
}

/** 从 GitHub HTML 标签页文本中提取 dsh-v* tag（排除 .zip/.tar.gz 下载链接） */
function extractTagsFromHtml(html: string): string[] {
  const out: string[] = []
  const re = /dsh-v[\w.\-]+/g
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    const tag = m[0]
    if (tag.endsWith('.zip') || tag.endsWith('.tar.gz')) continue
    if (out.includes(tag)) continue
    out.push(tag)
  }
  return out
}

/** 读取请求头（Node 头字段为小写键名；数组值取首个） */
function getHeader(req: unknown, key: string): string {
  const headers = (req as { headers?: Record<string, string | string[] | undefined> }).headers
  const v = headers?.[key]
  const s = Array.isArray(v) ? v[0] : v
  return typeof s === 'string' ? s : ''
}

/**
 * CSRF 防线一：写操作只接受本机同源请求。
 * 仅允许 Origin 缺失（curl 等非浏览器客户端）或匹配 http://127.0.0.1:<port> /
 * http://localhost:<port>（端口取自 Host 头）；有 Referer 无 Origin 时按 Referer 的 origin 判断。
 */
function isLocalWrite(req: unknown): boolean {
  const port = /:(\d+)\s*$/.exec(getHeader(req, 'host'))?.[1] ?? '80'
  const allowed = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`])
  const origin = getHeader(req, 'origin').trim().replace(/\/+$/, '')
  if (origin !== '') return allowed.has(origin)
  const referer = getHeader(req, 'referer').trim()
  if (referer !== '') {
    try {
      return allowed.has(new URL(referer).origin)
    } catch {
      return false
    }
  }
  return true
}

export function apply(ctx: AppContext): void {
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  const stateDir = join(dshHome, 'plugins', 'dsh-updater')
  const logFile = join(stateDir, 'upgrade.log')
  /** CSRF 防线二：进程启动时生成的随机令牌（仅存内存）；/upgrade 须携带一致的 X-Dsh-Updater-Token */
  const apiToken = randomBytes(24).toString('hex')

  const state: CheckState = {
    status: 'idle',
    installed: readInstalledVersion(),
    latest: '',
    hasUpdate: false,
    source: 'none',
    npmReady: false,
    lastCheckAt: 0,
  }

  // 宿主启动时清理上一次升级的残留：
  // - 残留的 progress-server 进程（占用 38999 会挡下次升级）
  // - 残留的 progress.json / ready 标记
  // 注意：若 progress.json 显示升级正在进行（新鲜且未到 done/error），
  // 说明是用户在升级期间手动重启/多开宿主——此时**不得**杀掉 progress-server，
  // 否则页面拿不到进度。仅清理「已结束」的残留。
  ctx.effect(() => {
    let upgradingActive = false
    try {
      const pf = join(stateDir, 'progress.json')
      if (existsSync(pf)) {
        const p = JSON.parse(readFileSync(pf, 'utf8')) as { stage?: string; at?: number }
        const fresh = typeof p.at === 'number' && Date.now() - p.at < 10 * 60_000
        const finished = p.stage === 'done' || p.stage === 'error'
        if (fresh && !finished) upgradingActive = true
      }
    } catch { /* ignore */ }
    if (!upgradingActive) {
      try {
        const readyFile = join(stateDir, 'progress-server.ready')
        if (existsSync(readyFile)) {
          const pid = Number.parseInt(readFileSync(readyFile, 'utf8').trim(), 10)
          if (Number.isInteger(pid) && pid > 0 && process.platform === 'win32') {
            spawn('taskkill.exe', ['/pid', String(pid), '/f', '/t'], { stdio: 'ignore', windowsHide: true })
          }
        }
      } catch { /* ignore */ }
      try {
        rmSync(join(stateDir, 'progress.json'), { force: true })
        rmSync(join(stateDir, 'progress-server.ready'), { force: true })
      } catch { /* ignore */ }
    }
    // 备份保留 7 天：启动时清理超期备份（升级期间由 wrapper 负责清理）
    try {
      const now = Date.now()
      for (const n of readdirSync(stateDir)) {
        if (!n.startsWith('backup-')) continue
        const p = join(stateDir, n)
        try {
          if (now - statSync(p).mtimeMs > 7 * 24 * 3600 * 1000) {
            rmSync(p, { recursive: true, force: true })
            ctx.logger?.info?.('[' + name + '] 已清理 7 天前的旧备份: ' + n)
          }
        } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
    return () => {}
  }, 'dsh-updater: startup cleanup')

  // ── 版本检测 ────────────────────────────────────────────────────────
  async function runCheck(): Promise<void> {
    if (state.status !== 'idle') return
    state.status = 'checking'
    state.error = undefined
    try {
      let latest = ''
      let source: 'github' | 'npm' = 'github'
      try {
        // ① 优先 api.github.com（结构化 JSON）
        let tagNames: string[] = []
        try {
          const payload = (await fetchJson(GITHUB_TAGS_URL)) as { name?: unknown }[]
          if (!Array.isArray(payload)) throw new Error('GitHub tags 返回格式异常')
          tagNames = payload.map((t) => (typeof t?.name === 'string' ? t.name : '')).filter(Boolean)
        } catch (e) {
          // ② 回退：HTML 标签页（api.github.com 匿名限流 60 次/小时时可用）
          ctx.logger?.warn?.(
            '[' + name + '] GitHub API 检测失败，回退 HTML 标签页: ' + (e instanceof Error ? e.message : String(e)),
          )
          const html = await fetchText(GITHUB_TAGS_HTML_URL)
          tagNames = extractTagsFromHtml(html)
        }
        const versions: string[] = []
        for (const t of tagNames) {
          const v = tagToVersion(t)
          if (v) versions.push(v)
        }
        if (versions.length === 0) throw new Error('仓库中暂无 dsh-v* tag')
        versions.sort(compareVersions)
        latest = versions[versions.length - 1]
      } catch (e) {
        ctx.logger?.warn?.(
          '[' + name + '] GitHub 检测失败（回退 npm registry）: ' + (e instanceof Error ? e.message : String(e)),
        )
        const npm = (await fetchJson(NPM_LATEST_URL)) as { version?: unknown }
        if (typeof npm?.version !== 'string' || !npm.version) throw new Error('npm registry 返回异常')
        latest = npm.version
        source = 'npm'
      }
      state.latest = latest
      state.source = source

      // 验证检测源最新版是否已在 npm 发布（决定「立即升级」是否真能装上）。
      // GitHub 可能先发 tag，npm 稍后才发布；此时精确安装会 ETARGET，
      // 必须如实告知用户「npm 待发布」，避免点了升级却装了个寂寞。
      state.npmReady = false
      state.pendingVersion = undefined
      state.npmLatest = undefined
      if (latest) {
        const npmPkgUrl = 'https://registry.npmjs.org/@deepseek-ai/dsh/' + encodeURIComponent(latest)
        try {
          const head = await fetch(npmPkgUrl, {
            headers: { 'user-agent': 'dsh-updater/0.1', accept: 'application/json' },
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
          })
          state.npmReady = head.ok
        } catch {
          state.npmReady = false
        }
        if (!state.npmReady && source === 'github') {
          // npm 尚未发布最新 tag：查 npm 实际可装的最高版，作为升级的兜底目标
          try {
            const npmMeta = (await fetchJson(NPM_LATEST_URL)) as { version?: unknown }
            if (typeof npmMeta?.version === 'string' && npmMeta.version) {
              state.npmLatest = npmMeta.version
              if (compareVersions(npmMeta.version, latest) < 0) state.pendingVersion = latest
            }
          } catch {
            /* npm 查询失败时仅保留 latest 展示 */
          }
        }
      }

      state.hasUpdate = state.installed !== '' && compareVersions(latest, state.installed) > 0
      state.lastCheckAt = Date.now()
      ctx.logger?.info?.(
        `[${name}] 检测完成: installed=${state.installed} latest=${state.latest} hasUpdate=${state.hasUpdate} npmReady=${state.npmReady}${state.pendingVersion ? ` pending=${state.pendingVersion}` : ''}`,
      )
    } catch (e) {
      state.error = e instanceof Error ? e.message : String(e)
      ctx.logger?.warn?.('[' + name + '] 检测失败: ' + state.error)
    } finally {
      state.status = 'idle'
    }
  }

  // ── 全自动升级 ──────────────────────────────────────────────────────

  /** 升级期间独立进度服务（宿主已退出，页面靠它看进度；只读，无写操作） */
  function writeProgressServer(serverFile: string): void {
    const code = `// dsh-updater progress server — 升级期间只读进度服务（宿主已退出）
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'

const STATE_DIR = ${JSON.stringify(stateDir)}
const PORT = ${PROGRESS_PORT}
const progressFile = path.join(STATE_DIR, 'progress.json')
const logFile = path.join(STATE_DIR, 'upgrade.log')

http
  .createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://localhost')
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    try {
      if (url.pathname === '/progress') {
        if (!fs.existsSync(progressFile)) return res.end(JSON.stringify({ ok: false, error: 'no-progress' }))
        return res.end(fs.readFileSync(progressFile, 'utf8'))
      }
      if (url.pathname === '/log') {
        if (!fs.existsSync(logFile)) return res.end(JSON.stringify({ ok: true, log: '' }))
        const lines = fs.readFileSync(logFile, 'utf8').split(/\\r?\\n/).filter(Boolean)
        return res.end(JSON.stringify({ ok: true, log: lines.slice(-150).join('\\n') }))
      }
      res.statusCode = 404
      res.end(JSON.stringify({ ok: false, error: 'not found' }))
    } catch (e) {
      res.statusCode = 500
      res.end(JSON.stringify({ ok: false, error: String(e && typeof e === 'object' && 'message' in e ? e.message : e) }))
    }
  })
  .listen(PORT, '127.0.0.1', () => {
    const ready = path.join(STATE_DIR, 'progress-server.ready')
    fs.writeFileSync(ready, String(process.pid))
    // 自退出：升级达到 done/error 后最多再服务 5 分钟（给页面收尾时间），
    // 然后退出释放端口，避免残留进程占用 38999 影响下次升级。
    let idle = 0
    const iv = setInterval(() => {
      try {
        const p = JSON.parse(fs.readFileSync(progressFile, 'utf8'))
        if (p.stage === 'done' || p.stage === 'error') {
          idle++
          if (idle >= 30) { clearInterval(iv); process.exit(0) }
        } else {
          idle = 0
        }
      } catch {
        idle++
        if (idle >= 30) { clearInterval(iv); process.exit(0) }
      }
    }, 10000)
    setTimeout(() => { try { fs.rmSync(ready, { force: true }) } catch { /* ignore */ } }, 60000)
  })
`
    writeFileSync(serverFile, code, 'utf8')
  }

  /**
   * 生成 Node 版升级 wrapper（upgrade.mjs）。
   * 阶段表驱动：每个大阶段写 progress.json（stage/pct/message），
   * 页面轮询独立进度服务即可看到实时进度。
   */
  function writeNodeWrapper(scriptFile: string, mode: 'npm' | 'github'): void {
    const target = state.latest || ''
    const npmLatest = state.npmLatest || 'latest'
    // 健康检查目标：升级重启后轮询该地址确认新 dsh 真的起来了（起不来就自动回滚）。
    // 取当前 GUI 端口（本部署为 3080）。若将来端口变了，改这里即可。
    const healthUrl = 'http://127.0.0.1:3080/dsh-updater/api/status'
    const cfg = {
      mode,
      target,
      npmLatest,
      stateDir,
      relaunchFile: join(stateDir, 'relaunch.cmd'),
      rollbackFile: join(stateDir, 'rollback.cmd'),
      sleepS: WRAPPER_SLEEP_S,
      healthUrl,
      healthTimeoutMs: 120_000,
      backupRetentionDays: 7,
    }
    const code = `// dsh-updater upgrade wrapper (${mode}) — 脱离宿主独立运行，逐步写 progress.json
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const CFG = ${JSON.stringify(cfg)}
const STATE_DIR = CFG.stateDir
const LOG = path.join(STATE_DIR, 'upgrade.log')
const PROGRESS = path.join(STATE_DIR, 'progress.json')
const log = (m) => fs.appendFileSync(LOG, '[' + new Date().toLocaleString('zh-CN', { hour12: false }) + '] ' + m + '\\r\\n', 'utf8')
const stamp = () => Date.now()

// 向可见控制台窗口打印进度：阶段切换 / 每 2% / 终态立即打印，避免下载刷屏
let lastAnn = { stage: '', pct: -1 }
function announce(stage, pct, message, detail) {
  try {
    if (stage !== lastAnn.stage || pct - lastAnn.pct >= 2 || stage === 'error' || stage === 'done') {
      const t = new Date().toLocaleTimeString('zh-CN', { hour12: false })
      clearTick()
      console.log('[' + t + '] ' + (message || '') + (detail ? ' — ' + detail : ''))
      lastAnn = { stage, pct }
      lastOut = Date.now()
    }
  } catch { /* 控制台不可用时忽略 */ }
}

// 阶段心跳：已用时在同一行内原地刷新（每秒跳动），不再每 20s 刷一行新日志。
// 打印任何真实输出前必须先 clearTick() 抹掉这行，避免文字拼接错乱。
let curStageLabel = ''
let stageStart = 0
let lastOut = Date.now()
let ticking = false
function clearTick() {
  if (!ticking) return
  ticking = false
  try { process.stdout.write('\\r' + ' '.repeat(120) + '\\r') } catch { /* ignore */ }
}
setInterval(() => {
  try {
    if (!curStageLabel || Date.now() - lastOut <= 1000) return
    const line = '  … ' + curStageLabel + ' 进行中（已用时 ' + Math.round((Date.now() - stageStart) / 1000) + 's）'
    process.stdout.write('\\r' + line + '                  ')
    ticking = true
  } catch { /* ignore */ }
}, 1000).unref()

function writeProgress(stage, pct, message, detail) {
  try {
    fs.writeFileSync(PROGRESS, JSON.stringify({ ok: true, stage, pct, message, detail, at: stamp() }), 'utf8')
  } catch { /* ignore */ }
  const label = (message || stage || '').split('（')[0]
  if (stage === 'error' || stage === 'done') curStageLabel = ''
  else if (stage !== lastAnn.stage) { curStageLabel = label; stageStart = Date.now() }
  announce(stage, pct, message, detail)
}

// 运行子命令：实时把子进程输出逐行透传到窗口（缩进 │）并写入日志 —— 更细的小进度
function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const c = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, ...opts })
    let buf = ''
    const pump = (d) => {
      buf += d.toString()
      let i
      // eslint-disable-next-line no-constant-condition
      while ((i = buf.indexOf('\\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\\r$/, '').replace(/\\x1b\\[[0-9;]*[A-Za-z]/g, '').trim()
        buf = buf.slice(i + 1)
        if (line) {
          clearTick()
          console.log('  │ ' + line)
          log('  │ ' + line)
          lastOut = Date.now()
        }
      }
    }
    c.stdout.on('data', pump)
    c.stderr.on('data', pump)
    c.on('close', (code) => resolve(code ?? -1))
    c.on('error', (e) => { log('spawn error: ' + e.message); resolve(-1) })
  })
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

function readVersion() {
  try {
    const p = path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
    return JSON.parse(fs.readFileSync(p, 'utf8')).version || ''
  } catch { return '' }
}

// 读 npm dist-tags.latest（走 npm CLI，自动跟随用户的 registry 配置）
function latestNpmVersion() {
  try {
    const p = spawnSync('cmd.exe', ['/c', 'npm', 'view', '@deepseek-ai/dsh', 'version', '--json'], { stdio: 'pipe', windowsHide: true, timeout: 30000 })
    const s = String(p.stdout || '').trim().replace(/^"+|"+$/g, '')
    return s || ''
  } catch { return '' }
}

// 版本比较：主版本逐段数值；预发布段（alpha/beta/rc.x）小于正式版，段内数字按数值比
function cmpVer(a, b) {
  const norm = (v) => {
    const parts = String(v || '').trim().split('-')
    const nums = (parts[0] || '').split('.').map((x) => parseInt(x, 10) || 0)
    while (nums.length < 3) nums.push(0)
    return { nums, pre: parts.slice(1).join('-') || '' }
  }
  const A = norm(a), B = norm(b)
  for (let i = 0; i < 3; i++) if (A.nums[i] !== B.nums[i]) return A.nums[i] - B.nums[i]
  if (A.pre === B.pre) return 0
  if (!A.pre) return 1
  if (!B.pre) return -1
  const px = A.pre.split('.'), py = B.pre.split('.')
  for (let i = 0; i < Math.max(px.length, py.length); i++) {
    const nx = parseInt(px[i], 10), ny = parseInt(py[i], 10)
    if (!isNaN(nx) && !isNaN(ny)) { if (nx !== ny) return nx - ny }
    else if ((px[i] || '') !== (py[i] || '')) return (px[i] || '') < (py[i] || '') ? -1 : 1
  }
  return 0
}

// 清理超过 N 天的旧备份（备份保留 7 天供手动/自动回滚）
function cleanupOldBackups() {
  try {
    const days = CFG.backupRetentionDays || 7
    const now = Date.now()
    for (const n of fs.readdirSync(STATE_DIR)) {
      // 备份目录与缓存源码包（dsh-src-*.tar.gz）统一保留 7 天后自动删除
      if (!n.startsWith('backup-') && !n.startsWith('dsh-src-')) continue
      const p = path.join(STATE_DIR, n)
      try {
        if (now - fs.statSync(p).mtimeMs > days * 24 * 3600 * 1000) {
          fs.rmSync(p, { recursive: true, force: true })
          log('cleaned old backup (>' + days + 'd): ' + n)
        }
      } catch { /* ignore */ }
    }
    // 升级中断遗留的 src-prev 同样按 7 天清理（正常流程健康检查通过后立即删除）
    try {
      const upRoot = path.join(os.homedir(), '.dsh', 'upgrades')
      for (const v of fs.readdirSync(upRoot)) {
        const sp = path.join(upRoot, v, 'src-prev')
        try {
          if (fs.existsSync(sp) && now - fs.statSync(sp).mtimeMs > days * 24 * 3600 * 1000) {
            fs.rmSync(sp, { recursive: true, force: true })
            log('cleaned stale src-prev (>' + days + 'd): ' + v)
          }
        } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
  } catch { /* ignore */ }
}

// 杀掉所有仍从全局 dsh 运行的 node 进程（避免文件锁 / 让回滚干净）
function killGlobalDshProcesses() {
  try {
    spawnSync('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
      "Get-CimInstance Win32_Process -Filter \\\"Name='node.exe'\\\" | " +
      "Where-Object { $_.CommandLine -like '*@deepseek-ai\\\\dsh\\\\lib\\\\bin.js*' } | " +
      "ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
    ], { stdio: 'ignore', windowsHide: true })
  } catch { /* ignore */ }
}

// 轮询健康检查：新 dsh 起来后返回其 /status 对象；超时返回 { fail: 原因 }
async function waitForHealth(url, timeoutMs) {
  const t0 = Date.now()
  let last = ''
  while (Date.now() - t0 < timeoutMs) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(4000) })
      if (res.ok) {
        const j = await res.json()
        if (j && j.ok) return j
        last = 'api responded but ok=false: ' + JSON.stringify(j).slice(0, 120)
      } else {
        last = 'HTTP ' + res.status
      }
    } catch (e) { last = (e && e.message) ? e.message : String(e) }
    await sleep(2000)
  }
  return { fail: last || 'timeout' }
}

// 启动阶段：等待旧进程退出
async function waitExit() {
  const total = CFG.sleepS * 1000
  for (let i = 0; i <= 10; i++) {
    writeProgress('wait-exit', Math.round((i / 10) * 5), '等待旧服务退出…', '')
    await sleep(total / 10)
  }
}

const GITHUB_STAGES = [
  { key: 'download', start: 5, end: 12, label: '下载官方源码' },
  { key: 'extract', start: 12, end: 16, label: '解压源码' },
  { key: 'pnpm', start: 16, end: 40, label: '安装依赖' },
  { key: 'build-host', start: 40, end: 52, label: '编译服务端' },
  { key: 'build-client', start: 52, end: 62, label: '编译客户端库' },
  { key: 'build-web', start: 62, end: 76, label: '编译网页界面' },
  { key: 'deploy', start: 76, end: 88, label: '替换安装' },
  { key: 'relaunch', start: 88, end: 93, label: '重启服务' },
  { key: 'health', start: 93, end: 97, label: '健康检查' },
  { key: 'done', start: 97, end: 100, label: '完成' },
]
const NPM_STAGES = [
  { key: 'wait-exit', start: 0, end: 5, label: '等待旧服务退出' },
  { key: 'install', start: 5, end: 75, label: '安装最新版' },
  { key: 'verify', start: 75, end: 88, label: '校验版本' },
  { key: 'relaunch', start: 88, end: 93, label: '重启服务' },
  { key: 'health', start: 93, end: 97, label: '健康检查' },
  { key: 'done', start: 97, end: 100, label: '完成' },
]

function stageSpan(stages, key) {
  const s = stages.find((x) => x.key === key)
  return s ? [s.start, s.end, s.label] : [0, 0, key]
}

async function main() {
  log('=== dsh upgrade start (' + CFG.mode + ') target=' + CFG.target + ' ===')
  writeProgress('queued', 0, '准备升级…', '')
  cleanupOldBackups()

  // 回滚状态（github 分支内赋值，健康检查段共用）
  let rollbackDir = null
  let doRollback = () => false
  // junction 安装不会产生备份目录：换位前的旧 src 一直保留到健康检查通过，
  // 失败时用它换回（全局 junction 指向的路径不变，换回即恢复）。
  let prevSrcKeep = null

  if (CFG.mode === 'github') {
    const stages = GITHUB_STAGES
    const upgradesRoot = path.join(os.homedir(), '.dsh', 'upgrades')
    const targetDir = path.join(upgradesRoot, CFG.target)
    const tarball = path.join(STATE_DIR, 'dsh-src-' + CFG.target + '.tar.gz')
    const srcDir = path.join(targetDir, 'src')
    // 暂存构建区：下载/解压/编译全部在 staging 里进行，全部成功后才换入正式 src。
    // 期间旧 src 原封未动 —— 构建中途失败也只影响暂存区，旧部署照常能跑。
    const staging = path.join(targetDir, 'staging')
    const buildDir = path.join(staging, 'src')
    const outLog = path.join(STATE_DIR, 'github-out.log')

    // github 分支失败兜底：凡是还没动全局安装的失败，旧部署都完好，先把原服务拉起来再退出，
    // 别让 dsh 死着（2026-08-29 实测踩坑：下载失败裸 exit，dsh 死到用户来敲命令）。
    const relaunchOld = () => {
      log('failure path: relaunching existing install')
      spawn('cmd.exe', ['/c', CFG.relaunchFile], { detached: true, stdio: 'ignore', windowsHide: true, cwd: STATE_DIR }).unref()
    }

    // 1) 等旧进程退出
    await waitExit()

    // 2) 下载（流式，字节级进度）
    //    安全顺序：先落到 tarball，下载成功后才动旧源码树。2026-08-29 实测踩坑：
    //    先删后下 + 网络抖动 = 旧树没了新的又没下来，junction 悬空，dsh 起不来。
    //    已有完整 tarball（>100KB 且 tar -tzf 校验通过）直接复用：tag 包内容不变，
    //    重试不再吃网络亏。半截包必须重新下载，否则解压必失败。
    const url = 'https://github.com/deepseek-ai/deepseek-harness/archive/refs/tags/dsh-v' + CFG.target + '.tar.gz'
    const bsdTar = path.join(process.env.SystemRoot || 'C:\\\\Windows', 'System32', 'tar.exe')
    const tarballOk = () => {
      try {
        if (!fs.existsSync(tarball) || fs.statSync(tarball).size < 100000) return false
        const chk = spawnSync(bsdTar, ['-tzf', tarball], { stdio: 'pipe', windowsHide: true })
        return chk.status === 0
      } catch { return false }
    }
    if (tarballOk()) {
      log('reuse cached tarball: ' + fs.statSync(tarball).size + ' bytes')
      writeProgress('download', 100, '使用已缓存的源码包', (fs.statSync(tarball).size / 1048576).toFixed(1) + ' MB')
    } else {
      writeProgress('download', 0, '正在下载官方源码…', '')
      log('downloading ' + url)
      try {
        const res = await fetch(url, { redirect: 'follow' })
        if (!res.ok || !res.body) throw new Error('HTTP ' + res.status)
        const total = Number(res.headers.get('content-length')) || 0
        const out = fs.createWriteStream(tarball)
        const reader = res.body.getReader()
        let got = 0
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          got += value.length
          out.write(Buffer.from(value))
          if (total > 0) {
            const pct = (got / total) * 100
            const [s, e] = stageSpan(stages, 'download')
            writeProgress('download', Math.round(s + ((e - s) * pct) / 100), '正在下载官方源码 ' + Math.round(pct) + '%', (got / 1048576).toFixed(1) + ' MB / ' + (total / 1048576).toFixed(1) + ' MB')
          }
        }
        out.end()
        await new Promise((r) => out.on('finish', r))
        if (!tarballOk()) throw new Error('download incomplete or corrupt')
        log('download ok: ' + fs.statSync(tarball).size + ' bytes')
      } catch (e) {
        try { fs.rmSync(tarball, { force: true }) } catch { /* ignore */ }
        log('DOWNLOAD FAILED: ' + e.message)
        writeProgress('error', 100, '下载源码失败（旧版本不受影响，已重启原服务）', String(e && typeof e === 'object' && 'message' in e ? e.message : e))
        relaunchOld()
        process.exit(1)
      }
    }

    // 3) 解压（tar 命令，进度按阶段区间）
    //    注意：必须用 Windows 自带 bsdtar 的绝对路径。PATH 里若解析到 Git Bash 的
    //    GNU tar（/usr/bin/tar），它会把 -C 参数里的 "C:" 当成远程主机名（host:path
    //    老语法）而报 "Cannot connect to C" —— 实测踩坑。
    //    另外：源码包里有少量文档类 symlink（CLAUDE.md -> AGENTS.md 等），Windows
    //    无特权创建 symlink 会失败导致 tar exit 1——它们与构建无关，判据改为
    //    「关键内容存在」（根 package.json + apps/cli/package.json）。
    writeProgress('extract', 0, '正在解压源码…', '')
    fs.rmSync(staging, { recursive: true, force: true })
    fs.mkdirSync(staging, { recursive: true })
    const ex = spawnSync(bsdTar, ['-xzf', tarball, '-C', staging], { stdio: 'pipe', windowsHide: true })
    const expectedDir = 'deepseek-harness-dsh-v' + CFG.target
    const srcPkg = path.join(staging, expectedDir, 'package.json')
    const cliPkg = path.join(staging, expectedDir, 'apps', 'cli', 'package.json')
    if (!fs.existsSync(srcPkg) || !fs.existsSync(cliPkg)) {
      log('EXTRACT FAILED: tar exit ' + ex.status + (ex.stderr ? ' stderr: ' + String(ex.stderr).slice(0, 300) : ''))
      writeProgress('error', 100, '解压源码失败（旧版本不受影响，已重启原服务）', ex.stderr ? String(ex.stderr).slice(0, 200) : 'tar exit ' + ex.status)
      relaunchOld()
      process.exit(1)
    }
    log('extract done (tar exit ' + ex.status + '; Windows 会跳过无权限的文档类 symlink，不影响构建)')
    const extracted = fs.readdirSync(staging).find((n) => n.startsWith('deepseek-harness-'))
    if (!extracted) { log('EXTRACT: no source dir found'); relaunchOld(); process.exit(1) }
    fs.renameSync(path.join(staging, extracted), buildDir)
    writeProgress('extract', 100, '解压完成', '')

    // 4) pnpm install（在暂存区 buildDir 里，失败不影响旧部署）
    writeProgress('pnpm', 0, '正在安装依赖（约 1 分钟）…', '')
    log('pnpm install...')
    const p1 = await run('cmd.exe', ['/c', 'pnpm', 'install', '--no-frozen-lockfile'], { cwd: buildDir, env: { ...process.env, COREPACK_ENABLE_STRICT: '0' } })
    log('pnpm install exit: ' + p1)
    if (p1 !== 0) { writeProgress('error', 100, '依赖安装失败（旧版本不受影响，已重启原服务）', ''); relaunchOld(); process.exit(1) }

    // 5) build host
    writeProgress('build-host', 0, '正在编译服务端…', '')
    const p2 = await run('cmd.exe', ['/c', 'npm', 'run', 'build:lib:host'], { cwd: buildDir })
    log('build host exit: ' + p2)
    if (p2 !== 0) { writeProgress('error', 100, '服务端编译失败（旧版本不受影响，已重启原服务）', ''); relaunchOld(); process.exit(1) }

    // 6) build client
    writeProgress('build-client', 0, '正在编译前端…', '')
    const p3 = await run('cmd.exe', ['/c', 'npm', 'run', 'build:lib:client'], { cwd: buildDir })
    log('build client exit: ' + p3)
    if (p3 !== 0) { writeProgress('error', 100, '前端编译失败（旧版本不受影响，已重启原服务）', ''); relaunchOld(); process.exit(1) }

    // 6.5) build web SPA —— 源码树不带 dist，缺了这步部署出来的 dsh 网页会 404（实测踩坑）
    writeProgress('build-web', 0, '正在编译网页界面（约 1-2 分钟）…', '')
    const p4 = await run('cmd.exe', ['/c', 'npm', 'run', 'build:web'], { cwd: buildDir })
    log('build web exit: ' + p4)
    if (p4 !== 0) { writeProgress('error', 100, '网页界面编译失败（旧版本不受影响，已重启原服务）', ''); relaunchOld(); process.exit(1) }

    // 6.6) 部署前产物校验：bin.js 与网页 dist 必须存在，否则部署出去也起不来
    const webDist = path.join(buildDir, 'apps', 'web', 'dist')
    const binFile = path.join(buildDir, 'apps', 'cli', 'lib', 'bin.js')
    if (!fs.existsSync(binFile)) {
      log('VERIFY FAILED: ' + binFile + ' missing')
      writeProgress('error', 100, '构建产物缺失', '缺少 apps/cli/lib/bin.js')
      relaunchOld()
      process.exit(1)
    }
    if (!fs.existsSync(path.join(webDist, 'index.html'))) {
      log('VERIFY FAILED: ' + webDist + ' missing index.html')
      writeProgress('error', 100, '网页构建产物缺失', '缺少 apps/web/dist/index.html')
      relaunchOld()
      process.exit(1)
    }
    log('artifacts verified: bin.js + web dist OK')

    // 6.9) 构建+校验全部通过 → 换入正式 src。注意（2026-08-29 实测踩坑）：Windows 上
    // pnpm 的工作区链接是【绝对 junction】，指向构建时的 staging 路径，换位后必悬空
    // （症状：bin.js 启动报 Cannot find package '@deepseek-ai/dsh-app-boot'）。所以换入后
    // 必须在正式位置重跑一次 pnpm install（CI=true 允许清理重装）重锚链接；
    // 旧 src 先改名保留，重锚失败即自动换回并重启原服务。
    const prevSrc = path.join(targetDir, 'src-prev')
    fs.rmSync(prevSrc, { recursive: true, force: true })
    try {
      if (fs.existsSync(srcDir)) fs.renameSync(srcDir, prevSrc)
      fs.renameSync(buildDir, srcDir)
      writeProgress('deploy', 10, '正在重锚工作区链接…', 'pnpm install（换位后必须重跑）')
      const rp = await run('cmd.exe', ['/c', 'pnpm', 'install', '--no-frozen-lockfile'], { cwd: srcDir, env: { ...process.env, COREPACK_ENABLE_STRICT: '0', CI: 'true' } })
      log('re-anchor pnpm install exit: ' + rp)
      if (rp !== 0) throw new Error('re-anchor pnpm install exit ' + rp)
      if (!fs.existsSync(path.join(srcDir, 'apps', 'cli', 'lib', 'bin.js'))) throw new Error('bin.js missing after re-anchor')
      fs.statSync(path.join(srcDir, 'apps', 'cli', 'node_modules', '@deepseek-ai', 'dsh-app-boot'))
    } catch (e) {
      const msg = String(e && typeof e === 'object' && 'message' in e ? e.message : e)
      log('SWAP FAILED: ' + msg + ' — restoring previous src')
      fs.rmSync(srcDir, { recursive: true, force: true })
      if (fs.existsSync(prevSrc)) fs.renameSync(prevSrc, srcDir)
      prevSrcKeep = null
      fs.rmSync(staging, { recursive: true, force: true })
      writeProgress('error', 100, '换入构建失败，已恢复旧版本并重启原服务', msg)
      relaunchOld()
      process.exit(1)
    }
    // 旧 src 暂不删除：健康检查通过才清理；失败时 doRollback 用它换回
    prevSrcKeep = prevSrc
    fs.rmSync(staging, { recursive: true, force: true })
    log('staged build swapped into ' + srcDir + ' (links re-anchored); prev src kept for rollback')

    // 7) 部署：全局 @deepseek-ai/dsh → junction 指向源码 apps/cli（旧版备份可回滚）
    writeProgress('deploy', 30, '正在替换安装…', '备份旧版本')
    const globalDsh = path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', '@deepseek-ai', 'dsh')
    const backupDir = path.join(STATE_DIR, 'backup-' + new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14))

    // 部署前：杀掉其它仍从全局 dsh 运行的 node 进程（它们会锁住 .node 文件导致 rename 失败）。
    // 包括老的本机实例、以及作为后台 worker 重启的 dsh web 实例。只匹配 @deepseek-ai\\dsh\\lib\\bin.js。
    // 注意：本段位于 writeNodeWrapper 的模板字面量内，输出文件里的每个反斜杠
    // 在模板源码里都必须写成 \\（否则运行时会煮熟成单个 \ 或真实换行等）。
    const killOthers = () => {
      try {
        const ps = spawnSync('powershell.exe', [
          '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
          "Get-CimInstance Win32_Process -Filter \\\"Name='node.exe'\\\" | " +
          "Where-Object { $_.CommandLine -like '*@deepseek-ai\\\\dsh\\\\lib\\\\bin.js*' } | " +
          "ForEach-Object { Write-Output $_.ProcessId }"
        ], { stdio: 'pipe', windowsHide: true })
        const pids = String(ps.stdout || '')
          .split(/\\r?\\n/).map((s) => s.trim()).filter((s) => /^\\d+$/.test(s))
        log('global-dsh node pids before deploy: ' + (pids.join(',') || '(none)'))
        for (const pid of pids) {
          try {
            spawnSync('powershell.exe', [
              '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
              "Stop-Process -Id " + pid + " -Force -ErrorAction SilentlyContinue"
            ], { stdio: 'ignore', windowsHide: true })
            log('killed global-dsh node pid ' + pid)
          } catch (err) { log('kill pid ' + pid + ' failed: ' + err.message) }
        }
        return pids.length
      } catch (e) { log('killOthers error: ' + e.message); return 0 }
    }

    // rename 重试：第一次失败可能是文件锁刚释放不完全，等 1.5s 再试。
    const renameWithRetry = (src, dst) => {
      for (let i = 0; i < 4; i++) {
        try { fs.renameSync(src, dst); return true } catch (e) {
          if (i === 3) throw e
          log('rename attempt ' + (i + 1) + ' failed: ' + e.message + ' — retrying…')
          execSync('powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Start-Sleep -Milliseconds 1500"', { stdio: 'ignore' })
        }
      }
      return false
    }

    // 回滚点：备份成功后就位。任何后续失败（部署、健康检查）都会用它恢复旧版本。
    const setRollbackDir = (dir) => { rollbackDir = dir; log('rollback point set: ' + dir) }

    // 回滚：杀掉新实例进程 → 移除 junction/新目录 → 恢复备份
    doRollback = (reason) => {
      log('ROLLBACK: ' + reason)
      try {
        killGlobalDshProcesses()
        if (rollbackDir) {
          if (fs.existsSync(globalDsh)) {
            let isLink = false
            try { fs.readlinkSync(globalDsh); isLink = true } catch { isLink = false }
            if (isLink) log('rollback: removing junction at ' + globalDsh)
            else log('rollback: removing dir at ' + globalDsh)
            fs.rmSync(globalDsh, { recursive: true, force: true })
          }
          if (fs.existsSync(rollbackDir) && !fs.existsSync(globalDsh)) {
            fs.renameSync(rollbackDir, globalDsh)
            log('rollback: restored backup -> ' + globalDsh)
            return true
          }
          log('rollback: backup missing (' + rollbackDir + '), cannot restore')
          return false
        }
        // junction 安装没有备份目录：换回保留的旧 src。全局 junction 指向的
        // 路径不变（upgrades 目录里同版本 src 的 apps/cli），换回后链接自动恢复有效。
        if (prevSrcKeep && fs.existsSync(prevSrcKeep)) {
          log('rollback: restoring kept previous src -> ' + srcDir)
          fs.rmSync(srcDir, { recursive: true, force: true })
          fs.renameSync(prevSrcKeep, srcDir)
          prevSrcKeep = null
          if (!fs.existsSync(path.join(srcDir, 'apps', 'cli', 'lib', 'bin.js'))) {
            log('rollback: restored src missing bin.js')
            return false
          }
          log('rollback: previous src restored (junction target path unchanged)')
          return true
        }
        log('rollback: no backup point and no kept previous src, nothing to restore')
        return false
      } catch (e) { log('rollback error: ' + e.message) }
      return false
    }

    try {
      if (fs.existsSync(globalDsh)) {
        // 判断是否为链接（symlink 或 junction）：readlinkSync 对两者都能读出目标。
        // 注意 lstatSync().isSymbolicLink() 对 junction 返回 false（tag 不同），不可用。
        let isLink = false
        try { fs.readlinkSync(globalDsh); isLink = true } catch { isLink = false }
        if (isLink) {
          log('existing junction/symlink removed (previous source install)')
          fs.rmSync(globalDsh, { recursive: true, force: true })
        } else {
          writeProgress('deploy', 40, '正在替换安装…', '等待其它实例退出')
          killOthers()
          writeProgress('deploy', 50, '正在替换安装…', '备份旧版本')
          if (!renameWithRetry(globalDsh, backupDir)) throw new Error('rename backup failed')
          log('backed up old dsh to ' + backupDir)
          setRollbackDir(backupDir)
        }
      }
      writeProgress('deploy', 60, '正在替换安装…', '建立新版链接')
      // junction：用 cmd mklink /J（Node 无原生 junction API）
      const mk = spawnSync('cmd.exe', ['/c', 'mklink', '/J', globalDsh, path.join(srcDir, 'apps', 'cli')], { stdio: 'pipe', windowsHide: true })
      log('junction result: ' + (mk.stdout ? String(mk.stdout).trim() : '') + (mk.stderr ? String(mk.stderr).trim() : ''))
      if (!fs.existsSync(path.join(globalDsh, 'lib', 'bin.js'))) throw new Error('junction target missing lib/bin.js')
      writeProgress('deploy', 90, '正在校验安装…', '')
      const depVer = readVersion()
      log('deployed version reads: ' + depVer)
      if (depVer !== CFG.target) throw new Error('version mismatch after deploy: ' + depVer)
      writeProgress('deploy', 100, '替换完成', '')
      log('deployed junction to ' + globalDsh)
    } catch (e) {
      const msg = String(e && typeof e === 'object' && 'message' in e ? e.message : e)
      log('DEPLOY FAILED: ' + msg)
      const ok = doRollback('部署失败：' + msg)
      const label = ok
        ? '替换安装失败，已自动回滚旧版本'
        : (rollbackDir || prevSrcKeep)
          ? '替换安装失败，自动回滚未成功（手动恢复：运行 ' + CFG.rollbackFile + '）'
          : '替换安装失败（旧版本未受影响，无需回滚）'
      writeProgress('error', 100, label, msg)
      // 宿主早已退出：无论回滚结果如何都要拉起一次 dsh，否则端口就空了
      spawn('cmd.exe', ['/c', CFG.relaunchFile], { detached: true, stdio: 'ignore', windowsHide: true, cwd: STATE_DIR }).unref()
      log('deploy-fail relaunch issued')
      process.exit(1)
    }
  } else {
    // npm 模式
    const stages = NPM_STAGES
    await waitExit()
    const pkg = path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
    const cur = readVersion()
    log('current global version: ' + cur)
    const outLog = path.join(STATE_DIR, 'npm-stdout.log')
    let code = 0
    if (cur === CFG.target && CFG.target !== '') {
      log('already at target, skip install')
      code = 0
    } else {
      writeProgress('install', 10, '正在安装最新版…', '')
      if (CFG.target !== '') {
        log('attempting exact install: @deepseek-ai/dsh@' + CFG.target)
        code = await run('cmd.exe', ['/c', 'npm', 'install', '-g', '@deepseek-ai/dsh@' + CFG.target, '--loglevel', 'error'])
        log('exact install exit: ' + code)
      } else { code = 1 }
      if (code !== 0) {
        // 防降级：exact 安装失败时先核对 npm 的 dist-tags.latest 是否真的比当前新。
        // 官方会把 latest 标签停在 rc 线（实测 0.1.1-rc.2），盲目装 @latest 会把
        // 源码安装的新版本降级回旧版（2026-09-01 踩坑）。
        writeProgress('install', 50, '正在核对 npm 源可用版本…', '')
        const cur = readVersion()
        const lv = latestNpmVersion()
        log('exact install failed; npm dist-tags.latest=' + lv + ', current=' + cur)
        if (lv && cmpVer(lv, cur) > 0) {
          writeProgress('install', 50, '正在回退安装 npm 最新版…', '')
          code = await run('cmd.exe', ['/c', 'npm', 'install', '-g', '@deepseek-ai/dsh@latest', '--loglevel', 'error'])
          log('npm @latest exit: ' + code)
        } else {
          log('refusing downgrade: npm latest ' + (lv || '?') + ' <= current ' + cur)
          writeProgress('error', 100, 'npm 源没有比当前更新的版本（官方 latest 停留在 ' + (lv || '?') + '，最新测试版未发布），已保留当前版本并重启原服务', '')
          spawn('cmd.exe', ['/c', CFG.relaunchFile], { detached: true, stdio: 'ignore', windowsHide: true, cwd: STATE_DIR }).unref()
          process.exit(1)
        }
      }
    }
    writeProgress('verify', 30, '正在校验版本…', '')
    const ver = readVersion()
    log('installed version now: ' + ver)
    if (code !== 0) log('upgrade FAILED (code ' + code + '), relaunching old version anyway')
    writeProgress('verify', 100, ver === CFG.target ? '版本校验通过' : '已安装 ' + (ver || '?'), ver || '')

    // npm 模式的回滚目标：升级前版本（升级后起不来就装回去）
    const npmPrev = cur && cur !== ver ? cur : ''
    CFG._npmPrev = npmPrev
  }

  // relaunch（github / npm 共用）
  writeProgress('relaunch', 30, '正在重启服务…', '')
  log('relaunching: ' + CFG.relaunchFile)
  spawn('cmd.exe', ['/c', CFG.relaunchFile], { detached: true, stdio: 'ignore', windowsHide: true, cwd: STATE_DIR }).unref()
  writeProgress('relaunch', 100, '服务重启中…', '')
  log('relaunch issued, waiting for health...')

  // 健康检查：新 dsh 起不来（端口不通 / 更新器插件没加载 / 版本不对）→ 自动回滚
  writeProgress('health', 10, '正在检查新服务是否正常…', '')
  const health = await waitForHealth(CFG.healthUrl, CFG.healthTimeoutMs)
  if (health.fail) {
    const reason = health.fail
    log('HEALTH CHECK FAILED: ' + reason)
    if (CFG.mode === 'github') {
      const ok = doRollback('新版本启动失败（' + reason + '），自动回滚')
      writeProgress('error', 100, ok ? '升级失败，已自动回滚到旧版本并重启' : '升级失败，自动回滚未成功（手动恢复：运行 ' + CFG.rollbackFile + '）', reason)
    } else {
      // npm 模式：把旧版本装回去；npm 上没有旧版（源码构建版从未发过 npm）时，
      // 若本地还有该版本的源码构建树，直接重建 junction 复原（2026-09-01 踩坑：
      // alpha.1 只存在于 GitHub tag，npm 回滚 ETARGET，导致升级失败后无人接管）
      let rb = -1
      if (CFG._npmPrev) {
        log('npm rollback: reinstalling ' + CFG._npmPrev)
        rb = await run('cmd.exe', ['/c', 'npm', 'install', '-g', '@deepseek-ai/dsh@' + CFG._npmPrev, '--loglevel', 'error'])
        log('npm rollback install exit: ' + rb)
      }
      if (rb !== 0 && CFG._npmPrev) {
        const prevSrcCli = path.join(os.homedir(), '.dsh', 'upgrades', CFG._npmPrev, 'src', 'apps', 'cli')
        if (fs.existsSync(path.join(prevSrcCli, 'lib', 'bin.js'))) {
          const gd = path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', '@deepseek-ai', 'dsh')
          try {
            if (fs.existsSync(gd)) fs.rmSync(gd, { recursive: true, force: true })
            const mk2 = spawnSync('cmd.exe', ['/c', 'mklink', '/J', gd, prevSrcCli], { stdio: 'pipe', windowsHide: true })
            log('npm rollback via junction to ' + prevSrcCli + ': exit ' + mk2.status)
            if (mk2.status === 0) rb = 0
          } catch (e) { log('junction rollback error: ' + e.message) }
        }
      }
      writeProgress('error', 100, rb === 0 ? '升级失败，已回滚到 ' + CFG._npmPrev + ' 并重启' : '升级失败，回滚未成功（手动恢复：运行 ' + CFG.rollbackFile + '）', reason)
    }
    // 回滚后重启旧版本（github 已恢复备份目录 / npm 已重装旧版，这里统一拉起）
    spawn('cmd.exe', ['/c', CFG.relaunchFile], { detached: true, stdio: 'ignore', windowsHide: true, cwd: STATE_DIR }).unref()
    log('rollback relaunch issued')
    process.exit(1)
  }
  const healthVer = health.installed || CFG.target
  log('health check passed: installed=' + healthVer)
  // 健康检查通过：换位前保留的旧 src 到此为止，可以删了
  if (prevSrcKeep) {
    try { fs.rmSync(prevSrcKeep, { recursive: true, force: true }); log('health ok, removed kept prev src') } catch { /* ignore */ }
    prevSrcKeep = null
  }
  writeProgress('health', 100, '新服务已正常启动', healthVer)
  writeProgress('done', 100, '升级完成，dsh 已运行 ' + healthVer, '')
  clearTick()
  console.log('')
  console.log('升级完成 ✅ dsh 已更新到 ' + healthVer + '，浏览器请刷新页面')
}

main().catch((e) => {
  const msg = String(e && e.message ? e.message : e)
  log('WRAPPER FATAL: ' + msg)
  writeProgress('error', 100, '升级异常', msg)
})
`
    writeFileSync(scriptFile, code, 'utf8')
  }

  function startUpgrade(source: 'npm' | 'github' = 'npm'): { ok: boolean; message?: string; error?: string } {
    if (state.status === 'upgrading') return { ok: false, error: '已有升级任务正在进行中，请稍候' }
    if (process.platform !== 'win32') return { ok: false, error: '当前仅支持 Windows 环境自动升级' }
    const execPath = process.execPath
    const bin = process.argv[1]
    if (!bin || !existsSync(bin)) return { ok: false, error: '无法定位 dsh 启动入口（process.argv[1]）' }
    const cwd = process.cwd()
    const relaunchArgs = process.argv.slice(2)

    try {
      mkdirSync(stateDir, { recursive: true })

      // 1) 重启脚本 relaunch.cmd：以原命令重开一个可见控制台窗口，
      //    并保留父进程的 DSH_* 环境变量（DSH_HOME 等）。
      //    注意：Node 24 undici fetch 在**进程启动时**缓存 HTTP(S)_PROXY 环境变量，
      //    若代理应用已失效（端口在听但不转发），fetch 会全部失败且进程内无法修复。
      //    因此重启时显式清空代理环境变量走直连（直连不通时再考虑代理方案）。
      //    结尾用 timeout 自动关窗（8s），避免 node 启动失败时空窗长留。
      const relaunchFile = join(stateDir, 'relaunch.cmd')
      const lines = [
        '@echo off',
        'title dsh web (auto-restarted by dsh-updater)',
        `cd /d "${cwd}"`,
      ]
      for (const [k, v] of Object.entries(process.env)) {
        if (k.startsWith('DSH_') && v) lines.push(`set "${k}=${v}"`)
      }
      for (const k of ['ALL_PROXY', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'NODE_USE_ENV_PROXY']) {
        lines.push(`set "${k}="`)
      }
      lines.push(`"${execPath}" "${bin}"${relaunchArgs.map((a) => ` "${a}"`).join('')}`)
      lines.push('timeout /t 8 /nobreak >nul')
      writeFileSync(relaunchFile, lines.join('\r\n') + '\r\n', 'utf8')

      // 2) 生成升级脚本 upgrade.mjs（Node 版，阶段表驱动逐步写 progress.json）
      //    与独立进度服务 progress-server.mjs（宿主退出后页面靠它看进度），
      //    以及手动回滚脚本 rollback.cmd（把全局 dsh 恢复为最近备份）。
      const scriptFile = join(stateDir, 'upgrade.mjs')
      const serverFile = join(stateDir, 'progress-server.mjs')
      writeProgressServer(serverFile)
      writeNodeWrapper(scriptFile, source)

      // 2.5) 手动回滚脚本：自动回滚的兜底（升级中 wrapper 被杀/断电时用户双击用）。
      //      两种安装形态都要能恢复：npm 安装恢复 backup-* 目录；
      //      源码/junction 安装没有备份目录，恢复升级前保留的 src-prev
      //      （junction 指向 src 路径不变，换回即恢复，无需重建链接）。
      const rollbackFile = join(stateDir, 'rollback.cmd')
      const globalDshDir = join(homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', '@deepseek-ai', 'dsh')
      const upgradesRoot = join(homedir(), '.dsh', 'upgrades')
      const rbLines = [
        '@echo off',
        'chcp 65001 >nul',
        'title dsh 回滚 (dsh-updater)',
        'echo [1/3] 正在停止当前 dsh 实例...',
        'powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process -Filter \\"Name=\'node.exe\'\\" ^| Where-Object { $_.CommandLine -like \'*@deepseek-ai\\dsh\\lib\\bin.js*\' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"',
        'echo [2/3] 恢复旧版本（优先 backup-* 备份目录，其次 src-prev）...',
        `dir /b /ad "${stateDir}\\backup-*" >nul 2>&1`,
        'if not errorlevel 1 goto restore-backup',
        'goto restore-srcprev',
        ':restore-backup',
        `if exist "${globalDshDir}" rmdir /s /q "${globalDshDir}"`,
        `powershell -NoProfile -ExecutionPolicy Bypass -Command "$b = Get-ChildItem '${stateDir}' -Directory -Filter 'backup-*' ^| Sort-Object LastWriteTime -Descending ^| Select-Object -First 1; Move-Item $b.FullName '${globalDshDir}'; Write-Output ('已恢复备份: ' + $b.Name)"`,
        'goto relaunch',
        ':restore-srcprev',
        `powershell -NoProfile -ExecutionPolicy Bypass -Command "$sp = Get-ChildItem '${upgradesRoot}' -Directory ^| ForEach-Object { Join-Path $_.FullName 'src-prev' } ^| Where-Object { Test-Path $_ } ^| ForEach-Object { Get-Item $_ } ^| Sort-Object LastWriteTime -Descending ^| Select-Object -First 1; if ($sp) { $root = Split-Path $sp.FullName; if (Test-Path ($root + '\\src')) { Remove-Item ($root + '\\src') -Recurse -Force -ErrorAction SilentlyContinue }; Move-Item $sp.FullName ($root + '\\src'); Write-Output ('已恢复升级前源码: ' + $root) } else { Write-Output '既无 backup-* 备份也无 src-prev，无法自动恢复'; exit 1 }"`,
        'if errorlevel 1 (',
        '  echo 自动恢复失败：请把 upgrades\\<版本>\\src-prev 手动改名回 src 后再运行 relaunch.cmd',
        '  pause',
        '  exit /b 1',
        ')',
        ':relaunch',
        'echo [3/3] 正在重启 dsh...',
        `call "${relaunchFile}"`,
        'echo 完成。此窗口可以关闭。',
        'pause',
      ]
      writeFileSync(rollbackFile, rbLines.join('\r\n') + '\r\n', 'utf8')

      // 3) 启动进度服务（脱离进程，宿主退出后仍存活），再启动升级 wrapper。
      //    实测 detached spawn 会随宿主进程退出被杀；`cmd /c start` 启动的
      //    进程与父进程树脱离、可独立存活（已验证可靠）。
      //    - wrapper：可见控制台窗口（用户要求能看到实时进度与最终结果）。
      //      2026-08-29 实测踩坑：`start 标题 cmd /k "chcp … & node 脚本"` 的多层
      //      引号会被 cmd 拆坏（node 收到拼接坏路径 MODULE_NOT_FOUND）。
      //      改为先生成干净的 run-upgrade.cmd 批处理（title + chcp + node + pause），
      //      start 直接拉起批处理 —— 零嵌套引号；pause 让窗口在结束后保留可读。
      //    - progress-server：无窗口（powershell -WindowStyle Hidden 包一层）。
      const runBatFile = join(stateDir, 'run-upgrade.cmd')
      const batLines = [
        '@echo off',
        // 先切 UTF-8 代码页，再设中文标题（cmd 按 console 当前代码页解码后续行）
        'chcp 65001 >nul',
        'title dsh 自动升级',
        `"${process.execPath}" "${scriptFile}"`,
        'echo.',
        'pause',
      ]
      writeFileSync(runBatFile, batLines.join('\r\n') + '\r\n', 'utf8')

      const startDetached = (file: string, visible: boolean): void => {
        // 清空代理环境变量再启动子进程：undici 在进程启动时缓存 HTTP(S)_PROXY，
        // 若继承宿主里已失效的代理配置，wrapper 的下载 fetch 会全部失败。
        const env = { ...process.env }
        for (const k of ['ALL_PROXY', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'NODE_USE_ENV_PROXY']) {
          delete env[k]
        }
        let args: string[]
        if (visible) {
          // 可见窗口：start "标题" <批处理路径>。
          // 2026-08-29 实测踩坑：路径参数绝不能自己预加引号 —— libuv 会对含引号
          // 的参数再做一层转义，cmd 拆完引号后 start 拿到的是坏路径，窗口静默失败。
          // 直接传原始路径（libuv 会按需加引号），start 把第一个带引号参数当
          // 标题、其后当程序，语义正好正确。
          args = ['/c', 'start', 'dsh 自动升级', runBatFile]
        } else {
          args = ['/c', 'start', '', '/b', 'powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-Command', `node "${file}"`]
        }
        const child = spawn('cmd.exe', args, { detached: true, stdio: 'ignore', windowsHide: true, cwd: stateDir, env })
        child.unref()
      }
      startDetached(serverFile, false)
      startDetached(runBatFile, true)

      state.status = 'upgrading'
      state.upgradeStartedAt = Date.now()
      ctx.logger?.info?.('[' + name + '] 升级脚本已启动，服务即将自动重启')
      setTimeout(() => process.exit(0), EXIT_DELAY_MS)
      return {
        ok: true,
        message: source === 'github'
          ? `已启动 GitHub 源码升级：下载 v${state.latest} 源码 → 安装依赖 → 构建 → 替换全局 dsh → 自动重启。全程约 5-10 分钟：会弹出「dsh 自动升级」窗口显示实时进度；页面左下角也有进度条；若新版本启动失败会自动回滚。`
          : `升级已启动：自动安装 @deepseek-ai/dsh@${state.latest} 并重启服务（弹出「dsh 自动升级」窗口显示进度），完成后自动恢复`,
      }
    } catch (e) {
      state.status = 'idle'
      return { ok: false, error: '升级启动失败: ' + (e instanceof Error ? e.message : String(e)) }
    }
  }

  // ── 定时检测 ────────────────────────────────────────────────────────
  ctx.effect(() => {
    const first = setTimeout(() => void runCheck(), INITIAL_CHECK_DELAY_MS)
    const loop = setInterval(() => void runCheck(), CHECK_INTERVAL_MS)
    return () => {
      clearTimeout(first)
      clearInterval(loop)
    }
  }, 'dsh-updater: auto-check')

  // ── HTTP API ────────────────────────────────────────────────────────
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: '/dsh-updater/api',
        handler: (req: unknown, res: unknown) => {
          const send = (code: number, obj: unknown): void => {
            const r = res as { writeHead(code: number, h: Record<string, string>): void; end(s: string): void }
            r.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
            r.end(JSON.stringify(obj))
          }
          try {
            const url = new URL((req as { url?: string }).url ?? '/', 'http://localhost')
            const path = url.pathname.replace(/^\/dsh-updater\/api/, '') || '/'
            const method = (req as { method?: string }).method ?? 'GET'

            // 写操作 CSRF 防线一：POST 必须来自本机同源页面（或无 Origin 的非浏览器客户端）
            if (method === 'POST' && !isLocalWrite(req)) {
              return send(403, { ok: false, error: '已拒绝：跨站请求（Origin/Referer 校验未通过）' })
            }

            if (method === 'GET' && path === '/status') {
              return send(200, { ok: true, pluginBuild: PLUGIN_BUILD, ...state })
            }
            if (method === 'GET' && path === '/token') {
              // 故意不返回任何 CORS 头：同源 client 可读 body，恶意跨站页面读不到（即拿不到 token）
              return send(200, { ok: true, token: apiToken })
            }
            if (method === 'POST' && path === '/check') {
              void runCheck()
              return send(200, { ok: true, status: state.status, hasUpdate: state.hasUpdate })
            }
            if (method === 'POST' && path === '/upgrade') {
              // CSRF 防线二：必须携带与内存令牌一致的自定义头才执行升级
              if (getHeader(req, 'x-dsh-updater-token') !== apiToken) {
                return send(403, { ok: false, error: '已拒绝：缺少或无效的 X-Dsh-Updater-Token' })
              }
              // source=github → 从 GitHub 源码构建安装（npm 未发布目标版本时的尝鲜通道）
              const srcParam = url.searchParams.get('source')
              const result = startUpgrade(srcParam === 'github' ? 'github' : 'npm')
              return send(result.ok ? 200 : 409, { ...result, ok: result.ok })
            }
            if (method === 'GET' && path === '/log') {
              let log = ''
              try {
                const raw = readFileSync(logFile, 'utf8')
                const lines = raw.split(/\r?\n/).filter((l) => l.length > 0)
                log = lines.slice(-200).join('\n')
              } catch {
                log = '(尚无升级日志)'
              }
              return send(200, { ok: true, log })
            }
            return send(404, { ok: false, error: 'not found: ' + path })
          } catch (e) {
            return send(500, { ok: false, error: String(e instanceof Error ? e.message : e) })
          }
        },
      }),
    'dsh-updater: api',
  )

  ctx.logger?.info?.(
    `[${name}] 已加载 build=${PLUGIN_BUILD}（installed=${state.installed}），5s 后首次检测官方 GitHub 版本`,
  )
}
