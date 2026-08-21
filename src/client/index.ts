/**
 * @dsh-external/dsh-updater — client 侧：侧栏设置按钮旁的「更新」按钮
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
          if (j.status === 'upgrading' || (j.upgradeStartedAt ?? 0) > 0) setUpgrading(true)
        } else {
          setErr('host 状态接口未就绪')
        }
      })
      .catch(() => setErr('状态接口请求失败'))
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
    // npm 尚未发布检测到的最新版：不提供误导性升级，仅提示官方发布进度
    if (st.hasUpdate && st.npmReady === false) {
      setErr(
        st.pendingVersion
          ? `官方已在 GitHub 发布 v${st.pendingVersion}，但 npm 尚未发布该版本，暂无法安装；npm 发布后将自动可升级（当前 npm 最新：v${st.npmLatest || '?'}）。点击重新检查以刷新状态。`
          : '最新版暂未在 npm 发布，暂无法安装；npm 发布后即可升级。',
      )
      void onCheck()
      return
    }
    const msg = st.latest
      ? `将把 DSH 从 v${st.installed || '?'} 升级到 v${st.latest}。\n升级过程会自动安装并重启服务（约 1 分钟内恢复），确定立即升级？`
      : '确定立即执行 DSH 升级（安装最新版并重启服务）？'
    if (!window.confirm(msg)) return
    setUpgrading(true)
    setErr('')
    fetch(`${API}/upgrade`, { method: 'POST' })
      .then((r) => r.json().catch(() => null))
      .then((j: { ok?: boolean; error?: string } | null) => {
        if (!j || !j.ok) {
          setUpgrading(false)
          setErr(j?.error || '升级启动失败')
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
    label = '正在升级…'
    cls = 'du-upgrading'
    spin = true
  } else if (checking) {
    label = '检查更新…'
    spin = true
  } else if (err && !st) {
    label = '更新检查失败'
    cls = 'du-error'
  } else if (st?.hasUpdate && st.npmReady === false) {
    // 官方已发布新版本，但 npm 尚未发布——如实提示，不提供假的「立即升级」
    label = st.pendingVersion ? `新版本 v${st.pendingVersion} 待 npm 发布` : '新版本待发布'
    cls = 'du-pending'
    ver = st.npmLatest ? `npm 最新 v${st.npmLatest}` : ''
  } else if (st?.hasUpdate) {
    label = '立即升级'
    ver = `v${st.latest}`
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
  const title = upgrading
    ? 'DSH 正在自动升级并重启服务，请稍候…'
    : st
      ? pendingBlock
        ? `官方已在 GitHub 发布 v${st.pendingVersion || st.latest}，但 npm 尚未发布该版本，暂无法安装。\n当前 npm 最新：v${st.npmLatest || '?'}；点击重新检查以刷新状态。`
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
      onClick: upgrading ? undefined : st?.hasUpdate && !checking && !pendingBlock ? onUpgrade : onCheck,
    },
    React.createElement(
      'span',
      { className: `du-ico${spin ? ' spin' : ''}` },
      React.createElement(ArrowIcon),
      dot ? React.createElement('span', { className: 'du-dot' }) : null,
    ),
    wide ? React.createElement('span', { className: 'du-label' }, label) : null,
    wide && ver ? React.createElement('span', { className: 'du-ver' }, ver) : null,
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
    '@dsh-external/dsh-updater: footer action',
  )
}
