/**
 * @wizzy-1547/dsh-updater — client 侧：侧栏设置按钮旁的「更新」按钮
 *
 * 注册到 sidebar.footer.action（列表槽，紧邻设置按钮）：
 * - 宽列：整行按钮（图标 + 文案），收窄为 rail 时只剩图标 + 角标圆点；
 * - 自动检测：挂载即触发一次检测，之后每 60s 拉取状态（宿主每 30 分钟自动检测），
 *   有新版本时按钮变蓝并显示「立即升级 vX.Y.Z」，点击确认后全自动升级并重启服务；
 * - 升级中：按钮置灰显示「正在升级…」，服务重启后页面自动恢复。
 *
 * ⚠️ 构建要点：client 由 tsdown 单独构建（lib/client.js，ModuleLoader.load 注册），
 * tsc 不编译本目录（tsconfig exclude）。component 必须作为 register 的第二个参数。
 */
import type { SlotsService } from '@deepseek-ai/dsh-client-ui-slots'
import * as React from 'react'

type ClientContext = {
  slots: SlotsService
  effect(fn: () => unknown, label?: string): void
}

export const inject = ['slots']

const API = '/dsh-updater/api'

interface StatusResp {
  ok: boolean
  status: 'idle' | 'checking' | 'upgrading'
  installed: string
  latest: string
  hasUpdate: boolean
  source: string
  /** GitHub 最新版是否已在 npm 发布（可安装） */
  npmReady?: boolean
  /** GitHub 已发布但 npm 尚未发布的版本（提示用） */
  pendingVersion?: string
  /** npm 当前实际可安装的最新版 */
  npmLatest?: string
  lastCheckAt: number
  upgradeStartedAt?: number
  error?: string
}

/** 升级期间由独立进度服务（127.0.0.1:38999）提供的实时进度 */
interface ProgressResp {
  ok: boolean
  stage?: string
  pct?: number
  message?: string
  detail?: string
  at?: number
}

/** 升级期间独立进度服务端口（与 host 端 PROGRESS_PORT 保持一致） */
const PROGRESS_API = 'http://127.0.0.1:38999'

// ── 样式 ───────────────────────────────────────────────────────────────
function ensureStyles(): void {
  if (document.querySelector('style[data-dsh-updater]')) return
  const css = `
.du-btn{all:unset;box-sizing:border-box;width:100%;height:32px;border-radius:8px;padding:0 10px;display:flex;align-items:center;gap:8px;font-size:13px;font-family:var(--dsw-font-family,-apple-system,'Segoe UI',sans-serif);color:var(--dsw-alias-label-secondary,#aab);cursor:pointer;white-space:nowrap;overflow:hidden}
.du-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.07))}
.du-btn:active{background:var(--dsw-alias-interactive-bg-active,rgba(255,255,255,.13))}
.du-btn:disabled{opacity:.55;cursor:default;background:transparent}
.du-btn.du-update{background:rgba(79,140,255,.13);border:1px solid rgba(79,140,255,.45);color:#7fb0ff}
.du-btn.du-update:hover{background:rgba(79,140,255,.2)}
.du-btn.du-pending{background:rgba(240,180,60,.1);border:1px solid rgba(240,180,60,.4);color:#e0b45a}
.du-btn.du-pending:hover{background:rgba(240,180,60,.16)}
.du-btn.du-error{color:var(--dsw-alias-state-error-primary,#ff6b6b)}
.du-btn.du-upgrading{opacity:.6}
.du-ico{flex:none;width:16px;height:16px;display:inline-flex;justify-content:center;align-items:center;position:relative}
.du-btn svg{display:block}
.du-ico.spin svg{animation:du-spin 1.1s linear infinite}
@keyframes du-spin{to{transform:rotate(360deg)}}
.du-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis}
.du-ver{flex:none;font-size:11px;font-variant-numeric:tabular-nums;opacity:.75}
.du-dot{position:absolute;top:-2px;right:-3px;width:8px;height:8px;border-radius:50%;background:#4f8cff;box-shadow:0 0 0 2px var(--dsw-alias-surface-2,#181a20);animation:du-pulse 2s ease-in-out infinite}
@keyframes du-pulse{0%,100%{opacity:1}50%{opacity:.45}}
.du-btn.du-rail{width:28px;height:28px;border-radius:50%;padding:0;justify-content:center}
.du-btn.du-rail .du-ico{width:18px;height:18px}
.du-btn.du-rail .du-ico svg{width:15px;height:15px}
.du-prog-wrap{position:relative;flex:1;min-width:0;height:18px;display:flex;align-items:center;overflow:hidden;border-radius:5px;background:rgba(255,255,255,.07)}
.du-prog-bar{position:absolute;left:0;top:0;bottom:0;background:linear-gradient(90deg,rgba(79,140,255,.55),rgba(79,140,255,.85));border-radius:5px;transition:width .5s ease}
.du-prog-txt{position:relative;z-index:1;flex:1;min-width:0;padding:0 6px;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:inherit}
.du-prog-pct{position:relative;z-index:1;flex:none;font-size:10px;font-variant-numeric:tabular-nums;opacity:.8;padding-right:4px}
.du-prog-wrap.du-prog-err .du-prog-bar{background:linear-gradient(90deg,rgba(255,107,107,.5),rgba(255,107,107,.8))}
.du-prog-wrap.du-prog-done .du-prog-bar{background:linear-gradient(90deg,rgba(70,190,120,.55),rgba(70,190,120,.85))}
.du-rail-prog{position:absolute;inset:0;border-radius:50%;background:conic-gradient(#4f8cff var(--du-p,0%),rgba(255,255,255,.1) 0);-webkit-mask:radial-gradient(circle,transparent 54%,#000 56%);mask:radial-gradient(circle,transparent 54%,#000 56%)}
`
  const style = document.createElement('style')
  style.setAttribute('data-dsh-updater', '')
  style.textContent = css
  document.head.appendChild(style)
}

