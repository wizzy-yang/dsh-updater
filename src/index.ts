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
 */
import type { Context } from 'cordis'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'

export const name = '@wizzy/dsh-updater'
export const inject = ['webServer']

type AppContext = Context & {
  webServer: {
    register(route: { kind: string; path: string; handler: (req: unknown, res: unknown) => void }): unknown
  }
  effect(fn: () => unknown, label?: string): void
  logger?: { info?(msg: string): void; warn?(msg: string): void }
}

const REPO = 'deepseek-ai/deepseek-harness'
const GITHUB_TAGS_URL = `https://api.github.com/repos/${REPO}/tags?per_page=30`
const NPM_LATEST_URL = 'https://registry.npmjs.org/@deepseek-ai/dsh/latest'

const INITIAL_CHECK_DELAY_MS = 5000
const CHECK_INTERVAL_MS = 30 * 60 * 1000
const FETCH_TIMEOUT_MS = 10_000
/** 宿主进程收到升级指令后延迟退出，保证 HTTP 响应先送达浏览器 */
const EXIT_DELAY_MS = 2500
/** 升级脚本先等旧进程退出，再执行 npm 安装（避开全局包文件锁） */
const WRAPPER_SLEEP_S = 5

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

export function apply(ctx: AppContext): void {
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  const stateDir = join(dshHome, 'plugins', 'dsh-updater')
  const logFile = join(stateDir, 'upgrade.log')

  const state: CheckState = {
    status: 'idle',
    installed: readInstalledVersion(),
    latest: '',
    hasUpdate: false,
    source: 'none',
    npmReady: false,
    lastCheckAt: 0,
  }

  // ── 版本检测 ────────────────────────────────────────────────────────
  async function runCheck(): Promise<void> {
    if (state.status !== 'idle') return
    state.status = 'checking'
    state.error = undefined
    try {
      let latest = ''
      let source: 'github' | 'npm' = 'github'
      try {
        const payload = (await fetchJson(GITHUB_TAGS_URL)) as { name?: unknown }[]
        if (!Array.isArray(payload)) throw new Error('GitHub tags 返回格式异常')
        const versions: string[] = []
        for (const t of payload) {
          if (typeof t?.name === 'string') {
            const v = tagToVersion(t.name)
            if (v) versions.push(v)
          }
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
  const psq = (s: string): string => s.replace(/'/g, "''")

  function startUpgrade(): { ok: boolean; message?: string; error?: string } {
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
      lines.push(`"${execPath}" "${bin}"${relaunchArgs.map((a) => ` "${a}"`).join('')}`)
      lines.push('timeout /t 8 /nobreak >nul')
      writeFileSync(relaunchFile, lines.join('\r\n') + '\r\n', 'utf8')

      // 2) 升级脚本 upgrade.ps1：脱离宿主运行；等旧进程退出后 npm 安装，再重启。
      //    npm 输出重定向到文件（管道会因 \r 进度条不触发逐行日志，显得卡死）；
      //    全局包已是目标版本时跳过 npm（秒级完成，避免无谓的 1-2 分钟等待）。
      const ps = [
        "$ErrorActionPreference = 'Continue'",
        `$dir = '${psq(stateDir)}'`,
        `$log = Join-Path $dir 'upgrade.log'`,
        `$relaunch = Join-Path $dir 'relaunch.cmd'`,
        `$npmOut = Join-Path $dir 'npm-stdout.log'`,
        `$npmErr = Join-Path $dir 'npm-stderr.log'`,
        `$target = '${psq(state.latest)}'`,
        "function Log([string]$m) { Add-Content -Path $log -Value ('[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m) -Encoding UTF8 }",
        "Log '=== dsh auto-upgrade start ==='",
        "Log ('wrapper pid: ' + $PID)",
        `Log ('target version: ' + $target + ' | waiting for old process to exit (' + ${WRAPPER_SLEEP_S} + 's)...')`,
        `Start-Sleep -Seconds ${WRAPPER_SLEEP_S}`,
        "$pkg = Join-Path $env:APPDATA 'npm\\node_modules\\@deepseek-ai\\dsh\\package.json'",
        "$cur = ''",
        "if (Test-Path $pkg) { try { $cur = (Get-Content $pkg -Raw | ConvertFrom-Json).version } catch {} }",
        "Log ('current global version: ' + $cur)",
        "if ($cur -eq $target -and $target -ne '') {",
        "  Log 'already at target version, skipping npm install'",
        "  $code = 0",
        "} else {",
        "  # 优先精确安装检测出的目标版本（GitHub tag 可能比 npm latest 新）；",
        "  # npm 尚未发布时精确安装会 ETARGET 失败，回退 @latest 至少拿到 npm 侧最新。",
        "  if ($target -ne '') {",
        "    Log ('attempting exact install: npm install -g @deepseek-ai/dsh@' + $target)",
        "    $exactArgs = @('/c','npm','install','-g',('@deepseek-ai/dsh@' + $target),'--loglevel','error')",
        "    $proc = Start-Process -FilePath 'cmd.exe' -ArgumentList $exactArgs -Wait -PassThru -NoNewWindow -RedirectStandardOutput $npmOut -RedirectStandardError $npmErr",
        "    $code = $proc.ExitCode",
        "    Log ('exact install exit code: ' + $code)",
        "  } else {",
        "    $code = 1",
        "  }",
        "  if ($code -ne 0) {",
        "    Log 'exact install not available on npm, falling back to @latest'",
        "    $latestArgs = @('/c','npm','install','-g','@deepseek-ai/dsh@latest','--loglevel','error')",
        "    $proc = Start-Process -FilePath 'cmd.exe' -ArgumentList $latestArgs -Wait -PassThru -NoNewWindow -RedirectStandardOutput $npmOut -RedirectStandardError $npmErr",
        "    $code = $proc.ExitCode",
        "    Log ('npm @latest exit code: ' + $code)",
        "  }",
        "}",
        "$ver = '?'",
        "if (Test-Path $pkg) { try { $ver = (Get-Content $pkg -Raw | ConvertFrom-Json).version } catch {} }",
        "Log ('installed version now: ' + $ver)",
        "if ($code -eq 0) { Log 'upgrade ok, relaunching...' } else { Log 'upgrade FAILED (code ' + $code + '), relaunching old version anyway' }",
        `Log ('relaunching: ' + $relaunch)`,
        'Start-Process -FilePath $relaunch -WorkingDirectory (Split-Path $relaunch)',
        "Log 'relaunch issued, wrapper done'",
      ].join('\r\n')
      const scriptFile = join(stateDir, 'upgrade.ps1')
      writeFileSync(scriptFile, ps, 'utf8')

      // 3) 脱离启动升级脚本（stdout/stderr 丢弃，日志走文件），宿主随后自行退出。
      //    实测 detached spawn 会随宿主进程退出被杀；`cmd /c start /b` 启动的
      //    进程与父进程树脱离、可独立存活（已验证可靠）。加 -WindowStyle Hidden
      //    使 PowerShell 完全无窗口（否则会弹一个空控制台，用户误以为卡死）。
      const child = spawn(
        'cmd.exe',
        ['/c', 'start', '', '/b', 'powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', scriptFile],
        { detached: true, stdio: 'ignore', windowsHide: true, cwd: stateDir },
      )
      child.unref()

      state.status = 'upgrading'
      state.upgradeStartedAt = Date.now()
      ctx.logger?.info?.('[' + name + '] 升级脚本已启动，服务即将自动重启')
      setTimeout(() => process.exit(0), EXIT_DELAY_MS)
      return {
        ok: true,
        message: state.npmReady
          ? `升级已启动：自动安装 @deepseek-ai/dsh@${state.latest} 并重启服务，约 ${Math.round((WRAPPER_SLEEP_S + 40) / 10) * 10} 秒内恢复`
          : `升级已启动：npm 暂未发布 ${state.latest}，将安装 npm 最新版并重启服务（约 ${Math.round((WRAPPER_SLEEP_S + 40) / 10) * 10} 秒内恢复）`,
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

            if (method === 'GET' && path === '/status') {
              return send(200, { ok: true, ...state })
            }
            if (method === 'POST' && path === '/check') {
              void runCheck()
              return send(200, { ok: true, status: state.status, hasUpdate: state.hasUpdate })
            }
            if (method === 'POST' && path === '/upgrade') {
              const result = startUpgrade()
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
    `[${name}] 已加载（installed=${state.installed}），5s 后首次检测官方 GitHub 版本`,
  )
}