// ── 图标（上箭头 = 升级） ─────────────────────────────────────────────
function ArrowIcon(): React.ReactElement {
  return React.createElement(
    'svg',
    { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' },
    React.createElement('path', { d: 'M8 12.5V3.5' }),
    React.createElement('path', { d: 'M4.5 7L8 3.5 11.5 7' }),
  )
}

// ── 更新按钮 ───────────────────────────────────────────────────────────
function UpdaterButton({ wide }: { wide: boolean }): React.ReactElement {
  const [st, setSt] = React.useState<StatusResp | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [upgrading, setUpgrading] = React.useState(false)
  const [err, setErr] = React.useState('')
  /** 升级期间的实时进度（宿主退出后由独立进度服务提供） */
  const [prog, setProg] = React.useState<ProgressResp | null>(null)

  React.useEffect(() => {
    ensureStyles()
  }, [])

  const load = React.useCallback((): void => {
    fetch(`${API}/status`)
      .then((r) => r.json().catch(() => null))
      .then((j: StatusResp | null) => {
        if (j && j.ok) {
          setSt(j)
          setErr('')
          if (j.status === 'upgrading' || (j.upgradeStartedAt ?? 0) > 0) {
            setUpgrading(true)
            // 宿主还在（升级刚启动或正在重启中），先清掉旧进度
            setProg((p) => (p && p.stage === 'done' ? p : p))
          }
        } else {
          // 宿主已退出（升级期间）或接口未就绪：交给进度轮询兜底
          if (!upgrading) setErr('host 状态接口未就绪')
        }
      })
      .catch(() => {
        if (upgrading) {
          // 宿主退出中——进度由独立进度服务提供，无需报错
        } else {
          setErr('状态接口请求失败')
        }
      })
  }, [upgrading])

  // 升级期间：持续轮询进度（宿主退出后走独立进度服务，恢复后走 /status）
  React.useEffect(() => {
    if (!upgrading) return
    let alive = true
    let hostDownStreak = 0
    const tick = (): void => {
      fetch(`${API}/status`)
        .then((r) => r.json().catch(() => null))
        .then((j: StatusResp | null) => {
          if (!alive) return
          if (j && j.ok) {
            hostDownStreak = 0
            setSt(j)
            if (j.status !== 'upgrading' && (j.upgradeStartedAt ?? 0) === 0) {
              setUpgrading(false)
              setProg(null)
              return
            }
          } else {
            hostDownStreak++
          }
        })
        .catch(() => {
          if (alive) hostDownStreak++
        })
      // 宿主连续 2 次不可达（已退出）→ 从独立进度服务取进度
      if (hostDownStreak >= 2) {
        fetch(`${PROGRESS_API}/progress`)
          .then((r) => r.json().catch(() => null))
          .then((j: ProgressResp | null) => {
            if (alive && j && j.ok) setProg(j)
          })
          .catch(() => {})
      }
    }
    tick()
    const iv = window.setInterval(tick, 1500)
    return () => {
      alive = false
      window.clearInterval(iv)
    }
  }, [upgrading])

  // 挂载时探测：是否有正在进行的升级（页面刷新/重开后 React 状态丢失，
  // 靠独立进度服务恢复 upgrading 态，进度条才能继续显示）。
  // 判据：progress-server 在线且进度新鲜（10 分钟内）且未到 done/error。
  React.useEffect(() => {
    let alive = true
    fetch(`${PROGRESS_API}/progress`)
      .then((r) => r.json().catch(() => null))
      .then((j: ProgressResp | null) => {
        if (!alive || !j || !j.ok) return
        const fresh = typeof j.at === 'number' && Date.now() - j.at < 10 * 60_000
        if (fresh && j.stage && j.stage !== 'done' && j.stage !== 'error') {
          setUpgrading(true)
          setProg(j)
        }
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  // 挂载：立即触发一次检测，并轮询到检测结束（最长 20s）
  React.useEffect(() => {
    fetch(`${API}/check`, { method: 'POST' }).catch(() => {})
    let alive = true
    const poll = (): void => {
      fetch(`${API}/status`)
        .then((r) => r.json().catch(() => null))
        .then((j: StatusResp | null) => {
          if (!alive) return
          if (j && j.ok) {
            setSt(j)
            setErr('')
            if (j.status === 'upgrading') {
              setUpgrading(true)
              window.clearInterval(iv)
            } else if (j.status !== 'checking') {
              window.clearInterval(iv)
            }
          }
        })
        .catch(() => {})
    }
    poll()
    const iv = window.setInterval(poll, 2000)
    const stop = window.setTimeout(() => window.clearInterval(iv), 20_000)
    return () => {
      alive = false
      window.clearInterval(iv)
      window.clearTimeout(stop)
    }
  }, [])

  // 60s 后台刷新状态（宿主自身每 30 分钟自动检测）
  React.useEffect(() => {
    const iv = window.setInterval(load, 60_000)
    return () => window.clearInterval(iv)
  }, [load])

  const onCheck = (): void => {
    if (busy || upgrading) return
    setBusy(true)
    fetch(`${API}/check`, { method: 'POST' })
      .catch(() => setErr('检测请求失败'))
      .finally(() => {
        window.setTimeout(() => {
          setBusy(false)
          load()
        }, 1200)
      })
  }

  const onUpgrade = (): void => {
    if (!st || upgrading) return
    // npm 尚未发布检测到的最新版：弹窗说明，给「等官方发布 / 从 GitHub 源码安装」两个选择
    if (st.hasUpdate && st.npmReady === false) {
      const v = st.pendingVersion || st.latest
      const first = window.confirm(
        `检测到官方发布了新版本 v${v}（测试版），但官方还没把它同步到「自动更新源」（npm），所以普通的一键升级暂时装不上。\n\n` +
          `你可以：\n` +
          `1. 等官方发布（推荐）：官方同步后（通常几小时~几天），按钮会自动变成可升级\n` +
          `2. 现在就装测试版：从 GitHub 官方源码直接构建安装（需要下载源码 + 编译，约 5-10 分钟，期间页面会断开，且测试版可能有未完成的功能）\n\n` +
          `要现在就从 GitHub 源码安装测试版 v${v} 吗？`,
      )
      if (!first) return
      const second = window.confirm(
        `请确认：即将从 GitHub 官方源码构建安装测试版 v${v}。\n\n` +
          `这个过程会：\n` +
          `• 下载官方源码（约 16MB）\n` +
          `• 安装依赖并编译（约 5-10 分钟）\n` +
          `• 替换当前的 DSH，然后自动重启\n\n` +
          `期间页面会断开，完成后自动恢复。测试版可能有未完成的功能或兼容问题，如果之后想换回稳定版，等官方发布正式版后再升级即可。\n\n` +
          `确定继续吗？`,
      )
      if (!second) return
      setUpgrading(true)
      setErr('')
      fetch(`${API}/token`)
        .then((r) => r.json().catch(() => null))
        .then((j: { token?: string } | null) => {
          const token = typeof j?.token === 'string' ? j.token : ''
          if (!token) {
            setUpgrading(false)
            setErr('未能获取升级令牌，请刷新页面后重试')
            return null
          }
          return fetch(`${API}/upgrade?source=github`, {
            method: 'POST',
            headers: { 'x-dsh-updater-token': token },
          }).then((r) => r.json().catch(() => null))
        })
        .then((j: { ok?: boolean; error?: string } | null) => {
          if (j && !j.ok) {
            setUpgrading(false)
            setErr(j.error || '升级启动失败')
          }
        })
        .catch(() => {
          // 宿主已退出/重启中：请求失败视为升级已在进行
        })
      return
    }
    const msg = st.latest
      ? `将把 DSH 从 v${st.installed || '?'} 升级到 v${st.npmLatest ?? st.latest}。\n升级过程会自动安装并重启服务（约 1 分钟内恢复），确定立即升级？`
      : '确定立即执行 DSH 升级（安装最新版并重启服务）？'
    if (!window.confirm(msg)) return
    setUpgrading(true)
    setErr('')
    // 安全两步走：先同源 GET 取内存 token，再带 X-Dsh-Updater-Token 头发起升级。
    // /token 响应无 CORS 头，跨站页面读不到 body，无法伪造带 token 的升级请求。
    fetch(`${API}/token`)
      .then((r) => r.json().catch(() => null))
      .then((j: { token?: string } | null) => {
        const token = typeof j?.token === 'string' ? j.token : ''
        if (!token) {
          setUpgrading(false)
          setErr('未能获取升级令牌，请刷新页面后重试')
          return null
        }
        return fetch(`${API}/upgrade`, {
          method: 'POST',
          headers: { 'x-dsh-updater-token': token },
        }).then((r) => r.json().catch(() => null))
      })
      .then((j: { ok?: boolean; error?: string } | null) => {
        // j 为空多半是宿主已开始退出、响应中断——视为升级已在进行
        if (j && !j.ok) {
          setUpgrading(false)
          setErr(j.error || '升级启动失败')
        }
      })
      .catch(() => {
        // 宿主已退出/重启中：请求失败视为升级已在进行
      })
  }

  const checking = busy || st?.status === 'checking'
  let label = '检查更新…'
  let ver = ''
  let cls = ''
  let dot = false
  let spin = false

  if (upgrading) {
    // 有实时进度时显示阶段文案；否则通用"正在升级…"
    const pmsg = prog?.message
    label = pmsg && pmsg !== '完成' ? pmsg : '正在升级…'
    cls = 'du-upgrading'
    spin = !prog || !prog.pct
  } else if (checking) {
    label = '检查更新…'
    spin = true
  } else if (err && !st) {
    label = '更新检查失败'
    cls = 'du-error'
  } else if (st?.hasUpdate && st.npmReady === false) {
    // 官方已发布新版本，但 npm 尚未发布——提示可「从 GitHub 源码安装」或等官方发布
    label = st.pendingVersion ? `新版本 v${st.pendingVersion} 可安装` : '新版本待发布'
    cls = 'du-pending'
    ver = st.npmLatest ? `npm 最新 v${st.npmLatest}` : ''
  } else if (st?.hasUpdate) {
    label = '立即升级'
    // 展示实际可安装目标：GitHub 最新版尚未进 npm 时以 npm 当前最新为准
    ver = `v${st.npmLatest ?? st.latest}`
    cls = 'du-update'
    dot = true
  } else if (st) {
    label = '已是最新'
    ver = `v${st.installed}`
  } else {
    label = '检查更新…'
    spin = true
  }

  const pendingBlock = st?.hasUpdate && st.npmReady === false
  const showProg = upgrading && prog && typeof prog.pct === 'number' && prog.pct >= 0
  const pctClamped = showProg ? Math.max(0, Math.min(100, prog.pct ?? 0)) : 0
  const progErr = prog?.stage === 'error'
  const progDone = prog?.stage === 'done'
  const title = upgrading
    ? prog?.message
      ? `DSH 升级进度：${prog.message}${prog?.detail ? `（${prog.detail}）` : ''}`
      : 'DSH 正在自动升级并重启服务，请稍候…'
    : st
      ? pendingBlock
        ? `官方已在 GitHub 发布 v${st.pendingVersion || st.latest}，但 npm 尚未发布该版本。\n可点击选择：等官方发布，或从 GitHub 源码构建安装测试版。\n当前 npm 最新：v${st.npmLatest || '?'}`
        : `DSH v${st.installed || '?'}${st.hasUpdate ? ` → 官方新版本 v${st.latest}（来源：${st.source === 'github' ? 'GitHub' : 'npm'}）` : ''}，点击可${
            st.hasUpdate ? '立即升级' : '重新检查'
          }${err ? `\n最近错误：${err}` : ''}`
      : 'DSH 自动更新'

  return React.createElement(
    'button',
    {
      className: `du-btn${wide ? '' : ' du-rail'} ${cls}`.trim(),
      title,
      disabled: upgrading,
      // pendingBlock 时点击进入弹窗（等官方发布 / GitHub 源码安装二选一）
      onClick: upgrading ? undefined : st?.hasUpdate && !checking ? onUpgrade : onCheck,
    },
    // 升级中且有实时进度：wide → 横向进度条；rail → 环形进度
    showProg
      ? wide
        ? React.createElement(
            'span',
            {
              className: `du-prog-wrap${progErr ? ' du-prog-err' : ''}${progDone ? ' du-prog-done' : ''}`,
            },
            React.createElement('span', { className: 'du-prog-bar', style: { width: pctClamped + '%' } }),
            React.createElement('span', { className: 'du-prog-txt' }, prog?.message || '正在升级…'),
            React.createElement('span', { className: 'du-prog-pct' }, `${Math.round(pctClamped)}%`),
          )
        : React.createElement(
            'span',
            { className: 'du-ico', style: { position: 'relative' } },
            React.createElement('span', { className: 'du-rail-prog', style: { '--du-p': pctClamped + '%' } as React.CSSProperties }),
            React.createElement(
              'span',
              { style: { position: 'relative', zIndex: 1, fontSize: 8, fontVariantNumeric: 'tabular-nums', color: 'inherit' } },
              `${Math.round(pctClamped)}%`,
            ),
          )
      : React.createElement(
          'span',
          { className: `du-ico${spin ? ' spin' : ''}` },
          React.createElement(ArrowIcon),
          dot ? React.createElement('span', { className: 'du-dot' }) : null,
        ),
    !showProg && wide ? React.createElement('span', { className: 'du-label' }, label) : null,
    wide && ver && !showProg ? React.createElement('span', { className: 'du-ver' }, ver) : null,
  )
}

export function apply(ctx: ClientContext): void {
  ctx.effect(
    () =>
      ctx.slots.inject('sidebar.footer.action', () =>
        // 注：register({ 必须同行书写——注入器骨架校验按 register({ 正则扫描合法 slot 名
        ctx.slots.register({ name: 'sidebar.footer.action', id: 'dsh-updater', order: 10 },
          // 必须把框架注入的 owner props（{ wide }）透传给组件，否则收不到侧栏宽窄状态
          (props: { wide: boolean }) => React.createElement(UpdaterButton, props),
        ),
      ),
    '@wizzy-1547/dsh-updater: footer action',
  )
}
