/**
 * dsh-bili-pond —— 浏览器半端（设置在「设置」里的一页）
 * ============================================================================
 * ⭐ **client bundle 不是 ESM，是自注册脚本**（2026-10-14 从官方包里挖到的约定）：
 *
 *     window.__ModuleLoader__.load({
 *       id: '<包名>',                       // 必须等于 package.json 的 name
 *       factory: (require) => { ... return { inject: [...], apply(ctx) {...} } },
 *     })
 *
 * ⭐ **怎么进「设置」**（抄第三方插件 `dsh-meme/client.js`）：
 *
 *     const slots = ctx.get('slots')
 *     slots.inject('settings.section', () => slots.register(
 *       { name: 'settings.section', id: 'bili-pond', order: 30, label: 'B站鱼塘' },
 *       () => h(Panel),
 *     ))
 *
 * 这一页要满足使用者 2026-10-14 说的形状：
 *   · **总开关 → 打开之后下面才展开子开关**（谷时运行 → 中午 / 夜间）
 *   · **数字项要能自己填**（每日选取上限）
 *   · **账号绑定必须在设置页里**（扫码登录 + 二维码直接显示在页里）
 *   · 会发东西出去的（发布评论）、要下大模型的（本地转写）**默认关**
 *
 * ⭐⭐ 2026-10-19 排版重做 v2（只动结构与样式，**没动任何 handler / 字段 / 请求**）：
 *   上一版的问题（使用者直接指出）：文案口语化、控件宽度靠内联硬压、select 假箭头。
 *   本版按「紧凑型设置页」规范重做：
 *   · **指标栏**：今日选取 / 运行环境 / 账号 / 版本，四格等宽，带分隔线
 *   · **分组卡片**：标题栏 + 底部分隔线，正文行「标签左、控件右」，行间细分隔线
 *   · **控件统一**：32px 高、6px 圆角、13px 字号；宽度由语义类决定（数值/短/中/满宽），
 *     **不用内联 style 压宽度**；select 用内联 SVG 箭头（不再是两个 gradient 拼的假三角）
 *   · **术语产品化**：运行计划 / 任务参数 / 发布与互动 / 检索与上下文 / 高级设置
 *   · 颜色全部走 DSH 主题 token（`--dsw-alias-*`），亮/暗自动跟随
 * ============================================================================
 */
window.__ModuleLoader__.load({
  id: 'dsh-bili-pond',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const API = '/api/bili-pond'
    /* ⚠️ 原来 jget/jpost 直接 .json()、从不看 res.ok ⇒ HTTP 500 的 {ok:false,error}
     *    会被调用方当成「已保存 / 成功」，绿色提示把故障盖掉。（2026-10-16 审查修） */
    const asJson = async (res) => {
      if (res.ok) return res.json()
      const why = res.status === 401 ? '（未登录 / 无权限）' : res.status === 403 ? '（被宿主拦截）' : ''
      throw new Error('HTTP ' + res.status + why)
    }
    const jget = async (p) => asJson(await fetch(API + p, { credentials: 'same-origin' }))
    const jpost = async (p, body) => asJson(await fetch(API + p, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    }))

    /* 只有一处箭头图标：内联 SVG（data URI），不依赖字体，也不再拿 gradient 拼三角 */
    const CHEVRON = "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%23888e96' stroke-width='1.5' fill='none' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E\")"

    const CSS = `
/* ══ 局部变量：全部映射到 DSH 主题 token，亮/暗自动跟随 ══════════════════ */
[data-bd-page], .pond {
  --bd-surface:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base,#1b1c1e));
  --bd-surface-2:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.08));
  --bd-input:var(--dsw-alias-bg-base,rgba(0,0,0,.18));
  --bd-line:var(--dsw-alias-border-l1,rgba(128,128,128,.20));
  --bd-line-2:var(--dsw-alias-border-l2,rgba(128,128,128,.34));
  --bd-fg:var(--dsw-alias-label-primary,inherit);
  --bd-fg-2:var(--dsw-alias-label-secondary,#c5c8cd);
  --bd-fg-3:var(--dsw-alias-label-tertiary,#8b8f96);
  --bd-accent:#2563eb;
  --bd-ok:var(--dsw-alias-state-success-primary,#22c55e);
  --bd-warn:var(--dsw-alias-state-warn-primary,#f59e0b);
  --bd-err:var(--dsw-alias-state-error-primary,#ef4444);
  --bd-hover:var(--dsw-alias-bg-overlay,rgba(128,128,128,.14));
}
[data-bd-page]{
  display:flex;flex-direction:column;gap:16px;
  max-width:720px;padding:2px 0 28px;
  max-height:calc(100vh - 140px);overflow-y:auto;overflow-x:hidden;padding-right:6px;
  color:var(--bd-fg);font-size:13px;line-height:20px;
  -webkit-font-smoothing:antialiased;
}
[data-bd-page] *{box-sizing:border-box;}

/* ══ 设置页自适应网格：按内容列宽度重排，不依赖整个窗口宽度 ══════════ */
[data-bd-page][data-bd-layout]{
  display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,440px),1fr));
  gap:16px;align-items:start;width:100%;max-width:none;
}
[data-bd-page][data-bd-layout] > [data-bd-metrics],
[data-bd-page][data-bd-layout] > [data-bd-toolbar],
[data-bd-page][data-bd-layout] > [data-bd-guide],
[data-bd-page][data-bd-layout] > [data-bd-msg],
[data-bd-page][data-bd-layout] > [data-bd-foot],
[data-bd-page][data-bd-layout] > [data-bd-wide]{grid-column:1 / -1;}
[data-bd-page][data-bd-layout] > [data-bd-divider]{display:none;}
[data-bd-page][data-bd-layout] > [data-bd-card]{min-width:0;}
/* 鱼塘大页里的设置用单列：卡片高度差很大，双列网格会为最高卡留出一整行空白。 */
[data-bd-page][data-bd-layout="embedded"]{grid-template-columns:minmax(0,1fr);}

/* ══ 指标栏 ═════════════════════════════════════════════════════════════ */
[data-bd-metrics]{
  display:grid;grid-template-columns:repeat(3,minmax(0,1fr));
  border:1px solid var(--bd-line);border-radius:10px;overflow:hidden;
  background:var(--bd-surface);
}
/* 点赞 / 收藏这类格数不定的小指标：有几格就铺几格，关掉的那项不留半行空格 */
[data-bd-metrics][data-bd-auto]{grid-template-columns:repeat(auto-fit,minmax(min(100%,200px),1fr));}
[data-bd-metric]{padding:11px 16px 12px;min-width:0;}
[data-bd-metric] + [data-bd-metric]{border-left:1px solid var(--bd-line);}
[data-bd-metric-label]{
  font-size:11px;font-weight:400;letter-spacing:.02em;color:var(--bd-fg-3);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
}
[data-bd-metric-value]{
  display:flex;align-items:center;gap:6px;margin-top:3px;
  font-size:15px;font-weight:600;line-height:22px;
  font-variant-numeric:tabular-nums;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
}
[data-bd-metric-value] i{width:6px;height:6px;border-radius:50%;background:var(--bd-fg-3);flex:none;display:block;}
[data-bd-metric][data-tone="ok"] [data-bd-metric-value] i{background:var(--bd-ok);}
[data-bd-metric][data-tone="warn"] [data-bd-metric-value] i{background:var(--bd-warn);}
[data-bd-metric][data-tone="err"] [data-bd-metric-value] i{background:var(--bd-err);}
[data-bd-metric-value] span{overflow:hidden;text-overflow:ellipsis;}

/* ══ 工具栏（主操作） ═══════════════════════════════════════════════════ */
[data-bd-toolbar]{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
[data-bd-toolbar-spacer]{flex:1;min-width:0;}
[data-bd-toolbar] [data-bd-hint]{font-size:12px;color:var(--bd-fg-3);}

/* ══ 分组卡片 ═══════════════════════════════════════════════════════════ */
[data-bd-card]{
  border:1px solid var(--bd-line);border-radius:10px;
  background:var(--bd-surface);overflow:hidden;
}
[data-bd-card-head]{
  display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;
  padding:11px 16px;border-bottom:1px solid var(--bd-line);
  background:var(--bd-surface-2);
}
[data-bd-card-title]{font-size:13px;font-weight:600;line-height:20px;}
[data-bd-card-desc]{font-size:12px;line-height:18px;color:var(--bd-fg-3);}
[data-bd-card-body]{padding:2px 16px 8px;}

/* ══ 行：标签左 / 控件右 ═════════════════════════════════════════════════ */
[data-bd-row]{
  display:flex;align-items:center;flex-wrap:wrap;gap:20px 16px;
  padding:10px 0;min-height:44px;
}
[data-bd-row] + [data-bd-row]{border-top:1px solid var(--bd-line);}
[data-bd-row-main]{flex:1 1 220px;min-width:0;}
[data-bd-row-label]{font-size:13px;font-weight:500;line-height:19px;color:var(--bd-fg);}
[data-bd-row-desc]{font-size:12px;line-height:18px;color:var(--bd-fg-3);margin-top:2px;}
[data-bd-row-ctl]{flex:0 1 auto;display:flex;align-items:center;justify-content:flex-end;flex-wrap:wrap;gap:8px;max-width:100%;margin-left:auto;}
[data-bd-row-ctl] > *{max-width:100%;}
[data-bd-row][data-bd-stack]{flex-direction:column;align-items:stretch;gap:8px;}
/* ⚠️ 纵向堆叠时 flex-basis 变成**高度**：上一条 base 规则的 flex:1 1 220px 会让标签块
 *    先占 220px 高（grow 还会再撑），输入框被顶到行底部 —— 2026-10-25 实测截图就是这个大空隙。
 *    ⇒ 堆叠行里两个子块都改成「按内容高度」，不参与伸缩。 */
[data-bd-row][data-bd-stack] > [data-bd-row-main]{flex:0 0 auto;}
/* ⚠️ 堆叠行的控件区改成整宽左对齐：base 那条 justify-content:flex-end 会让
 *    「输入框 + 按钮」这一组被推到右边、还在窄处挤成两行（工作区路径就是这样，2026-10-25 实测）。
 *    ⇒ 整宽、左起、不换行；输入框自己 flex:1 吃掉剩余宽度，「建模板」贴在它右边。 */
[data-bd-row][data-bd-stack] > [data-bd-row-ctl]{flex:0 0 auto;width:100%;justify-content:flex-start;}
[data-bd-row][data-bd-stack] [data-bd-row-ctl]{width:100%;}
[data-bd-row][data-bd-stack] [data-bd-inline]{width:100%;justify-content:flex-start;flex-wrap:nowrap;}

/* 级联子项：左侧竖线内缩 */
[data-bd-sub]{padding-left:14px;border-left:2px solid var(--bd-line-2);margin:2px 0 6px;}
[data-bd-sub] [data-bd-row]:first-child{border-top:0;}

/* 分组分隔线（高级设置内部用） */
[data-bd-divider]{height:1px;background:var(--bd-line);margin:6px 0;}

/* ══ 控件：统一 32px 高 / 6px 圆角 / 13px 字号 ═══════════════════════════ */
[data-bd-input],[data-bd-select],[data-bd-textarea]{
  font-family:inherit;font-size:13px;color:var(--bd-fg);
  background:var(--bd-input);
  border:1px solid var(--bd-line-2);
  border-radius:6px;
  transition:border-color .12s ease;
}
[data-bd-input],[data-bd-select]{height:32px;padding:0 10px;}
[data-bd-textarea]{
  padding:7px 10px;line-height:19px;resize:vertical;min-height:80px;
  width:100%;display:block;
}
[data-bd-input]:hover,[data-bd-select]:hover,[data-bd-textarea]:hover{border-color:var(--bd-fg-3);}
[data-bd-input]:focus,[data-bd-select]:focus,[data-bd-textarea]:focus{
  outline:none;border-color:var(--bd-accent);
  box-shadow:0 0 0 1px var(--bd-accent);
}
[data-bd-input]::placeholder,[data-bd-textarea]::placeholder{color:var(--bd-fg-3);opacity:1;}

/* select：原生外观关掉，换成内联 SVG 箭头 */
[data-bd-select]{
  appearance:none;-webkit-appearance:none;-moz-appearance:none;
  padding-right:28px;cursor:pointer;
  background-image:${CHEVRON};
  background-repeat:no-repeat;
  background-position:right 10px center;
}
[data-bd-select] option{background:var(--bd-surface);color:var(--bd-fg);}

/* 宽度由语义决定 —— 不再用内联 style 压 */
[data-bd-w-num]{width:76px;text-align:right;font-variant-numeric:tabular-nums;padding-right:10px;}
[data-bd-w-num]::-webkit-outer-spin-button,
[data-bd-w-num]::-webkit-inner-spin-button{-webkit-appearance:none;margin:0;}
[data-bd-w-num]{-moz-appearance:textfield;}
[data-bd-w-sm]{width:150px;}
[data-bd-w-md]{width:230px;}
[data-bd-w-full]{width:100%;}
[data-bd-inline]{display:flex;align-items:center;justify-content:flex-end;flex-wrap:wrap;gap:8px;max-width:100%;}
[data-bd-inline] [data-bd-w-full]{flex:1 1 240px;width:auto;min-width:0;}
[data-bd-inline-sep]{flex:none;color:var(--bd-fg-3);}

/* ══ 开关 ═══════════════════════════════════════════════════════════════ */
[data-bd-sw]{
  position:relative;flex:none;width:36px;height:20px;border-radius:10px;
  border:1px solid transparent;padding:0;cursor:pointer;
  background:var(--bd-line-2);transition:background .15s ease;
}
[data-bd-sw] i{
  position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;
  background:#fff;display:block;transition:left .15s ease;
  box-shadow:0 1px 2px rgba(0,0,0,.28);
}
[data-bd-sw][data-on]{background:var(--bd-accent);}
[data-bd-sw][data-on] i{left:18px;}
[data-bd-sw]:focus-visible{outline:2px solid var(--bd-accent);outline-offset:2px;}
[data-bd-sw][disabled]{opacity:.45;cursor:not-allowed;}

/* ══ 按钮 ═══════════════════════════════════════════════════════════════ */
[data-bd-btn]{
  display:inline-flex;align-items:center;justify-content:center;gap:6px;
  height:32px;padding:0 12px;flex:none;
  font-family:inherit;font-size:13px;font-weight:500;line-height:1;
  color:var(--bd-fg);white-space:nowrap;cursor:pointer;
  background:transparent;border:1px solid var(--bd-line-2);border-radius:6px;
  transition:background .12s ease,border-color .12s ease;
}
[data-bd-btn]:hover{background:var(--bd-hover);border-color:var(--bd-fg-3);box-shadow:0 0 0 2px rgba(37,99,235,.30),0 0 14px rgba(37,99,235,.36);}
[data-bd-btn]:active{box-shadow:0 0 0 3px rgba(37,99,235,.46),0 0 20px rgba(37,99,235,.50);}
[data-bd-btn]:focus-visible{outline:2px solid var(--bd-accent);outline-offset:1px;}
[data-bd-btn][data-primary]{
  background:var(--bd-accent);border-color:var(--bd-accent);color:#fff;
}
[data-bd-btn][data-primary]:hover{background:var(--bd-accent);opacity:.9;}
[data-bd-btn][disabled]{opacity:.45;cursor:not-allowed;}
[data-bd-btn][disabled]:hover{background:transparent;border-color:var(--bd-line-2);}
[data-bd-btn][data-primary][disabled]:hover{background:var(--bd-accent);}
[data-bd-btns]{display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:6px 0 10px;}

/* ══ 提示条 ═════════════════════════════════════════════════════════════ */
[data-bd-msg]{
  font-size:12px;line-height:18px;padding:8px 12px;border-radius:8px;
  background:var(--bd-surface-2);color:var(--bd-fg-2);
  border-left:3px solid var(--bd-line-2);
  word-break:break-word;
}
[data-bd-msg][data-good]{border-left-color:var(--bd-ok);}
[data-bd-msg][data-warn]{border-left-color:var(--bd-warn);}
[data-bd-msg][data-err]{border-left-color:var(--bd-err);}
[data-bd-msg][data-bd-msg-flex]{flex:1 1 220px;}
[data-bd-msg][data-bd-msg-gap]{margin-bottom:10px;}

/* ══ 初始配置引导 ═══════════════════════════════════════════════════════ */
[data-bd-guide]{
  display:flex;align-items:center;gap:16px;flex-wrap:wrap;
  padding:12px 16px;border-radius:10px;
  border:1px solid var(--bd-accent);
  background:var(--bd-surface-2);
}
[data-bd-guide-txt]{flex:1;min-width:220px;font-size:12.5px;line-height:19px;color:var(--bd-fg-2);}
[data-bd-guide-txt] [data-bd-guide-title]{
  display:block;font-size:13px;font-weight:600;color:var(--bd-fg);margin-bottom:2px;
}

/* ══ 二维码 ═════════════════════════════════════════════════════════════ */
[data-bd-qr]{display:flex;gap:16px;align-items:flex-start;padding:10px 0;flex-wrap:wrap;}
[data-bd-qr] img{
  width:148px;height:148px;flex:none;padding:6px;
  background:#fff;border:1px solid var(--bd-line);border-radius:8px;
}
[data-bd-qr-note]{flex:1;min-width:180px;font-size:12px;line-height:19px;color:var(--bd-fg-3);}

/* ══ Markdown 报告排版（2026-10-20） ═══════════════════════════════════════
 * 报告是给人读的成品，按 markdown 渲染；行高和间距照阅读体验调。 */
[data-bd-md]{font-size:13px;line-height:1.75;color:var(--bd-fg-2);max-height:420px;overflow:auto;}
[data-bd-md] [data-bd-md-h]{margin:16px 0 8px;font-weight:600;color:var(--bd-fg);line-height:1.4;}
[data-bd-md] [data-bd-md-h="1"]{font-size:16px;}
[data-bd-md] [data-bd-md-h="2"]{font-size:15px;}
[data-bd-md] [data-bd-md-h="3"]{font-size:14px;padding-bottom:6px;border-bottom:1px solid var(--bd-line);}
[data-bd-md] [data-bd-md-h="4"]{font-size:13px;}
[data-bd-md] [data-bd-md-h="5"],[data-bd-md] [data-bd-md-h="6"]{font-size:13px;color:var(--bd-fg-3);}
[data-bd-md] [data-bd-md-p]{margin:8px 0;}
[data-bd-md] [data-bd-md-ul],[data-bd-md] [data-bd-md-ol]{margin:8px 0;padding-left:20px;}
[data-bd-md] li{margin:3px 0;}
[data-bd-md] a[data-bd-md-link]{color:var(--dsw-alias-link,#3b82f6);text-decoration:none;}
[data-bd-md] a[data-bd-md-link]:hover{text-decoration:underline;}
[data-bd-md] code[data-bd-md-code]{
  padding:1px 5px;border-radius:4px;font-family:ui-monospace,Menlo,Consolas,monospace;
  font-size:12px;background:var(--bd-input);border:1px solid var(--bd-line);}
[data-bd-md] [data-bd-md-pre]{
  margin:10px 0;padding:10px 12px;border-radius:8px;font-size:12px;line-height:1.6;
  font-family:ui-monospace,Menlo,Consolas,monospace;white-space:pre-wrap;word-break:break-word;
  background:var(--bd-input);border:1px solid var(--bd-line);overflow:auto;}
[data-bd-md] [data-bd-md-quote]{
  margin:10px 0;padding:6px 12px;border-left:3px solid var(--bd-line);
  color:var(--bd-fg-3);background:var(--bd-input);border-radius:0 6px 6px 0;}
[data-bd-md] [data-bd-md-table]{width:100%;border-collapse:collapse;margin:10px 0;font-size:12px;}
[data-bd-md] [data-bd-md-table] th,[data-bd-md] [data-bd-md-table] td{
  padding:6px 10px;border:1px solid var(--bd-line);text-align:left;}
[data-bd-md] [data-bd-md-table] th{background:var(--bd-input);font-weight:600;}
[data-bd-md] [data-bd-md-hr]{margin:16px 0;border:0;border-top:1px solid var(--bd-line);}
[data-bd-md] strong{font-weight:600;color:var(--bd-fg);}

/* ══ 可折叠日志 ═══════════════════════════════════════════════════════════ */
[data-bd-logfold]{margin:8px 0;}
[data-bd-logfold-head]{
  display:flex;align-items:center;gap:8px;width:100%;padding:7px 10px;
  border:1px solid var(--bd-line);border-radius:6px;background:var(--bd-input);
  font-size:12px;color:var(--bd-fg-2);cursor:pointer;text-align:left;
  font-family:inherit;transition:background .12s;}
[data-bd-logfold-head]:hover{background:var(--bd-surface-2);}
[data-bd-logfold-caret]{flex:none;font-size:10px;color:var(--bd-fg-3);width:10px;}
[data-bd-logfold-label]{flex:none;font-weight:500;}
[data-bd-logfold-desc]{flex:1;min-width:0;color:var(--bd-fg-3);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
[data-bd-logfold-hint]{flex:none;margin-left:auto;color:var(--bd-fg-3);font-size:11px;}

/* ══ 预格式块（日志 / 报告） ══════════════════════════════════════════════ */
[data-bd-pre]{
  margin:4px 0 10px;padding:10px 12px;border-radius:8px;
  font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  font-size:11px;line-height:17px;
  white-space:pre-wrap;word-break:break-word;
  max-height:220px;overflow:auto;
  background:var(--bd-input);color:var(--bd-fg-2);
  border:1px solid var(--bd-line);
}
[data-bd-kv]{
  font-size:12px;line-height:20px;color:var(--bd-fg-3);
  word-break:break-all;
  padding:8px 0;
}
[data-bd-kv] b{font-weight:500;color:var(--bd-fg-2);}

/* ══ 折叠区 ═════════════════════════════════════════════════════════════ */
[data-bd-fold]{
  display:flex;align-items:center;gap:8px;width:100%;
  padding:11px 16px;margin:0;
  font-family:inherit;font-size:13px;font-weight:600;line-height:20px;
  color:var(--bd-fg);text-align:left;cursor:pointer;
  background:var(--bd-surface-2);border:0;border-bottom:1px solid transparent;
  transition:background .12s ease;
}
[data-bd-fold]:hover{background:var(--bd-hover);}
[data-bd-fold][data-open]{border-bottom-color:var(--bd-line);}
[data-bd-fold] [data-bd-chev]{
  flex:none;width:10px;height:10px;color:var(--bd-fg-3);
  transition:transform .15s ease;
}
[data-bd-fold][data-open] [data-bd-chev]{transform:rotate(90deg);}
[data-bd-fold] [data-bd-fold-extra]{
  font-size:12px;font-weight:400;color:var(--bd-fg-3);
}

/* ══ 加载骨架 ═══════════════════════════════════════════════════════════ */
[data-bd-skeleton]{display:flex;flex-direction:column;gap:10px;}
[data-bd-skeleton] div{height:56px;border-radius:10px;background:var(--bd-surface-2);}
[data-bd-skeleton] div[data-bd-sk-narrow]{height:20px;width:40%;}

/* ══ 页脚：作者 ═════════════════════════════════════════════════════════ */
[data-bd-foot]{
  display:flex;align-items:center;flex-wrap:wrap;gap:2px;
  padding-top:2px;
  font-size:12px;line-height:18px;color:var(--bd-fg-3);
}
[data-bd-foot] a{
  display:inline-flex;align-items:center;
  color:var(--bd-fg-2);text-decoration:none;border-radius:4px;
  transition:color .12s ease;
}
[data-bd-foot] a:hover{color:var(--bd-accent);text-decoration:underline;}
[data-bd-foot] [data-bd-foot-sep]{color:var(--bd-line-2);padding:0 6px;}

/* ══ 紧凑排版（2026-10-25）═════════════════════════════════════════════
 * 设置页原来一行占 ~60px：标签 19 + 说明独占一行 18 + 上下 padding 20。
 * 卡片从横向省不出来，只能从「行内」省：
 *   ① 短说明并到标签同一行（[data-bd-row-hint]），只有真需要解释的说明才留第二行；
 *   ② 相邻的同一类小项两列并排（[data-bd-pair]，如「每轮 / 每天」）；
 *   ③ 行内 padding 10 → 6，卡头 11 → 9。
 * ⚠️ 只调间距与排布，不改任何字段语义；窄屏（<620px）自动退回单列。
 * ─────────────────────────────────────────────────────────────────── */
[data-bd-row]{padding:6px 0;min-height:38px;gap:14px 12px;}
[data-bd-row-hint]{margin-left:8px;font-size:12px;font-weight:400;color:var(--bd-fg-3);}
[data-bd-row][data-bd-stack]{padding:8px 0;}

/* 两列并排：整行自己画分隔线，里面两行不画（否则会多出一条横线） */
[data-bd-pair]{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:0 22px;}
[data-bd-pair] > [data-bd-row]{border-top:0;}
[data-bd-row] + [data-bd-pair],
[data-bd-pair] + [data-bd-row]{border-top:1px solid var(--bd-line);}
[data-bd-sub] > [data-bd-pair]:first-child,
[data-bd-card-body] > [data-bd-pair]:first-child{border-top:0;}

[data-bd-card-body]{padding:4px 16px 6px;}
[data-bd-card-head]{padding:9px 16px;}

/* 指标栏：有几格铺几格（今天 / 环境 / 状态 / 点赞 / 收藏 一行放得下） */
[data-bd-metrics]{grid-template-columns:repeat(auto-fit,minmax(min(100%,112px),1fr));}
[data-bd-metric]{padding:9px 14px 10px;}

/* 中号控件不再写死 230px：按内容宽度走，免得选项文字被截断成「普通评论 —— 在选中的…」 */
[data-bd-w-md]{width:auto;min-width:170px;max-width:100%;}

@media (max-width:620px){
  [data-bd-pair]{grid-template-columns:minmax(0,1fr);gap:0;}
}

/* ══ 窄屏 ═══════════════════════════════════════════════════════════════ */
@media (max-width:560px){
  [data-bd-metrics]{grid-template-columns:1fr 1fr;}
  [data-bd-metric]:nth-child(3){border-left:0;}
  [data-bd-metric]:nth-child(n+3){border-top:1px solid var(--bd-line);}
  [data-bd-row]{align-items:flex-start;gap:8px 12px;}
  [data-bd-row-main]{flex-basis:100%;}
  [data-bd-row-ctl]{width:100%;justify-content:flex-start;margin-left:0;}
  [data-bd-inline]{justify-content:flex-start;}
  [data-bd-card-body]{padding-left:14px;padding-right:14px;}
  [data-bd-card-head]{padding-left:14px;padding-right:14px;}
  [data-bd-w-sm],[data-bd-w-md]{width:100%;}
  [data-bd-btns] [data-bd-btn]{flex:1 1 auto;}
}
`

    // ⚠️ 与 lib/state.mjs 的 WINDOWS 保持一致（官方口径：工作日 9–12、14–18 是高峰，其余都是谷时）
    const DEFAULT_WINDOWS = {
      noon: { label: '中午时段', start: '12:00', end: '14:00' },
      night: { label: '夜间时段', start: '18:00', end: '09:00' },
    }

    /* ────────────── 小组件 ────────────── */

    /** 折叠箭头：一个 10×10 的内联 SVG，比字符 ▶ 对齐更稳 */
    function Chevron() {
      return h('svg', {
        'data-bd-chev': '', viewBox: '0 0 10 10', width: 10, height: 10,
        fill: 'none', stroke: 'currentColor', 'stroke-width': 1.6,
        'stroke-linecap': 'round', 'stroke-linejoin': 'round',
      }, h('path', { d: 'M3.5 1.5L7 5l-3.5 3.5' }))
    }

    function Switch({ on, onChange, disabled }) {
      return h('button', {
        'data-bd-sw': '',
        'data-on': on ? '' : undefined,
        disabled: Boolean(disabled),
        role: 'switch',
        'aria-checked': on ? 'true' : 'false',
        title: on ? '已开启' : '已关闭',
        onClick: () => { if (!disabled) onChange(!on) },
      }, h('i'))
    }

    /**
     * 标签区：`hint` 并到标签同一行（灰、12px），`desc` 才是独占第二行的那句。
     * ⭐ 2026-10-25：设置页一行原来固定 ~60px 高，一半是「说明独占一行」撑出来的。
     *    短说明（「0 = 不限」「硬顶 10」这种）改走 hint，行高落到 ~38px。
     */
    function rowLabel(label, hint, desc) {
      return h('div', { 'data-bd-row-main': '' },
        h('div', { 'data-bd-row-label': '' },
          label,
          hint ? h('span', { 'data-bd-row-hint': '' }, ` · ${hint}`) : null),
        desc ? h('div', { 'data-bd-row-desc': '' }, desc) : null)
    }

    /** 一行：左标签/说明，右控件 */
    function Row({ label, desc, hint, children }) {
      return h('div', { 'data-bd-row': '' },
        rowLabel(label, hint, desc),
        children ? h('div', { 'data-bd-row-ctl': '' }, children) : null)
    }

    /** 一行：开关型 */
    function SwitchRow({ label, desc, hint, on, onChange, disabled }) {
      return h(Row, { label, desc, hint },
        h(Switch, { on, onChange, disabled }))
    }

    /** 一行：长控件占满（textarea / 日志等） */
    function StackRow({ label, desc, hint, children }) {
      return h('div', { 'data-bd-row': '', 'data-bd-stack': '' },
        (label || hint || desc) ? rowLabel(label, hint, desc) : null,
        h('div', { 'data-bd-row-ctl': '' }, children))
    }

    /** 两列并排：把「每轮 X / 每天 Y」这种成对的短行合成一行 */
    function Pair({ children }) {
      return h('div', { 'data-bd-pair': '' }, children)
    }

    /** 分组分隔线（高级设置里把几组分开用，不是空 div 拼的） */
    function Divider() {
      return h('div', { 'data-bd-divider': '', role: 'separator' })
    }

    /** 分组卡片：标题栏 + 正文 */
    function Card({ title, desc, children, wide }) {
      return h('div', { 'data-bd-card': '', 'data-bd-wide': wide ? '' : undefined },
        (title || desc) ? h('div', { 'data-bd-card-head': '' },
          title ? h('div', { 'data-bd-card-title': '' }, title) : null,
          desc ? h('div', { 'data-bd-card-desc': '' }, desc) : null) : null,
        h('div', { 'data-bd-card-body': '' }, children))
    }

    /**
     * ⭐ 可折叠日志块（2026-10-20）
     *    安装日志 / 转写日志都是原始终端输出，默认收起来 —— 平时不看，出问题才展开。
     *    保持 <pre> 原样显示（不做 markdown 渲染：日志里的 * | # 会被误解析）。
     */
    function LogFold({ label, desc, text, open, onToggle }) {
      if (!text) return null
      return h('div', { 'data-bd-logfold': '' },
        h('button', {
          'data-bd-logfold-head': '', 'data-open': open ? '' : undefined,
          onClick: onToggle,
        },
          h('span', { 'data-bd-logfold-caret': '' }, open ? '▾' : '▸'),
          h('span', { 'data-bd-logfold-label': '' }, label),
          desc ? h('span', { 'data-bd-logfold-desc': '' }, desc) : null,
          h('span', { 'data-bd-logfold-hint': '' }, open ? '收起' : '展开')),
        open ? h('pre', { 'data-bd-pre': '' }, text) : null)
    }

    /** 指标格 */
    function Metric({ label, value, tone }) {
      return h('div', { 'data-bd-metric': '', 'data-tone': tone || undefined },
        h('div', { 'data-bd-metric-label': '' }, label),
        h('div', { 'data-bd-metric-value': '' }, h('i'), h('span', null, value)))
    }

    function useStatus(intervalMs) {
      const [st, setSt] = React.useState(null)
      React.useEffect(() => {
        let alive = true
        const tick = async () => {
          try {
            const d = await jget('/status')
            if (alive && d?.ok) setSt(d)
          } catch { /* 网络抖动就下次再问 */ }
        }
        tick()
        const t = setInterval(tick, intervalMs || 5000)
        return () => { alive = false; clearInterval(t) }
      }, [intervalMs])
      return [st, setSt]
    }

    /* ══ 极简 markdown 渲染（2026-10-20） ═════════════════════════════════════
     * 为什么自己写而不引依赖：插件是单个 client.js，不能装 npm 包。
     * 覆盖报告实际用到的语法就够了：标题 / 粗体 / 行内代码 / 链接 / 列表 / 引用 / 代码块 / 表格。
     * ⚠️ 不做 HTML 注入 —— 全部走 React 元素，用户/模型写的内容不会被当 HTML 执行。
     * ═══════════════════════════════════════════════════════════════════════ */

    const MD_FENCE = String.fromCharCode(96, 96, 96)   // ```
    const MD_TICK = String.fromCharCode(96)            // `

    /**
     * 行内：**粗体** `代码` [文本](url)
     *
     * ⚠️ 2026-10-20 修：原来三条规则各写一个「贪婪前缀」(.*?) 的正则，谁先匹配上谁让步，
     *    结果一行里有 **粗体** 又有 [链接] 时，粗体的 (.*?) 会把整段吞掉，
     *    后面的 [链接] 就被当成普通文字了（真实报告里每行都是这种结构）。
     *    改成**一次扫描找最靠前的那个标记**，就近解析 —— 不会互相吞。
     */
    const renderInline = (text, keyPrefix) => {
      const nodes = []
      const src = String(text)
      let pos = 0
      let k = 0
      const pushText = (t) => { if (t) nodes.push(t) }

      while (pos < src.length) {
        // 从当前位置往后找：粗体 / 行内代码 / 链接，取**最靠前**的那个
        const rest = src.slice(pos)
        const cand = []
        let m

        m = rest.match(/\*\*([^*]+)\*\*/)
        if (m) cand.push({ at: m.index, len: m[0].length, kind: 'strong', m })
        m = rest.match(/`([^`]+)`/)
        if (m) cand.push({ at: m.index, len: m[0].length, kind: 'code', m })
        m = rest.match(/\[([^\]]+)\]\(([^)]+)\)/)
        if (m) cand.push({ at: m.index, len: m[0].length, kind: 'link', m })

        if (!cand.length) { pushText(rest); break }
        cand.sort((a, b) => a.at - b.at)
        const best = cand[0]

        pushText(rest.slice(0, best.at))
        if (best.kind === 'strong') {
          nodes.push(h('strong', { key: keyPrefix + 'b' + (k++) }, best.m[1]))
        } else if (best.kind === 'code') {
          nodes.push(h('code', { key: keyPrefix + 'c' + (k++), 'data-bd-md-code': '' }, best.m[1]))
        } else {
          nodes.push(h('a', {
            key: keyPrefix + 'a' + (k++), href: best.m[2], target: '_blank', rel: 'noreferrer',
            'data-bd-md-link': '',
          }, best.m[1]))
        }
        pos += best.at + best.len
      }
      return nodes
    }

    /**
     * 把 markdown 文本转成 React 元素数组。
     * 支持：### 标题 / 段落 / - 列表 / > 引用 / 代码块 / | 表格 |
     */
    const renderMarkdown = (text) => {
      const lines = String(text || '').split(/\r?\n/)
      const out = []
      let i = 0
      let key = 0
      const k = () => 'md' + (key++)

      while (i < lines.length) {
        const line = lines[i]

        // 代码块
        if (line.startsWith(MD_FENCE)) {
          const buf = []
          i++
          while (i < lines.length && !lines[i].startsWith(MD_FENCE)) { buf.push(lines[i]); i++ }
          i++
          out.push(h('pre', { key: k(), 'data-bd-md-pre': '' }, buf.join('\n')))
          continue
        }

        // 标题
        const hm = line.match(/^(#{1,6})\s+(.*)$/)
        if (hm) {
          const level = hm[1].length
          const tag = level <= 2 ? 'h3' : level === 3 ? 'h4' : 'h5'
          out.push(h(tag, { key: k(), 'data-bd-md-h': String(level) }, ...renderInline(hm[2], k())))
          i++
          continue
        }

        // 表格
        if (/^\s*\|/.test(line)) {
          const rows = []
          while (i < lines.length && /^\s*\|/.test(lines[i])) { rows.push(lines[i]); i++ }
          const parseRow = (r) => r.replace(/^\s*\||\|\s*$/g, '').split('|').map((c) => c.trim())
          const header = parseRow(rows[0])
          const bodyRows = rows.slice(1).filter((r) => !/^[\s|:-]+$/.test(r)).map(parseRow)
          out.push(h('table', { key: k(), 'data-bd-md-table': '' },
            h('thead', null, h('tr', null, ...header.map((c, ci) => h('th', { key: ci }, ...renderInline(c, 'th' + ci))))),
            h('tbody', null, ...bodyRows.map((cells, ri) => h('tr', { key: ri },
              ...cells.map((c, ci) => h('td', { key: ci }, ...renderInline(c, 'td' + ri + ci))))))))
          continue
        }

        // 引用
        if (/^>\s?/.test(line)) {
          const buf = []
          while (i < lines.length && /^>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^>\s?/, '')); i++ }
          out.push(h('blockquote', { key: k(), 'data-bd-md-quote': '' }, ...renderInline(buf.join(' '), k())))
          continue
        }

        // 无序列表
        if (/^\s*[-*+]\s+/.test(line)) {
          const items = []
          while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
            items.push(lines[i].replace(/^\s*[-*+]\s+/, ''))
            i++
          }
          out.push(h('ul', { key: k(), 'data-bd-md-ul': '' },
            ...items.map((it, ii) => h('li', { key: ii }, ...renderInline(it, 'li' + ii)))))
          continue
        }

        // 有序列表
        if (/^\s*\d+\.\s+/.test(line)) {
          const items = []
          while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
            items.push(lines[i].replace(/^\s*\d+\.\s+/, ''))
            i++
          }
          out.push(h('ol', { key: k(), 'data-bd-md-ol': '' },
            ...items.map((it, ii) => h('li', { key: ii }, ...renderInline(it, 'li' + ii)))))
          continue
        }

        // 水平线
        if (/^\s*(---|\*\*\*)\s*$/.test(line)) {
          out.push(h('hr', { key: k(), 'data-bd-md-hr': '' }))
          i++
          continue
        }

        // 空行
        if (!line.trim()) { i++; continue }

        // 普通段落
        const buf = []
        while (i < lines.length && lines[i].trim()
          && !/^(#{1,6}\s|\s*[-*+]\s|\s*\d+\.\s|>|\s*\||" + MD_FENCE + ")/.test(lines[i])) {
          buf.push(lines[i])
          i++
        }
        if (buf.length) out.push(h('p', { key: k(), 'data-bd-md-p': '' }, ...renderInline(buf.join(' '), k())))
        else i++
      }
      return out
    }

    /* ────────────── 设置页正文 ────────────── */

    function Panel({ layout = 'settings', onConfigChanged } = {}) {
      const [st, setSt] = useStatus(5000)
      const [busy, setBusy] = React.useState('')
      const [saving, setSaving] = React.useState(false)
      const [msg, setMsg] = React.useState('')
      const [msgTone, setMsgTone] = React.useState('')
      const [kws, setKws] = React.useState(null)
      const [ws, setWs] = React.useState(null)
      /* ⭐ 跑在哪个目录（2026-10-22 用户：「不能直接显示吗？我工作区列表没有这个」）：
       *    会话按 cwd 分桶，跑在哪就出现在哪个工作区的会话列表里。留空 = 用工作区。 */
          const [rl, setRl] = React.useState(null)
      const [newVer, setNewVer] = React.useState('')       // 发现的新版本号（空 = 没发现）
      const [selfUpgrade, setSelfUpgrade] = React.useState(true)  // 桌面版不能自升级，只提示去「设置 → 插件」
      const [runLog, setRunLog] = React.useState(null)     // 本轮进度（日志尾部 + 阶段）
      const [dmInfo, setDmInfo] = React.useState(null)     // 私信收件人的识别结果 { name, level } / { error }
      const [dmBusy, setDmBusy] = React.useState(false)
      const [runLogFold, setRunLogFold] = React.useState(null)  // 运行日志折叠：null = 跟随"是否在跑"
      // ⚠️ 输入框必须绑"本地草稿"：页面每 5 秒轮询 /status，服务端那份会把 config 盖掉
      //    ⇒ 直接绑 cfg 的话，用户打字打到一半就被冲没了 ✗（2026-10-14 陌生人验收时抓到）
      const [perDay, setPerDay] = React.useState(null)
      const [perRound, setPerRound] = React.useState(null)
      const [replyPer, setReplyPer] = React.useState(null)
      const [dmUid, setDmUid] = React.useState(null)        // 私信收件人 UID（本地草稿）
      const [dmOn, setDmOn] = React.useState(null)          // 私信开关（独立于评论）
      /* 守护评论区（骑士团）：字段名由宿主 schema 定死，这里只采集 + 保存。
       * 跟上面那些输入框一样绑**本地草稿** —— 5 秒一次的 /status 轮询会盖掉直接绑 cfg 的值。 */
      const [guardOn, setGuardOn] = React.useState(null)          // 守护总开关
      const [guardOwnAll, setGuardOwnAll] = React.useState(null)  // 大号视频下不用 @ 也回
      const [guardDailyCap, setGuardDailyCap] = React.useState(null)  // 每天最多回几条
      const [guardWhitelist, setGuardWhitelist] = React.useState(null)  // 白名单 UID（逗号/空格分隔）
      const [guardScope, setGuardScope] = React.useState(null)    // 守最近几条视频
      const [guardPerRound, setGuardPerRound] = React.useState(null)  // 每轮最多回几条
      const [guardPoll, setGuardPoll] = React.useState(null)      // 多少分钟扫一次
      const [guardEmoji, setGuardEmoji] = React.useState(null)    // 回复末尾带表情
      const [guardTone, setGuardTone] = React.useState(null)      // 守护口径：怎么说话
      const [guardLog, setGuardLog] = React.useState(null)        // 守护记录（最近 50 条）
      const [guardLogBusy, setGuardLogBusy] = React.useState(false)
      /* 点赞与收藏：数字/文本项同样绑本地草稿（/status 5 秒轮询会冲掉直接绑 cfg 的值） */
      const [likePerRound, setLikePerRound] = React.useState(null)   // 每轮最多赞几条
      const [likePerDay, setLikePerDay] = React.useState(null)       // 每天最多赞几条
      const [likeRule, setLikeRule] = React.useState(null)           // 判据档位：strict/standard/loose
      const [likeRuleExtra, setLikeRuleExtra] = React.useState(null) // 补充判据（自由文本）
      const [favPerDay, setFavPerDay] = React.useState(null)         // 每天最多收藏几条
      const [likes, setLikes] = React.useState(null)                 // GET /likes：今日计数 + 明细
      const [autoRun, setAutoRun] = React.useState(null)
      const [runsPerDay, setRunsPerDay] = React.useState(null)
      const [gapMin, setGapMin] = React.useState(null)
      const [pvOnly, setPvOnly] = React.useState(null)
      const [pickPerRound, setPickPerRound] = React.useState(null)   // 每轮最多挑几条
      const [pickPerDay, setPickPerDay] = React.useState(null)       // 每天最多挑几条
      const [transCap, setTransCap] = React.useState(null)      // 每日转写上限
      const [minDur, setMinDur] = React.useState(null)          // 最短分钟
      const [maxDur, setMaxDur] = React.useState(null)          // 最长分钟
      const [preferSub, setPreferSub] = React.useState(null)    // 字幕优先
      const [probeMax, setProbeMax] = React.useState(null)      // 最多查几条字幕
      const [mention, setMention] = React.useState(null)
      const [mentionUid, setMentionUid] = React.useState(null)
      const [mentionInfo, setMentionInfo] = React.useState(null)   // { name, face, level } 或 { error }
      const [mentionBusy, setMentionBusy] = React.useState(false)
      const [login, setLogin] = React.useState(null)
      const [runNote, setRunNote] = React.useState(null)    // 顶部状态提示（原来在最底下，看不见）
      const [report, setReport] = React.useState(null)      // 非 null = 报告已展开
      const [loginState, setLoginState] = React.useState('')
      const [loginTone, setLoginTone] = React.useState('')
      const [adv, setAdv] = React.useState(null)            // 高级设置：null = 按状态自动判定
      const [logOpen, setLogOpen] = React.useState(false)      // 主依赖日志
      const [asrLogOpen, setAsrLogOpen] = React.useState(false) // 转写日志
      /* ⚠️ 扫码轮询的 timer 必须能停：切走设置页后还在跑的话会在已卸载的组件上 setState，
       *    重复点「扫码登录」还会叠出第二个 timer。（2026-10-16 审查修） */
      const loginTimer = React.useRef(null)
      const alive = React.useRef(true)
      React.useEffect(() => () => {
        alive.current = false
        if (loginTimer.current) { clearInterval(loginTimer.current); loginTimer.current = null }
      }, [])

      const cfg = st?.config
      /* ⭐ 运行模型：数据来自服务端 /models，
       *    它读的是 DSH 真实注册的 provider —— 这里不写死任何线路。 */
      const [models, setModels] = React.useState(null)
      const [dutyProv, setDutyProv] = React.useState('')
      const [dutyModel, setDutyModel] = React.useState('')
      const [profileMsg, setProfileMsg] = React.useState('')
      const reloadModels = async () => {
        try { const d = await jget('/models'); if (d?.ok) { setModels(d); return d } } catch { /* 拿不到就降级 */ }
        return null
      }
      React.useEffect(() => {
        let alive2 = true
        const load = async () => {
          try { const d = await jget('/models'); if (alive2 && d?.ok) setModels(d) } catch { /* 拿不到就降级 */ }
        }
        load()
        return () => { alive2 = false }
      }, [])
      /* ⭐ 把「只在桌面装了的线路插件」一键装进值班 profile（2026-10-20）。
       *    必须用户点：这是往他机器里装第三方包，不能静默做。 */
      const installToProfile = async (x) => {
        if (!x || !x.package) return
        const prof = (models && models.profile) || 'headless'
        setBusy('profile-add'); setProfileMsg('')
        try {
          const r = await jpost('/profile-add', { package: x.package, profile: prof })
          if (r?.ok) {
            setProfileMsg('已装到「' + prof + '」，正在重新读取模型…')
            const d = await reloadModels()
            const ok = d && (d.providers || []).some((p) => p.id === x.id && p.usable !== false)
            setProfileMsg(ok ? '装好了，现在可以选 ' + x.name + ' 了。' : '装完了，但还没识别到。重启一次 DSH 再试。')
          } else {
            setProfileMsg('装失败：' + (r?.error || '') + (r?.output ? '\n' + String(r.output).slice(-500) : ''))
          }
        } catch (e) {
          setProfileMsg('装失败：' + (e?.message ?? e))
        } finally {
          setBusy('')
        }
      }
      /* ⚠️ 只在「第一次拿到配置」时回填：status 每 5 秒轮询一次，无条件回填会把
       *    用户正在选的值冲回旧值（跟上面 perDay 那些输入框同一类坑）。 */
      const dutyFilled = React.useRef(false)
      React.useEffect(() => {
        if (!cfg || dutyFilled.current) return
        dutyFilled.current = true
        setDutyProv(cfg.dutyProvider || '')
        setDutyModel(cfg.dutyModel || '')
      }, [cfg])
      React.useEffect(() => {
        if (cfg && kws === null) setKws((cfg.keywords || []).join('\n'))
        if (cfg && ws === null) setWs(cfg.workspace || '')
            if (cfg && rl === null) setRl(cfg.reportLevel || 'full')
        if (cfg && perDay === null) setPerDay(String(cfg.perDay ?? 5))
        if (cfg && perRound === null) setPerRound(String(cfg.commentPerRound ?? 1))
        if (cfg && replyPer === null) setReplyPer(String(cfg.replyPerRound ?? 1))
        if (cfg && mention === null) setMention(cfg.mentionName || '')
        if (cfg && mentionUid === null) setMentionUid(cfg.mentionUid ? String(cfg.mentionUid) : '')
        if (cfg && dmUid === null) setDmUid(cfg.dmUid ? String(cfg.dmUid) : '')
        if (cfg && dmOn === null) setDmOn(Boolean(cfg.dmOn))
        if (cfg && guardOn === null) setGuardOn(Boolean(cfg.guardOn))
        if (cfg && guardOwnAll === null) setGuardOwnAll(cfg.guardOwnAll !== false)
        if (cfg && guardDailyCap === null) setGuardDailyCap(String(cfg.guardDailyCap ?? 30))
        if (cfg && guardWhitelist === null) setGuardWhitelist(String(cfg.guardWhitelist ?? ''))
        if (cfg && guardScope === null) setGuardScope(String(cfg.guardScope ?? 1))
        if (cfg && guardPerRound === null) setGuardPerRound(String(cfg.guardPerRound ?? 3))
        if (cfg && guardPoll === null) setGuardPoll(String(cfg.guardPollMinutes ?? 3))
        if (cfg && guardEmoji === null) setGuardEmoji(cfg.guardEmoji !== false)
        if (cfg && guardTone === null) setGuardTone(String(cfg.guardTone ?? ''))
        if (cfg && autoRun === null) setAutoRun(Boolean(cfg.autoRun))
        if (cfg && runsPerDay === null) setRunsPerDay(String(cfg.autoRunsPerDay ?? 6))
        if (cfg && gapMin === null) setGapMin(String(cfg.autoGapMinutes ?? 60))
        if (cfg && pvOnly === null) setPvOnly(Boolean(cfg.peakValleyOnly))
        if (cfg && pickPerRound === null) setPickPerRound(String(cfg.perRoundMax ?? 3))
        if (cfg && pickPerDay === null) setPickPerDay(String(cfg.perDayMax ?? 18))
        if (cfg && transCap === null) setTransCap(String(cfg.transcribePerDay ?? 10))
        if (cfg && minDur === null) setMinDur(String(cfg.minDurationMin ?? 0))
        if (cfg && maxDur === null) setMaxDur(String(cfg.maxDurationMin ?? 60))
        if (cfg && preferSub === null) setPreferSub(cfg.preferSubtitle !== false)
        if (cfg && probeMax === null) setProbeMax(String(cfg.subtitleProbeMax ?? 3))
        if (cfg && likePerRound === null) setLikePerRound(String(cfg.likePerRound ?? 1))
        if (cfg && likePerDay === null) setLikePerDay(String(cfg.likePerDay ?? 3))
        if (cfg && likeRule === null) setLikeRule(String(cfg.likeRule ?? 'standard'))
        if (cfg && likeRuleExtra === null) setLikeRuleExtra(String(cfg.likeRuleExtra ?? ''))
        if (cfg && favPerDay === null) setFavPerDay(String(cfg.favPerDay ?? 2))
      }, [cfg])

      /* ⭐ 守护记录（2026-10-22）：自动拿号说话，必须能事后核对。
       *    数据来自 /guard/log —— 宿主写「扫到什么/判成什么」，MCP 子进程写「真发出去什么」。
       *    开关打开时才拉（关着没意义），另外给个手动刷新按钮。 */
      const loadGuardLog = async () => {
        setGuardLogBusy(true)
        try { setGuardLog(await jget('/guard/log?limit=50')) } catch { /* 网络抖一下就跳过 */ } finally { setGuardLogBusy(false) }
      }
      React.useEffect(() => {
        if (guardOn) { loadGuardLog() } else { setGuardLog(null) }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [guardOn])

      /* 今日点赞 / 收藏计数：跟 /status 同频（5 秒）拉一次 —— 指标栏和历史页共用这一份口径 */
      React.useEffect(() => {
        let on = true
        const pull = async () => {
          try { const d = await jget('/likes'); if (on && d && d.ok) setLikes(d) } catch { /* 网络抖一下就下次再问 */ }
        }
        pull()
        const t = setInterval(pull, 5000)
        return () => { on = false; clearInterval(t) }
      }, [])

      /* 守护记录列表：三种行 —— scan（扫了一次）/ queue（派出去回）/ reply（真发出去了） */
      const renderGuardLog = () => {
        const items = Array.isArray(guardLog?.items) ? guardLog.items : []
        if (!items.length) return h('div', { 'data-bd-row-desc': '' }, '还没有记录。开关打开后，扫到东西就会写在这里。')
        const hhmm = (ts) => {
          const d = new Date(Number(ts) || 0)
          return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
        }
        const line = (key, text) => h('div', { key, 'data-bd-row-desc': '', style: { padding: '3px 0' } }, text)
        return h('div', {}, items.map((it, i) => {
          if (it?.type === 'scan') {
            const s = it.skip || {}
            return line('s' + i, `${hhmm(it.ts)} · 扫了一次：@ ${it?.scanned?.at ?? 0} 条 / 评论 ${it?.scanned?.comments ?? 0} 条 → 派 ${it.queued ?? 0} 条`
              + `（跳过：纯水 ${s.junk ?? 0} · 自己 ${s.owner ?? 0} · 已回过 ${s.seen ?? 0} · 不在白名单 ${s.wl ?? 0}）`)
          }
          if (it?.type === 'queue') {
            return line('q' + i, `${hhmm(it.ts)} · ${it.kind === 'at' ? '@ 通知' : '评论区'} · ${it.uname || it.uid}：${String(it.text || '').slice(0, 60)}`)
          }
          if (it?.type === 'reply') {
            return line('r' + i, `${hhmm(it.ts)} · ${it.ok ? '✅ 已回' : '❌ 没回成'}${it.bvid ? ' · ' + it.bvid : ''}${it.rpid ? ' · rpid=' + it.rpid : ''}`
              + `：${String(it.text || '').slice(0, 80)}${it.ok ? '' : `（${String(it.error || '').slice(0, 80)}）`}`)
          }
          return null
        }))
      }

      /* ⭐ 本轮进度轮询（2026-10-20）：跑着的时候每 2 秒拉一次日志尾部，跑完再拉一次收尾。
       *    只读日志尾部，不攒内存；st.running 一变就重建定时器。 */
      const runningNow = Boolean(st?.running)
      React.useEffect(() => {
        let alive = true
        let timer = null
        const pull = async () => {
          try { const r = await jget('/runlog?n=40'); if (alive && r && r.ok) setRunLog(r) } catch { /* 网络抖一下就跳过 */ }
        }
        if (runningNow) {
          pull()
          timer = setInterval(pull, 2000)
        } else pull()
        return () => { alive = false; if (timer) clearInterval(timer) }
      }, [runningNow])

      /* ⭐ 评论上限的天花板（2026-10-20）：评的就是"挑中的那几条"，所以不可能超过每轮挑中数。
       *    再叠一个 5 的硬顶（个人号不宜批量刷）。挑 0 条时给 0 —— 那一轮压根没有可评的对象。 */
      const pickCap = Math.max(0, Number(pickPerRound ?? cfg?.perRoundMax ?? 3) || 0)
      const commentCap = Math.min(5, pickCap)

      const win = { ...DEFAULT_WINDOWS, ...(st?.windows || {}) }

      const say = (text, tone) => {
        setMsg(text); setMsgTone(tone || '')
        setRunNote(text ? { t: text, tone: tone || '' } : null)   // ⭐ 同时镜像到顶部
      }

      /* 设置页保存 / 绑定后，把新配置同步给外层的鱼塘首页；否则首页快捷区会一直拿着旧快照。 */
      const applyConfigPatch = (p) => {
        if (!p) return
        setSt((old) => old ? { ...old, config: { ...(old.config || {}), ...p } } : old)
        onConfigChanged?.(p)
      }

      /* ⚠️ 并发保存的最后一笔才算数：响应乱序时，晚到的旧 config 会把新的盖回去。 */
      const patchSeq = React.useRef(0)
      const patch = async (p, what) => {
        const seq = ++patchSeq.current
        setSaving(true)
        setBusy(JSON.stringify(p))
        try {
          const r = await jpost('/config', p)
          if (r?.config && seq === patchSeq.current) applyConfigPatch({ ...(r.config || {}), ...p })
          // ⭐ DSH 原生设置页里显式设过的键由宿主说了算 ⇒ 我们这份也得写进去；写失败要说出来，别假装"已保存"
          // ⚠️ noForm 不算失败：那个部署本来就没有可写的设置表单，配置就只存在插件这边
          if (r?.host && r.host.ok === false && !r.host.noForm) say(`${what || '设置'}：已保存到插件配置，但同步到 DSH 设置失败（${r.host.error}）`, 'warn')
          else say(what ? `${what}：已保存` : '已保存', 'good')
        } catch (e) { say(String(e?.message ?? e), 'warn') }
        finally { setSaving(false); setBusy('') }
      }

      const onShowReport = async () => {
        if (report !== null) { setReport(null); return }       // 再点一次收起
        setBusy('report')
        try {
          const r = await jget('/report')
          setReport(r && r.exists ? (r.text || '（报告内容为空）') : '今日暂无报告 —— 运行一轮后生成')
        } catch (e) { setReport('读取报告失败：' + String(e?.message ?? e)) } finally { setBusy('') }
      }

      // ⭐ 复核评论：接口回"发送成功"≠ 公开可见（新号/风控会进审核，那时候连 @ 都不会推）
      //    所以让宿主真去拉一次评论列表 / 楼中楼，确认那条到底在不在。
      const onVerify = async () => {
        setBusy('verify')
        try {
          const r = await jpost('/verify', {})
          if (!r || !r.ok) { say('复核未执行：' + ((r && r.error) || '未知原因'), 'warn'); return }
          const n = (r.checked || []).length
          const vis = (r.checked || []).filter((c) => c.visible === true).length
          if (!n) say(r.text || '没有需要复核的记录', 'good')
          else say(`复核完成 ${n} 条：公开可见 ${vis} 条，其余状态为「未查到」（可能仍在审核，未查到不等于未发布）。结果已追加到今日报告末尾。`, vis ? 'good' : 'warn')
          if (r.report) setReport(null)
        } catch (e) { say(String(e?.message ?? e), 'warn') } finally { setBusy('') }
      }

      const copyText = async (text) => {
        const v = String(text || '')
        try {
          await navigator.clipboard.writeText(v)
          say('已复制：' + v, 'good')
        } catch {
          say('复制失败 —— 路径为：' + v)       // 兜底：至少把路径显示出来，手动选中也能复制
        }
      }

      const onOpenFolder = async (what) => {
        try {
          const r = await jpost('/open', { what })
          if (r && r.ok) say('已请求系统打开：' + (r.opened || '') + '（若未弹出窗口，请使用「复制报告路径」）', 'good')
          else say('无法打开（' + ((r && r.error) || '未知原因') + '）—— 可手动打开该路径：' + ((r && r.dir) || ''))
        } catch (e) { say(String(e?.message ?? e), 'warn') }
      }

      const onUpgrade = async () => {
        setBusy('upgrade')
        try {
          const r = await jpost('/upgrade', {})
          say(((r && r.hint) || '正在升级') + ' —— 升级过程写入「主依赖日志」；完成后需重启 dsh 才会生效', 'warn')
        } catch (e) { say(String(e?.message ?? e), 'warn') } finally { setBusy('') }
      }

      const onCheckUpdate = async () => {
        setBusy('update')
        try {
          const r = await jget('/update')
          if (r && r.ok && r.latest) {
            if (r.hasNew) {
              setNewVer(r.latest)
              setSelfUpgrade(r.selfUpgrade !== false)
              say(r.selfUpgrade === false
                ? '发现新版本 v' + r.latest + '（当前 v' + r.current + '）—— 桌面版请到「设置 → 插件」里更新'
                : '发现新版本 v' + r.latest + '（当前 v' + r.current + '）—— 点击「升级」，完成后重启 dsh', 'warn')
            } else say('已是最新版本 v' + r.current, 'good')
          } else {
            say('无法获取最新版本（可能网络不可用）—— 当前版本 v' + ((r && r.current) || '?'))
          }
        } catch (e) { say(String(e?.message ?? e), 'warn') } finally { setBusy('') }
      }

      const onCheck = async () => {
        setBusy('check')
        say('')
        try {
          const r = await jpost('/check', {})
          if (r && r.ok) say('运行正常：' + (r.steps || []).join('、'))
          else say('尚不可用：' + (r && r.error ? r.error : '未获取到结果'))
        } catch (e) { say(String(e?.message ?? e), 'warn') } finally { setBusy('') }
      }

      const onInstallAsr = async () => {
        setBusy('asr')
        say('')
        try {
          const r = await jpost('/install-asr', {})
          say(r?.started ? '开始安装转写依赖 —— 进度显示在下方（需下载模型，耗时较长）' : (r?.hint || '未启动'),
            r?.started ? 'good' : 'warn')
        } catch (e) { say(String(e?.message ?? e), 'warn') } finally { setBusy('') }
      }

      const onInstall = async () => {
        setBusy('install')
        say('')
        try {
          const r = await jpost('/install', {})
          say(r?.hint || '已在后台开始安装', '')
        } catch (e) { say(String(e?.message ?? e), 'warn') }
        finally { setBusy('') }
      }

      const onRun = async () => {
        setBusy('run')
        try {
          const r = await jpost('/run', {})
          if (r?.started) say('已在后台运行一轮，报告将写入 out/ 目录', 'good')
          else if (r?.busy) say(String(r.error || '上一轮还在跑，等它结束再开'), 'warn')
          else say('未启动，详见 duty.log', 'warn')
        } catch (e) { say(String(e?.message ?? e), 'warn') }
        finally { setBusy('') }
      }

      const onLoginStart = async () => {
        setBusy('login')
        setLoginTone('')
        setLoginState('正在生成二维码…')
        try {
          const r = await jpost('/login/start', {})
          if (!r?.ok) { setLoginTone('warn'); setLoginState(r?.error || '生成二维码失败'); return }
          setLogin({ key: r.key, qr: r.qr })
          if (!r.qr) { setLoginTone('warn'); setLoginState('未能绘制二维码 —— 请先点「重装主依赖」（venv 需含 qrcode）') }
          else setLoginState('请使用手机 B站 扫描二维码')
          if (loginTimer.current) { clearInterval(loginTimer.current); loginTimer.current = null }   // 重复点：先把上一轮停掉
          let n = 0
          const stop = () => { clearInterval(timer); if (loginTimer.current === timer) loginTimer.current = null }
          const timer = setInterval(async () => {
            if (!alive.current) { stop(); return }        // 已经切走设置页了：别再问、别再 setState
            n += 1
            try {
              const p = await jpost('/login/poll', { key: r.key })
              if (p?.state === 'ok') {
                stop(); setLogin(null)
                setLoginTone('good'); setLoginState('登录成功')
                setSt((old) => ({ ...old, loggedIn: true }))
              } else if (p?.state === 'scanned') { setLoginTone(''); setLoginState('已扫描，请在手机上确认') }
              else if (p?.state === 'expired') { stop(); setLogin(null); setLoginTone('warn'); setLoginState('二维码已过期，请重新点击「扫码登录」') }
              // ⚠️ 扫码成功但响应里没有 SESSDATA 时服务端回 state='unknown'：原来没这个分支
              //    ⇒ 界面一直显示「等扫码…」，用户白等 3 分钟才超时。（2026-10-16 审查修）
              else if (p?.state === 'unknown') {
                stop(); setLogin(null); setLoginTone('warn')
                setLoginState('登录未完成：' + (p?.message || '响应中无 SESSDATA，请重新点击「扫码登录」'))
              }
              else { setLoginTone(''); setLoginState('等待扫描…') }
            } catch { /* 抖动就下次再问 */ }
            if (n > 90) { stop(); setLogin(null); setLoginTone('warn'); setLoginState('已超时，请重新点击「扫码登录」') }
          }, 2000)
          loginTimer.current = timer
        } catch (e) { setLoginTone('warn'); setLoginState(String(e?.message ?? e)) }
        finally { setBusy('') }
      }

      /* ⭐ UID → 昵称：B站 评论只认昵称文本，所以让用户填 UID（可记、可查），
       *    后端解析出昵称后自动写进 mentionName。解析失败要说清楚，别静默。 */
      const onResolveUid = async () => {
        const uid = Math.max(0, Number(mentionUid) || 0)
        if (!uid) { setMentionInfo({ error: '先填 UID' }); return }
        setMentionBusy(true)
        setMentionInfo(null)
        try {
          const r = await jpost('/resolve-user', { uid, target: 'mention' })
          if (r?.ok) {
            setMention(r.name)
            setMentionInfo({ name: r.name, level: r.level })
            applyConfigPatch({ mentionUid: uid, mentionName: r.name })
            say('已识别：' + r.name, 'good')
          } else {
            setMentionInfo({ error: r?.error || '解析失败' })
            say(r?.error || '解析失败', 'warn')
          }
        } catch (e) {
          setMentionInfo({ error: String(e?.message ?? e) })
          say(String(e?.message ?? e), 'warn')
        } finally { setMentionBusy(false) }
      }

      /* ⭐ 私信收件人的识别（2026-10-20）：只回昵称给界面确认，**不写 mentionName**
       *    —— 那是评论里 @ 的人，写错会串到公开评论上。 */
      const onResolveDmUid = async () => {
        const uid = Math.max(0, Number(dmUid) || 0)
        if (!uid) { setDmInfo({ error: '先填 UID' }); return }
        setDmBusy(true); setDmInfo(null)
        try {
          const r = await jpost('/resolve-user', { uid, target: 'dm' })
          if (r?.ok) { setDmInfo({ name: r.name, level: r.level }); applyConfigPatch({ dmUid: uid }); say('私信收件人：' + r.name, 'good') }
          else { setDmInfo({ error: r?.error || '解析失败' }); say(r?.error || '解析失败', 'warn') }
        } catch (e) { setDmInfo({ error: String(e?.message ?? e) }) }
        finally { setDmBusy(false) }
      }

      /* 检索关键词改失焦即存（`client.js` 里那个 textarea 的 onBlur），原来的 onSaveText 已删掉。 */

      /* ⭐ 「建模板」：不知道 AGENTS.md 该写什么格式 ⇒ 让插件在工作区里铺一份能直接改的骨架 */
      const onAgentsTemplate = async () => {
        const dir = String(ws ?? '').trim()
        if (!dir) { say('先在上面填「工作区路径」，再点「建模板」', 'warn'); return }
        setBusy('agents')
        try {
          const r = await jpost('/agents-template', { dir })
          if (r && r.ok) say('已生成 ' + r.path + ' —— 照着里面每一节改就行', 'good')
          else if (r && r.exists) say('这个目录里已经有 AGENTS.md 了，没覆盖：' + r.path, 'warn')
          else say('生成失败：' + ((r && r.error) || '未知原因'), 'warn')
        } catch (e) { say(String(e?.message ?? e), 'warn') } finally { setBusy('') }
      }

      /* ── 加载态：给骨架，别只丢一句"读设置中…" ── */
      if (!cfg) {
        return h('div', { 'data-bd-page': '', 'data-bd-layout': layout },
          h('div', { 'data-bd-skeleton': '', 'data-bd-wide': '' },
            h('div', { 'data-bd-sk-narrow': '' }), h('div'), h('div'), h('div')),
          h('div', { 'data-bd-row-desc': '', 'data-bd-wide': '' }, '正在加载设置…（若长时间停留在此，请查看 duty.log）'))
      }

      const sw = (k) => Boolean(cfg[k])
      const picked = st.pickedToday ?? st.ranToday ?? 0
      // 高级设置默认：环境未就绪 / 未登录 ⇒ 展开（那正是最需要操作的时候）
      const advOpen = adv === null ? (!st.venvReady || !st.loggedIn) : adv
      const needSetup = !st.venvReady
      const needLogin = st.venvReady && !st.loggedIn

      /* 状态文案：短、可判定
       * ⭐ 2026-10-20：改成读新字段 autoRun / perDayMax（原来读 peakValley / perDay，
       *    导致自动开着也显示「仅手动」）。 */
      const dayCap = Number(cfg.perDayMax) || 0
      const pickedTone = dayCap > 0 && picked >= dayCap ? 'ok' : undefined
      const envTxt = st.venvReady ? '就绪' : (st.installing ? '安装中' : '未安装')
      const envTone = st.venvReady ? 'ok' : (st.installing ? 'warn' : 'err')
      const loginTxt = st.loggedIn ? '已登录' : '未登录'
      const loginToneV = st.loggedIn ? 'ok' : 'warn'
      const inPvWindow = Boolean(st.windows?.noon?.opening || st.windows?.night?.opening)
      const planTxt = st.installing ? '安装中'
        : (!sw('autoRun')
          ? '仅手动'
          : (sw('peakValleyOnly')
            ? (inPvWindow ? '运行中' : '待触发')
            : '自动运行'))
      const planTone = st.installing ? 'warn'
        : (sw('autoRun') ? (inPvWindow || !sw('peakValleyOnly') ? 'ok' : undefined) : undefined)

      /* ⭐ 本轮实际会投递什么 —— 评论与私信是两个**独立开关**，判据与宿主端一致
       *   （index.js 的 commentOn = autoComment && mentionName、dmOn = dmOn && dmUid） */
      const dmActive = Boolean(dmOn && Number(dmUid) > 0)
      const circleActive = Boolean(cfg.circleMode)
      const commentActive = Boolean(!circleActive && sw('autoComment') && cfg.mentionName)
      const deliverNow = circleActive
        ? (dmActive ? '圈地自萌楼中楼 + 私信' : '只回 UP 邀请的楼中楼')
        : (!commentActive && !dmActive
          ? '只生成报告，不发布任何内容'
          : (commentActive && dmActive
            ? '评论 + 私信'
            : (commentActive ? '只发公开评论' : '只发私信')))

      /* 点赞判据档位：选项里带一句人话，选中态再在行说明里复述一遍（跟「评论模式」同一个写法） */
      const LIKE_RULE_DESC = {
        strict: '严格：只赞「有实操细节、本周用得上」的，宁可不赞',
        standard: '标准：默认档，三条硬证据占两条才赞',
        loose: '宽松：有点意思就赞，但仍受额度限制',
      }

      /* ⭐ 2026-10-25：原生设置页（头像 → 设置 → B站鱼塘）只留「运行环境 + 安装日志」。
       *    理由：那屏是「一开始把它配起来」的地方；参数调优每天都在鱼塘大页里做，
       *    两处都铺一份全量设置 ⇒ 双份 /status 轮询 + 两份草稿互相冲掉。
       *    想改任何一项去鱼塘大页的「设置」tab（同一个组件，layout='embedded' 那条分支）。 */
      if (layout === 'summary') {
        const ready = st.venvReady
        const stateTxt = ready
          ? (st.loggedIn ? '就绪' : '待登录')
          : (st.installing ? '安装中' : (st.installFailed ? '上次安装失败' : '待安装'))
        return h('div', { 'data-bd-page': '', 'data-bd-layout': 'settings' },
          h(Card, {
            title: '运行环境',
            desc: '装好依赖 + 扫码登录一次就能用；其余设置都在鱼塘大页里',
          },
            h(StackRow, { label: '状态', hint: stateTxt },
              h('div', { 'data-bd-btns': '' },
                h('button', { 'data-bd-btn': '', disabled: busy === 'install', onClick: onInstall },
                  ready ? '重装依赖' : '安装运行环境'),
                h('button', { 'data-bd-btn': '', disabled: busy === 'check', onClick: onCheck }, '连通性检测'),
                h('button', { 'data-bd-btn': '', disabled: busy === 'login', onClick: onLoginStart }, '扫码登录'),
                h('button', { 'data-bd-btn': '', 'data-primary': '', onClick: () => openPond(POND_ID) }, '打开鱼塘'))),
            loginState ? h('div', {
              'data-bd-msg': '', 'data-bd-msg-gap': '',
              'data-good': loginTone === 'good' ? '' : undefined,
              'data-warn': loginTone === 'warn' ? '' : undefined,
            }, loginState) : null,
            login?.qr ? h('div', { 'data-bd-qr': '' },
              h('img', { src: login.qr, alt: 'B站登录二维码' }),
              h('div', { 'data-bd-qr-note': '' },
                '手机 B站 → 我的 → 扫一扫。',
                h('br'),
                '确认时请选择「记住我 / 长期」；选择 24 小时则次日需重新扫码。')) : null,
            h(LogFold, {
              label: st.installing ? '安装进度' : '安装日志',
              desc: st.installing ? '' : '（末尾 1400 字）',
              text: st.installTail,
              open: logOpen,
              onToggle: () => setLogOpen((v) => !v),
            })),
        )
      }

      return h('div', { 'data-bd-page': '', 'data-bd-layout': layout },

        /* ══ ① 指标栏 ══════════════════════════════════════════════════ */
        /* 指标栏：三个就够了 —— 「环境」和「状态」原来分成两格，
         * 但环境没装好时状态必然是「待配置」，信息重复；这里并成一格。 */
        h('div', { 'data-bd-metrics': '' },
          h(Metric, {
            label: '今日选取',
            value: `${picked} / ${cfg.perDayMax || '不限'}`,
            tone: pickedTone,
          }),
          h(Metric, {
            label: '运行环境',
            value: st.venvReady ? (st.loggedIn ? '就绪' : '待登录') : (st.installing ? '安装中' : '待安装'),
            tone: st.venvReady ? (st.loggedIn ? 'ok' : 'warn') : (st.installing ? 'warn' : 'err'),
          }),
          h(Metric, { label: '运行状态', value: planTxt, tone: planTone }),
          /* 点赞 / 收藏今日计数：跟上面三格同一行，关掉的那项不占位。
           * 数据来自 /likes，口径与历史页那一行完全一致。 */
          likes ? h(Metric, {
            label: '点赞',
            value: `今天 ${Number(likes?.like?.today) || 0} / ${Number(likes?.like?.perDay) || Number(cfg.likePerDay) || 0}`,
            tone: sw('likeOn') ? ((Number(likes?.like?.today) || 0) > 0 ? 'ok' : undefined) : undefined,
          }) : null,
          (likes && sw('favOn')) ? h(Metric, {
            label: '收藏',
            value: `今天 ${Number(likes?.fav?.today) || 0} / ${Number(likes?.fav?.perDay) || Number(cfg.favPerDay) || 0}`,
            tone: (Number(likes?.fav?.today) || 0) > 0 ? 'ok' : undefined,
          }) : null),

        /* ══ ①.5 本轮进度（跑的时候实时刷，跑完留最后一份）══════════════ */
        (st.running || runLog) ? (() => {
          const L = runLog || {}
          const lines = Array.isArray(L.lines) ? L.lines : []
          const sec = st.running ? (L.elapsedSec || st.runElapsedSec || 0) : 0
          const mm = Math.floor(sec / 60); const ss = String(sec % 60).padStart(2, '0')
          /* ⭐ 日志默认折叠（2026-10-20）：跑着的时候展开（这时候才关心），跑完了默认收起。
           *    用户手动点过就记住他的选择（runLogFold !== null 之后一律听他的）。 */
          const foldOpen = runLogFold !== null ? runLogFold : Boolean(st.running)
          return h(Card, {
            wide: true,
            title: '本轮进度',
            desc: st.running
              ? `跑着（${st.runWhy === 'manual' ? '手动' : st.runWhy || '自动'}）· 已用时 ${mm}:${ss}${L.stage ? ' · 当前：' + L.stage : ''}`
              : (lines.length ? '上一轮已结束' : ''),
          },
            h('div', { 'data-bd-row-desc': '' },
              `今日已挑 ${st.pickedToday ?? 0} / ${cfg.perDayMax || '不限'} 条`
              + (st.running ? ' · 日志每 2 秒刷新，跑完自动停' : '')),
            (st.lastError && !st.running)
              ? h('div', { 'data-bd-msg': '', 'data-warn': '' }, '⚠️ 上一轮没成功：' + st.lastError.hint)
              : null,
            lines.length
              ? h(LogFold, {
                label: '本轮运行输出',
                desc: `（末尾 ${Math.min(lines.length, 20)} 行 · 这份是这一轮的模型输出，插件自己的事件在 duty.log）`,
                text: lines.slice(-20).join('\n'),
                open: foldOpen,
                onToggle: () => setRunLogFold(!foldOpen),
              })
              : h('div', { 'data-bd-row-desc': '' }, '（还没有日志：这一轮刚开始，或者日志被清了）'))
        })() : null,

        /* ══ ② 工具栏 ═════════════════════════════════════════════════ */
        /* ⭐ 跑着的时候按钮变灰（2026-10-20）：以前只灰"点了请求"那一两秒，
         *    之后又能点第二次 ⇒ 会重复开 headless 进程、重复烧模型额度。
         *    现在改成看 status.running（服务端那一轮的进程还活着就一直是 true）。 */
        h('div', { 'data-bd-toolbar': '' },
          h('button', {
            'data-bd-btn': '', 'data-primary': '',
            disabled: busy === 'run' || Boolean(st.running) || Boolean(st.finalizing),
            onClick: onRun,
          }, busy === 'run'
            ? '启动中…'
            : (st.running
              ? `运行中…${st.runElapsedSec ? ' ' + Math.floor(st.runElapsedSec / 60) + ':' + String(st.runElapsedSec % 60).padStart(2, '0') : ''}`
              : (st.finalizing ? '收尾中…' : '立即运行一轮'))),
          h('button', {
            'data-bd-btn': '', disabled: busy === 'report', onClick: onShowReport,
          }, report !== null ? '收起报告' : '查看今日报告'),
          h('div', { 'data-bd-toolbar-spacer': '' }),
          /* 投递方式在「发布与互动」卡片里已经有了，工具栏只留版本号 */
          h('span', { 'data-bd-hint': '' }, `v${st.version || '?'}`)),

        /* 操作反馈：紧贴工具栏 */
        runNote ? h('div', {
          'data-bd-msg': '',
          'data-good': runNote.tone === 'good' ? '' : undefined,
          'data-warn': runNote.tone === 'warn' ? '' : undefined,
          'data-err': runNote.tone === 'err' ? '' : undefined,
        }, runNote.t) : null,

        /* ══ ③ 初始配置引导（只在缺失时出现） ══════════════════════════ */
        (needSetup || needLogin) ? h('div', { 'data-bd-guide': '' },
          h('div', { 'data-bd-guide-txt': '' },
            h('span', { 'data-bd-guide-title': '' }, needSetup ? '第 1 步 · 安装运行环境' : '第 2 步 · 扫码登录'),
            needSetup
              ? '在本机创建独立 Python 环境，并安装 B站 接口依赖。通常需要几十秒。'
              : '使用手机 B站 扫码，确认时请选择「记住我 / 长期」。'),
          h('button', {
            'data-bd-btn': '', 'data-primary': '',
            disabled: needSetup ? busy === 'install' : busy === 'login',
            onClick: needSetup ? onInstall : onLoginStart,
          }, needSetup
            ? (st.installing ? '正在安装…' : '安装运行环境')
            : '扫码登录')) : null,

        /* ══ ④ 配置未同步提示 ══════════════════════════════════════════
           2026-10-18：DSH 0.2.1 某些启动方式会拒写（profile reload requires the root Include entry），
           以前的表现是"开关亮一下又被压回原状"，用户以为是自己手滑。 */
        (Array.isArray(st.notSynced) && st.notSynced.length)
          ? h('div', { 'data-bd-msg': '', 'data-warn': '' },
              `有 ${st.notSynced.length} 项未能同步到 DSH 原生设置（${st.notSynced.join('、')}）。`
              + '插件将以本页配置为准，功能不受影响；DSH 自带设置页不显示这些值。')
          : null,

        /* 报告展开：放在工具栏下方，读报告时不用滚到底
         * ⭐ 2026-10-20：报告改成渲染 markdown（原来是 <pre> 原样显示，满屏星号）。
         *    报告是给人读的成品；日志才是原始终端输出，仍旧用 <pre>。 */
        report !== null ? h(Card, { wide: true, title: '今日报告' },
          h('div', { 'data-bd-md': '' }, ...renderMarkdown(report))) : null,

        /* ══ ⑤ 自动运行（2026-10-20 重构） ═════════════════════════════
         * 旧模型：peakValley 是总开关（只有谷时才跑）。
         * 新模型：autoRun 是主开关；「只在谷时跑」降级成一个可选项。
         * 排班规则：每小时最多 1 轮（间隔可调）、每天最多 N 轮、每天最多挑 M 条。 */

        /* 上限提醒：配置有风险时顶部提示 */
        (() => {
          const warns = []
          const dm = Number(pickPerDay) || 0
          const pr = Number(pickPerRound) || 0
          const rd = Number(runsPerDay) || 0
          if (dm > 24) warns.push(`每天 ${dm} 条 ⇒ 平均每 ${Math.max(1, Math.round(1440 / dm))} 分钟发一条评论。B站 对高频评论 + 固定 @ 同一人有明确的反垃圾识别，小号很可能当天被封。`)
          if (pr > 5) warns.push(`每轮 ${pr} 条偏多 —— 单轮越久，转写和判断成本越高。`)
          if (rd > 12) warns.push(`每天 ${rd} 轮 ⇒ 平均每 ${Math.max(1, Math.round(1440 / rd))} 分钟跑一轮，机器基本没有空闲。`)
          if (!warns.length) return null
          return h('div', { 'data-bd-guide': '', 'data-warn-guide': '' },
            h('div', { 'data-bd-guide-txt': '' },
              h('span', { 'data-bd-guide-title': '' }, '⚠️ 当前配置偏激进'),
              ...warns.map((w, wi) => h('div', { key: wi, style: { marginTop: '4px' } }, w))))
        })(),

        h(Card, {
          title: '自动运行',
          desc: '每天自动跑若干轮；也可以只手动跑。手动那一轮不占自动额度。',
        },
          h(SwitchRow, {
            label: '自动运行',
            hint: '关闭后只能手动跑',
            on: Boolean(autoRun),
            onChange: (v) => { setAutoRun(v); patch({ autoRun: v }, '自动运行') },
          }),
          Boolean(autoRun) ? h('div', { 'data-bd-sub': '' },
            h(Pair, {},
              h(Row, {
                label: '每天最多几轮',
                hint: '0 = 不限',
              }, h('input', {
                'data-bd-input': '', 'data-bd-w-num': '', type: 'number', min: 0, max: 24,
                value: runsPerDay ?? '',
                onChange: (e) => setRunsPerDay(e.target.value),
                onBlur: () => { const n = Math.max(0, Math.min(Number(runsPerDay) || 0, 24)); setRunsPerDay(String(n)); patch({ autoRunsPerDay: n }, '每天最多几轮') },
              })),
              h(Row, {
                label: '两轮间隔',
                hint: '分钟 · 默认 60',
              }, h('input', {
                'data-bd-input': '', 'data-bd-w-num': '', type: 'number', min: 15, max: 240,
                value: gapMin ?? '',
                onChange: (e) => setGapMin(e.target.value),
                onBlur: () => { const n = Math.max(15, Math.min(Number(gapMin) || 60, 240)); setGapMin(String(n)); patch({ autoGapMinutes: n }, '两轮间隔') },
              })))) : null),

        h(Divider),

        h(Card, { title: '每轮与每天上限' },
          h(Pair, {},
            h(Row, {
              label: '每轮最多挑几条',
              hint: '0 = 只跑不挑',
            }, h('input', {
              'data-bd-input': '', 'data-bd-w-num': '', type: 'number', min: 0, max: 20,
              value: pickPerRound ?? '',
              onChange: (e) => setPickPerRound(e.target.value),
              onBlur: () => { const n = Math.max(0, Math.min(Number(pickPerRound) || 0, 20)); setPickPerRound(String(n)); patch({ perRoundMax: n }, '每轮最多挑几条') },
            })),
            h(Row, {
              label: '每天最多挑几条',
              hint: '全天上限',
            }, h('input', {
              'data-bd-input': '', 'data-bd-w-num': '', type: 'number', min: 0, max: 120,
              value: pickPerDay ?? '',
              onChange: (e) => setPickPerDay(e.target.value),
              onBlur: () => { const n = Math.max(0, Math.min(Number(pickPerDay) || 0, 120)); setPickPerDay(String(n)); patch({ perDayMax: n }, '每天最多挑几条') },
            }))),
          h(Row, {
            label: '每天最多转写几次',
            hint: '超过只挑有字幕的',
          }, h('input', {
            'data-bd-input': '', 'data-bd-w-num': '', type: 'number', min: 0, max: 50,
            value: transCap ?? '',
            onChange: (e) => setTransCap(e.target.value),
            onBlur: () => { const n = Math.max(0, Math.min(Number(transCap) || 0, 50)); setTransCap(String(n)); patch({ transcribePerDay: n }, '每天最多转写几次') },
          })),
          h('div', { 'data-bd-row-desc': '' },
            `今天已转写 ${st.asrUsedToday ?? 0} 次${Number(transCap) > 0 ? ' / 上限 ' + transCap : ''} · 今天跑了 ${st.roundsToday ?? 0} 轮`)),

        h(Divider),

        h(Card, { title: '内容筛选' },
          h(Row, {
            label: '只看多长的视频',
            hint: '分钟 · 0 = 该端不限',
          }, h('div', { 'data-bd-inline': '' },
            h('input', {
              'data-bd-input': '', 'data-bd-w-num': '', type: 'number', min: 0, max: 600,
              value: minDur ?? '', placeholder: '最短',
              onChange: (e) => setMinDur(e.target.value),
              onBlur: () => { const n = Math.max(0, Math.min(Number(minDur) || 0, 600)); setMinDur(String(n)); patch({ minDurationMin: n }, '最短时长') },
            }),
            h('span', { 'data-bd-inline-sep': '' }, '~'),
            h('input', {
              'data-bd-input': '', 'data-bd-w-num': '', type: 'number', min: 0, max: 600,
              value: maxDur ?? '', placeholder: '最长',
              onChange: (e) => setMaxDur(e.target.value),
              onBlur: () => { const n = Math.max(0, Math.min(Number(maxDur) || 0, 600)); setMaxDur(String(n)); patch({ maxDurationMin: n }, '最长时长') },
            }))),
          h(SwitchRow, {
            label: '字幕优先',
            hint: '先挑有字幕的，省掉转写',
            on: Boolean(preferSub),
            onChange: (v) => { setPreferSub(v); patch({ preferSubtitle: v }, '字幕优先') },
          }),
          Boolean(preferSub) ? h('div', { 'data-bd-sub': '' },
            h(Row, {
              label: '最多查几条字幕',
              hint: '查完就转写优先级最高的那条',
            }, h('input', {
              'data-bd-input': '', 'data-bd-w-num': '', type: 'number', min: 1, max: 10,
              value: probeMax ?? '',
              onChange: (e) => setProbeMax(e.target.value),
              onBlur: () => { const n = Math.max(1, Math.min(Number(probeMax) || 3, 10)); setProbeMax(String(n)); patch({ subtitleProbeMax: n }, '最多查几条字幕') },
            }))) : null),

        h(Divider),

        h(Card, { title: '峰谷时段（可选）' },
          h(SwitchRow, {
            label: '只在谷时跑',
            desc: '开启后自动轮只排在谷时窗口内。用免费模型时通常不需要',
            on: Boolean(pvOnly),
            onChange: (v) => { setPvOnly(v); patch({ peakValleyOnly: v }, '只在谷时跑') },
          }),
          Boolean(pvOnly) ? h('div', { 'data-bd-sub': '' },
            ...['noon', 'night'].map((k) => h(SwitchRow, {
              key: k,
              label: win[k].label + (st.windows?.[k]?.opening ? '（当前在窗口内）' : ''),
              desc: `${win[k].start} – ${win[k].end}` + (k === 'noon' ? '（这个窗口只排 1 轮）' : ''),
              on: sw(k),
              onChange: (v) => patch({ [k]: v }, win[k].label),
            }))) : null),

        h(Divider),

        h(Card, { title: '日报' },
          h(Row, {
            label: '日报详细程度',
            hint: '完整版更长、更费 token',
          }, h('select', {
            'data-bd-select': '', 'data-bd-w-md': '', value: rl ?? 'full',
            onChange: (e) => { setRl(e.target.value); patch({ reportLevel: e.target.value }, '日报详细程度') },
          },
            h('option', { value: 'full' }, '完整'),
            h('option', { value: 'brief' }, '简要'),
            h('option', { value: 'off' }, '不生成')))),

        /* ══ ⑦ 发布与互动 ══════════════════════════════════════════════
       * ⭐ 2026-10-20 合并：原来「自动发布评论」和「回复楼中楼」是两个独立开关，
       *   各带子项 = 4 个控件，但实际只有 3 种有意义的状态。改成三段式。
       *   （后端字段不变：replyToComments 仍然独立存在，只是 UI 把它归进一档） */
        h(Card, {
          title: '发布与互动',
          desc: '发布内容以你的账号身份发出。默认关闭，仅生成报告',
        },
          /* 四段式：关闭 / 圈地自萌 / 普通评论 / 普通评论 + 回楼中楼 */
          h(Row, {
            label: '评论模式',
            desc: `本轮会做：${deliverNow}`,
          }, h('select', {
            'data-bd-select': '', 'data-bd-w-md': '',
            value: sw('circleMode') ? 'circle' : (!sw('autoComment') ? 'off' : (sw('replyToComments') ? 'reply' : 'comment')),
            onChange: (e) => {
              const v = e.target.value
              if (v === 'off') patch({ autoComment: false, circleMode: false, replyToComments: false }, '评论行为')
              else if (v === 'circle') patch({ autoComment: false, circleMode: true, replyToComments: false }, '圈地自萌')
              else if (v === 'comment') patch({ autoComment: true, circleMode: false, replyToComments: false }, '评论行为')
              else patch({ autoComment: true, circleMode: false, replyToComments: true }, '评论行为')
            },
          },
            h('option', { value: 'off' }, '关闭 —— 只在报告里给出结论'),
            h('option', { value: 'circle' }, '圈地自萌 —— 只回 UP 邀请的楼中楼'),
            h('option', { value: 'comment' }, '普通评论 —— 在选中的视频下发布新楼'),
            h('option', { value: 'reply' }, '普通评论 + 回复楼中楼')
          )),

          (sw('autoComment') || sw('circleMode')) ? h('div', { 'data-bd-sub': '' },
            h(Row, {
              label: sw('circleMode') ? '每轮楼中楼上限' : '每轮评论上限',
              hint: `0 = 本轮不发 · 最多 ${commentCap} 条`,
            }, h('input', {
              'data-bd-input': '', 'data-bd-w-num': '', type: 'number', min: 0, max: commentCap,
              value: perRound ?? '',
              onChange: (e) => setPerRound(e.target.value),
              // ⭐ 0 是合法值（= 这一轮不发评论）
              // ⭐ 上限 = min(5, 每轮最多挑几条)：挑 3 条却允许发 5 条评论是不可能发生的事，
              //    评的就是挑中的那几条 —— 没东西可评。后端 clampPatch 也按同一条规矩钳一次。
              onBlur: () => { const n = Math.max(0, Math.min(Number(perRound) || 0, commentCap)); setPerRound(String(n)); patch({ commentPerRound: n }, '每轮评论上限') },
            })),
            sw('autoComment') ? h(Row, {
              label: '在评论里 @ 谁',
              desc: mention
                ? `当前：@${mention}${mentionUid ? '（UID ' + mentionUid + '）' : ''}`
                : '填 B站 UID，点「识别」自动带出昵称。留空则不发布评论',
            }, h('div', { 'data-bd-inline': '' },
              h('input', {
                'data-bd-input': '', 'data-bd-w-sm': '', type: 'number', min: 0,
                value: mentionUid ?? '', placeholder: 'B站 UID',
                onChange: (e) => setMentionUid(e.target.value),
                onBlur: () => {
                  const n = Math.max(0, Number(mentionUid) || 0)
                  setMentionUid(n ? String(n) : '')
                  patch({ mentionUid: n }, '被 @ 的 UID')
                },
              }),
              h('button', {
                'data-bd-btn': '', disabled: Boolean(mentionBusy),
                onClick: onResolveUid,
              }, mentionBusy ? '识别中…' : '识别')),
            ) : null,
          ) : null,

          sw('replyToComments') ? h('div', { 'data-bd-sub': '' },
            h(Row, {
              label: '每轮回复上限',
              hint: '只算回在本插件评论下的',
            }, h('input', {
              'data-bd-input': '', 'data-bd-w-num': '', type: 'number', min: 1, max: 10,
              value: replyPer ?? '',
              onChange: (e) => setReplyPer(e.target.value),
              onBlur: () => { const n = Math.max(1, Math.min(Number(replyPer) || 1, 10)); setReplyPer(String(n)); patch({ replyPerRound: n }, '每轮回复上限') },
            }))) : null,

          h(Divider),

          /* 私信：跟评论并列的独立开关 */
          h(Row, {
            label: '私信',
            hint: '另外私信给一个人',
          }, h(Switch, {
            on: Boolean(dmOn),
            onChange: (v) => { setDmOn(v); patch({ dmOn: v }, '私信') },
          })),
          dmOn ? h('div', { 'data-bd-sub': '' },
            h(Row, {
              label: '私信收件人 UID',
              desc: dmInfo?.name
                ? `已识别：${dmInfo.name}${dmInfo.level ? '（Lv' + dmInfo.level + '）' : ''}`
                : (dmInfo?.error ? '识别失败：' + dmInfo.error : '填 B站 UID，点「识别」确认发给谁'),
            }, h('div', { 'data-bd-inline': '' },
              h('input', {
                'data-bd-input': '', 'data-bd-w-sm': '', type: 'number', min: 0, value: dmUid ?? '',
                placeholder: 'UID',
                onChange: (e) => { setDmUid(e.target.value); setDmInfo(null) },
                onBlur: () => { const n = Math.max(0, Number(dmUid) || 0); setDmUid(n ? String(n) : ''); patch({ dmUid: n }, '私信收件人 UID') },
              }),
              h('button', {
                'data-bd-btn': '', disabled: dmBusy || !dmUid, onClick: onResolveDmUid,
              }, dmBusy ? '识别中…' : '识别'))),
            h('div', { 'data-bd-row-desc': '' },
              '私信内容为本轮各条的「标题 + 链接 + 一句话理由」，每轮合并为一条（不受 150 字限制）。'),
            h('div', { 'data-bd-row-desc': '' },
              '⚠️ 建议与收件人互相关注：B站 对陌生人私信设有频率限制，且可能不推送提醒。')) : null),

        /* ══ ⑦.5 守护评论区（骑士团） ═══════════════════════════════════
         * 用一个小号盯着自己视频的评论区：白名单里的人 @ 它（或在它视频下评论）时，
         * 自动以自己的身份回一条。
         * 字段名由宿主 schema 定死（guardOn / guardWhitelist / guardScope /
         * guardPerRound / guardPollMinutes / guardEmoji），这里只负责采集与保存。
         * 总开关关掉时，下面 5 项跟别处一样收进 data-bd-sub 里不显示。 */
        h(Card, {
          title: '守护评论区（骑士团）',
          desc: '用一个小号替你盯着评论区：你视频下有人说话，它替你回',
        },
          h('div', { 'data-bd-row-desc': '' },
            '用的是小号（骑士号）的登录态：它会以自己的身份回复，并说明是替你回的；不会动大号的评论/弹幕权限。'),
          h(SwitchRow, {
            label: '守护评论区',
            desc: '独立于「自动运行」；打开后按下面的频率扫评论，命中就自动回一条。关掉这里才会停止定时扫描',
            on: Boolean(guardOn),
            onChange: (v) => { setGuardOn(v); patch({ guardOn: v }, '守护评论区') },
          }),
          Boolean(guardOn) ? h('div', { 'data-bd-sub': '' },
            h(SwitchRow, {
              label: '我的视频下不用 @ 也回',
              desc: '开（默认）：你视频的评论区有人说话就回，纯水/广告跳过。关：只回白名单里的人',
              on: guardOwnAll !== false,
              onChange: (v) => { setGuardOwnAll(v); patch({ guardOwnAll: v }, '视频下不用@也回') },
            }),
            h(Row, {
              label: '每天最多回几条',
              desc: '默认 30，跨所有视频合计。填 0 = 不限（不建议）',
            }, h('input', {
              'data-bd-input': '', 'data-bd-w-num': '', type: 'number', min: 0, max: 500,
              value: guardDailyCap ?? '',
              onChange: (e) => setGuardDailyCap(e.target.value),
              onBlur: () => {
                const n = Math.max(0, Math.min(Number(guardDailyCap) || 0, 500))
                setGuardDailyCap(String(n))
                patch({ guardDailyCap: n }, '每天最多回几条')
              },
            })),
            h(StackRow, {
              label: '白名单 UID（只管别人视频下的 @）',
              desc: '只有这些人 @ 小号才回；留空 = 只认「在评论里 @ 谁」那个 UID。多个用逗号或空格隔开，例如 123456, 789012',
            }, h('input', {
              'data-bd-input': '', 'data-bd-w-full': '', type: 'text',
              placeholder: '留空 = 只认「要 @ 谁」那个 UID',
              value: guardWhitelist ?? '',
              onChange: (e) => setGuardWhitelist(e.target.value),
              onBlur: () => {
                const v = String(guardWhitelist ?? '').trim()
                setGuardWhitelist(v)
                patch({ guardWhitelist: v }, '白名单 UID')
              },
            })),
            h(Row, {
              label: '守最近几条视频',
              desc: '1 = 只守最新一条视频；调大会多扫几条，请求量也跟着涨',
            }, h('input', {
              'data-bd-input': '', 'data-bd-w-num': '', type: 'number', min: 1, max: 10,
              value: guardScope ?? '',
              onChange: (e) => setGuardScope(e.target.value),
              onBlur: () => {
                const n = Math.max(1, Math.min(Number(guardScope) || 1, 10))
                setGuardScope(String(n))
                patch({ guardScope: n }, '守最近几条视频')
              },
            })),
            h(Row, {
              label: '每轮最多回几条',
              desc: '默认 3。回得越多越像机器人，B站 对高频回复也有风控',
            }, h('input', {
              'data-bd-input': '', 'data-bd-w-num': '', type: 'number', min: 1, max: 20,
              value: guardPerRound ?? '',
              onChange: (e) => setGuardPerRound(e.target.value),
              onBlur: () => {
                /* 范围跟宿主 guardCfg() 的钳制口径一致（1–20），别在界面上悄悄改掉原生设置页填的值 */
                const n = Math.max(1, Math.min(Number(guardPerRound) || 3, 20))
                setGuardPerRound(String(n))
                patch({ guardPerRound: n }, '每轮最多回几条')
              },
            })),
            h(Row, {
              label: '多久扫一次',
              desc: '分钟。默认 3；调太小会一直请求评论区，容易触发风控',
            }, h('input', {
              'data-bd-input': '', 'data-bd-w-num': '', type: 'number', min: 1, max: 240,
              value: guardPoll ?? '',
              onChange: (e) => setGuardPoll(e.target.value),
              onBlur: () => {
                const n = Math.max(1, Math.min(Number(guardPoll) || 3, 240))
                setGuardPoll(String(n))
                patch({ guardPollMinutes: n }, '多久扫一次')
              },
            })),
            h(SwitchRow, {
              label: '回复末尾带表情',
              desc: '默认带一个，读起来更像真人；关掉就是纯文字',
              on: guardEmoji !== false,
              onChange: (v) => { setGuardEmoji(v); patch({ guardEmoji: v }, '回复带表情') },
            }),
            h(StackRow, {
              label: '守护口径（怎么说话）',
              desc: '写几句就行：你是做什么的、哪些能答、哪些不能提。比给每条视频写内容描述管用 —— 内容字幕里有，口径字幕里没有',
            }, h('textarea', {
              'data-bd-textarea': '', rows: 4,
              placeholder: '例：我是做安全运维的，复现细节可以答，但不给能直接利用的 POC；有人指出错误先承认再补充；公司/客户的事一律不提',
              value: guardTone ?? '',
              onChange: (e) => setGuardTone(e.target.value),
              onBlur: () => patch({ guardTone: String(guardTone ?? '') }, '守护口径'),
            }))) : null),

        /* ══ ⑦.6 守护记录 ═══════════════════════════════════════════ */
        guardOn ? h(Card, {
          title: '守护记录',
          desc: '扫到什么、判成什么、真发出去什么 —— 自动拿号说话，得能事后核对',
        },
          h('div', { 'data-bd-row-desc': '', style: { display: 'flex', gap: 12, alignItems: 'center' } },
            h('span', {}, guardLog
              ? `今天已回 ${guardLog?.daily?.count ?? 0} 条${guardLog?.dailyCap ? ` / 上限 ${guardLog.dailyCap}` : '（不限）'}`
              : '还没读到记录'),
            /* ⭐ 派出去但还没真发出去的（值班挂了/失败过），下一轮会自动补 —— 2026-10-22 用户实测要求能看见 */
            guardLog && guardLog.pending > 0
              ? h('span', { style: { color: '#b26a00' } }, `还有 ${guardLog.pending} 条没回出去，下一轮会补`)
              : null,
            h('button', {
              'data-bd-btn': '', type: 'button', disabled: guardLogBusy,
              onClick: loadGuardLog,
            }, guardLogBusy ? '读取中…' : '刷新')),
          h('div', { style: { marginTop: 8 } }, renderGuardLog())) : null,

        /* ══ ⑦.7 点赞与收藏 ══════════════════════════════════════════
         * 两者都是拿账号表态，默认关；额度按「每轮 / 每天」两级硬顶。
         * ⚠️ 0 是合法值（= 这一轮 / 今天不做），所以回填用 ?? 而不是 ||，
         *    失焦钳制也不许把 0 兜底成默认值。 */
        h(Card, {
          title: '点赞与收藏',
          desc: '打开后，它会在挑中的视频里按判据点赞 / 收藏（默认关）',
        },
          h(SwitchRow, {
            label: '点赞',
            hint: '读内容才决定，写不出理由就不点',
            on: sw('likeOn'),
            onChange: (v) => patch({ likeOn: v }, '点赞'),
          }),
          sw('likeOn') ? h('div', { 'data-bd-sub': '' },
            h(Pair, {},
              h(Row, {
                label: '每轮最多赞几条',
                hint: '0 = 这一轮不赞',
              }, h('input', {
                'data-bd-input': '', 'data-bd-w-num': '', type: 'number', min: 0, max: 5,
                value: likePerRound ?? '',
                onChange: (e) => setLikePerRound(e.target.value),
                onBlur: () => {
                  const n = Math.max(0, Math.min(Number(likePerRound) || 0, 5))
                  setLikePerRound(String(n))
                  patch({ likePerRound: n }, '每轮点赞上限')
                },
              })),
              h(Row, {
                label: '每天最多赞几条',
                hint: '硬顶 10 · 0 = 今天不赞',
              }, h('input', {
                'data-bd-input': '', 'data-bd-w-num': '', type: 'number', min: 0, max: 10,
                value: likePerDay ?? '',
                onChange: (e) => setLikePerDay(e.target.value),
                onBlur: () => {
                  const n = Math.max(0, Math.min(Number(likePerDay) || 0, 10))
                  setLikePerDay(String(n))
                  patch({ likePerDay: n }, '每天点赞上限')
                },
              }))),
            h(Row, {
              label: '判据档位',
              desc: LIKE_RULE_DESC[likeRule] || LIKE_RULE_DESC.standard,
            }, h('select', {
              'data-bd-select': '', 'data-bd-w-md': '', value: likeRule ?? 'standard',
              onChange: (e) => { setLikeRule(e.target.value); patch({ likeRule: e.target.value }, '点赞判据') },
            },
              h('option', { value: 'strict' }, '严格 —— 只赞有实操细节、本周用得上的，宁可不赞'),
              h('option', { value: 'standard' }, '标准 —— 默认，三条硬证据占两条才赞'),
              h('option', { value: 'loose' }, '宽松 —— 有点意思就赞，但仍受额度限制'))),
            h(StackRow, {
              label: '补充判据（选填）',
              desc: '最多 300 字。判据时跟上面的档位一起看；留空 = 只用档位',
            }, h('textarea', {
              'data-bd-textarea': '', rows: 3, maxLength: 300,
              placeholder: '你想加的判据，例如：不赞讲 AI 焦虑的视频',
              value: likeRuleExtra ?? '',
              onChange: (e) => setLikeRuleExtra(e.target.value),
              onBlur: () => {
                const v = String(likeRuleExtra ?? '').slice(0, 300)
                setLikeRuleExtra(v)
                patch({ likeRuleExtra: v }, '点赞补充判据')
              },
            }))) : null,

          h(Divider),

          h(SwitchRow, {
            label: '收藏',
            hint: '以后还会回来看才收',
            on: sw('favOn'),
            onChange: (v) => patch({ favOn: v }, '收藏'),
          }),
          sw('favOn') ? h('div', { 'data-bd-sub': '' },
            h(Row, {
              label: '每天最多收藏几条',
              hint: '硬顶 8 · 0 = 今天不收藏',
            }, h('input', {
              'data-bd-input': '', 'data-bd-w-num': '', type: 'number', min: 0, max: 8,
              value: favPerDay ?? '',
              onChange: (e) => setFavPerDay(e.target.value),
              onBlur: () => {
                const n = Math.max(0, Math.min(Number(favPerDay) || 0, 8))
                setFavPerDay(String(n))
                patch({ favPerDay: n }, '每天收藏上限')
              },
            }))) : null),

        /* ══ ⑧ 检索与上下文 ════════════════════════════════════════════ */
        h(Card, { title: '检索与上下文', desc: '决定检索范围与采用的设定来源' },
          h(StackRow, {
            label: '检索关键词',
            desc: '每行一个。留空时用内置的这几组：DeepSeek Harness、DSH 插件、dsh 教程、meow-memory、DeepSeek Harness 桌面端',
          }, h('textarea', {
            'data-bd-textarea': '', rows: 4,
            placeholder: '每行一个关键词（留空 = 用内置那 5 组）',
            value: kws ?? '',
            onChange: (e) => setKws(e.target.value),
            /* ⭐ 2026-10-25 用户定：这块不再有「保存」按钮，失焦就存（跟同页其它字段一致）。
             *    没改动就不发请求，免得点一下别处就多一次 POST。 */
            onBlur: () => {
              const list = String(kws ?? '').split('\n').map((s) => s.trim()).filter(Boolean)
              if (list.join('\n') === (cfg?.keywords || []).join('\n')) return
              patch({ keywords: list }, '检索关键词')
            },
          })),
          h(StackRow, {
            label: '工作区路径',
            desc: st.workspace
              ? (st.agentsFound
                ? `已读到 ${st.workspace}\\AGENTS.md（这一轮会用它的设定）`
                : `${st.workspace} 里没有 AGENTS.md —— 会按中性口吻输出，点下面「建模板」就能生成一份`)
              : '填一个含 AGENTS.md 的目录，运行时读它的设定；留空 = 不读设定、中性口吻。不知道怎么写？填好路径后点「建模板」',
          }, h('div', { 'data-bd-inline': '' },
            h('input', {
              'data-bd-input': '', 'data-bd-w-full': '', value: ws ?? '',
              placeholder: '例如 C:\\Users\\你\\my-workspace',
              onChange: (e) => setWs(e.target.value),
              onBlur: () => { patch({ workspace: String(ws ?? '').trim() }, '工作区路径') },
            }),
            h('button', {
              'data-bd-btn': '', disabled: busy === 'agents', onClick: onAgentsTemplate,
            }, busy === 'agents' ? '生成中…' : '建模板'))),
          /* ⭐ 2026-10-25 用户定：不要「保存」按钮了 —— 关键词、工作区都是失焦即存。
           *    这一行只留结果提示（建模板之类也会写到这里）。 */
          msg ? h('div', {
            'data-bd-msg': '', 'data-bd-msg-flex': '',
            'data-good': msgTone === 'good' ? '' : undefined,
            'data-warn': msgTone === 'warn' ? '' : undefined,
          }, msg) : null),

        /* ══ ⑨ 高级设置（可折叠） ═══════════════════════════════════════ */
        h('div', { 'data-bd-card': '', 'data-bd-wide': '' },
          h('button', {
            'data-bd-fold': '', 'data-open': advOpen ? '' : undefined,
            onClick: () => setAdv(!advOpen),
          },
            h(Chevron),
            '高级设置',
            advOpen ? null : h('span', { 'data-bd-fold-extra': '' }, '运行模型 · 语音转写 · 运行环境 · 数据目录')),

          /* ── 运行模型 ── */
          advOpen ? h('div', { 'data-bd-card-body': '' },
            (() => {
              const list = (models && models.providers) || []
              const profileName = (models && models.profile) || 'headless'
              const missing = list.filter((x) => x.usable === false && x.package)
              const fallback = list.find((x) => x.id === 'deepseek-account' && x.usable !== false)
              const cur = list.find((x) => x.id === (dutyProv || '')) || null
              const curModels = cur ? (cur.models || []) : []
              const provOpts = [h('option', { value: '', key: '__default' }, '跟随 headless 默认（推荐）')]
              for (const x of list) {
                /* ⭐ 四种状态要分清（2026-10-21）：
                 *    · 已激活（active）          —— 正常可选
                 *    · 声明了但没激活（active:false）—— 线路插件装了但适配器没注册，选它跑不起来，
                 *                                    所以置灰并说明原因，别让用户以为插件没识别到
                 *    · 值班 profile 里没有（usable === false）—— 那是另一个 profile 的问题，置灰
                 *    · `source === 'profile'`    —— 只在**值班那个 profile**里注册（比如 headless 只挂了
                 *                                    workbuddy 连接器）⇒ 桌面进程里当然列不出来，
                 *                                    但选它是**对的**，所以要可点、且标注清楚 */
                const onlyProfile = x.source === 'profile'
                const notActive = x.active === false && !onlyProfile
                const notInProfile = x.usable === false
                const suffix = onlyProfile
                  ? '（只在值班 profile 里 —— 可用）'
                  : notActive
                    ? '（未启用：线路插件没激活）'
                    : (notInProfile ? '（值班 profile 里没装）' : '')
                provOpts.push(h('option', {
                  key: x.id,
                  value: x.id,
                  disabled: notActive || notInProfile,
                }, x.name + suffix))
              }
              const modelOpts = [h('option', { value: '', key: '__lineDefault' }, '（使用线路默认）')]
              for (const m of curModels) {
                modelOpts.push(h('option', { key: m.id, value: m.id }, m.name !== m.id ? (m.name + ' · ' + m.id) : m.name))
              }
              return h('div', null,
                missing.length > 0 ? h('div', { 'data-bd-row-desc': '' },
                  '检测到 ' + missing.map((x) => x.name).join('、') + ' 只装在桌面配置里；鱼跑的是「' + profileName + '」。',
                  h('div', { 'data-bd-btns': '' },
                    h('button', {
                      'data-bd-btn': '',
                      disabled: busy === 'profile-add',
                      onClick: () => installToProfile(missing[0]),
                    }, busy === 'profile-add' ? '正在装…' : '装到 ' + profileName),
                    fallback ? h('button', {
                      'data-bd-btn': '',
                      onClick: () => {
                        setDutyProv(fallback.id)
                        setDutyModel('')
                        patch({ dutyProvider: fallback.id, dutyModel: '' }, '运行模型线路')
                      },
                    }, '改用 ' + fallback.name) : null),
                  profileMsg ? h('div', { 'data-bd-row-desc': '', style: { whiteSpace: 'pre-wrap' } }, profileMsg) : null)
                  : null,
                h(Row, {
                  label: '运行模型线路',
                  desc: (models && !models.profileKnown)
                    ? '未能读取运行 profile 的线路，可用性未知'
                    : '列表来自 DSH 声明的全部线路（含还没激活的）；不可用的会标注原因',
                }, h('select', {
                  'data-bd-select': '', 'data-bd-w-md': '', value: dutyProv ?? '',
                  onChange: (e) => {
                    const v = e.target.value
                    setDutyProv(v)
                    setDutyModel('')
                    patch({ dutyProvider: v, dutyModel: '' }, '运行模型线路')
                  },
                }, provOpts)),
                /* ⭐ 如果有线路声明了却没激活，直接说清楚为什么 —— 否则用户只会看到
                 *    "我明明装了 workbuddy，这里却没有"（2026-10-20 实测反馈） */
                (models && Array.isArray(models.providers) && models.providers.some((x) => x.active === false && x.source !== 'profile'))
                  ? h('div', { 'data-bd-row-desc': '' },
                      '有线路装了但没激活（标着「未启用」）：去「设置 → 模型/线路」把它启用，或检查它的配置；'
                      + '激活后这里就能直接选。')
                  : null,
                /* ⭐ 只在值班 profile 里注册的线路（如 headless 的 workbuddy）：
                 *    模型列表在**当前进程**里读不到 ⇒ 给一个手填框，填 id 就行（留空=用线路默认）。 */
                (dutyProv && cur && cur.source === 'profile')
                  ? h(Row, {
                      label: '具体模型',
                      desc: '这条线路只在值班 profile 里注册，模型列表读不到 —— 直接填模型 id（留空 = 用线路默认）',
                    }, h('input', {
                      'data-bd-input': '', 'data-bd-w-md': '', type: 'text',
                      placeholder: '例如 glm-5.3-flash',
                      value: dutyModel ?? '',
                      onChange: (e) => {
                        setDutyModel(e.target.value)
                        patch({ dutyModel: e.target.value }, '具体模型')
                      },
                    }))
                  : null,
                (dutyProv && curModels.length > 0)
                  ? h(Row, {
                      label: '具体模型',
                      desc: '留空则使用该线路的默认模型',
                    }, h('select', {
                      'data-bd-select': '', 'data-bd-w-md': '', value: dutyModel ?? '',
                      onChange: (e) => {
                        setDutyModel(e.target.value)
                        patch({ dutyModel: e.target.value }, '具体模型')
                      },
                    }, modelOpts))
                  : null,
                /* ⭐ 2026-10-21：这几条线路是**从你界面那份配置自动带进值班的**（--patch overlay），
                 *    说一句，否则用户不知道自己明明没在值班 profile 里装，为什么就能选了。 */
                (models && models.reuseRoutes !== false && Array.isArray(models.reusedRoutes) && models.reusedRoutes.length > 0)
                  ? h('div', { 'data-bd-row-desc': '' },
                      '这几条线路会自动带进值班那一轮（不用另装、也不用改配置）：' + models.reusedRoutes.join('、'))
                  : null,
                /* ⭐ 没带成的时候说清楚为什么（2026-10-21：Electron 宿主里拿不到 profile 路径，
                 *    功能静默失效过一次，用户只看到「还是不可以」） */
                (models && models.reuseRoutes !== false
                  && (!Array.isArray(models.reusedRoutes) || models.reusedRoutes.length === 0)
                  && models.routeProbe === 'none')
                  ? h('div', { 'data-bd-row-desc': '' },
                      '没能自动沿用你界面里的线路配置（补丁层：' + (models.routePatch || '没找到')
                      + '）—— 自定义线路想在值班里用，还得装到值班 profile 或手动加配置。')
                  : null,
                (models && models.ok === false)
                  ? h('div', { 'data-bd-row-desc': '' }, '无法读取模型列表：' + (models.error || ''))
                  : null,
                (models && models.profileError)
                  ? h('div', { 'data-bd-row-desc': '' }, '预检提示：' + models.profileError)
                  : null,
                /* ⭐ profile 里有 bundle 没起来（版本不兼容之类）时说人话 ——
                 *    否则表现就是「我装的线路一动不动」 */
                (models && Array.isArray(models.warnings) && models.warnings.length > 0)
                  ? h('div', { 'data-bd-row-desc': '' },
                      '值班 profile 里有插件没加载：' + models.warnings.join('；')
                      + '。修好之后它注册的线路才会真正能跑（多数情况是插件版本与当前 dsh 不匹配）。')
                  : null)
            })(),

            /* ── 语音转写 ── */
            h(Divider),
            h(SwitchRow, {
              label: '本地语音转写',
              desc: '对无字幕视频在本机执行 Whisper 转写，不产生 API 费用；需下载数百 MB 模型',
              on: sw('transcribe'),
              onChange: (v) => patch({ transcribe: v }, '本地语音转写'),
            }),
            sw('transcribe') ? h('div', { 'data-bd-sub': '' },
              h('div', { 'data-bd-btns': '' },
                h('button', { 'data-bd-btn': '', disabled: busy === 'asr', onClick: onInstallAsr },
                  st.asrReady ? '重装转写依赖' : '安装转写依赖')),
              h('div', { 'data-bd-row-desc': '' },
                !st.asrReady
                  ? '尚未安装 —— 当前开启无效：无字幕视频将被跳过（报告会记录「因无字幕跳过 N 条」）'
                  : (st.asrModelReady ? '环境与模型均已就绪' : '环境已就绪；模型将在首次转写时下载（数百 MB）')),
              h('div', { 'data-bd-row-desc': '' },
                '安装内容：独立环境 + faster-whisper + yt-dlp + Whisper 模型（默认 small，走国内镜像）'),
              h(LogFold, {
                label: st.asrInstalling ? '转写依赖安装进度' : '转写依赖日志',
                desc: st.asrInstalling ? '' : '（末尾 1400 字）',
                text: st.asrTail,
                open: asrLogOpen,
                onToggle: () => setAsrLogOpen((v) => !v),
              })) : null,

            /* ── 运行环境 ── */
            h(Divider),
            h(StackRow, {
              label: '运行环境与账号',
              desc: !st.venvReady
                ? (st.installFailed ? '上次安装失败，请查看下方日志' : '尚未安装，请先安装运行环境')
                : (st.loggedIn ? '环境与账号均已就绪' : '环境已就绪，请继续扫码登录'),
            }, h('div', { 'data-bd-btns': '' },
              h('button', { 'data-bd-btn': '', disabled: busy === 'install', onClick: onInstall },
                st.venvReady ? '重装主依赖' : '安装主依赖'),
              h('button', { 'data-bd-btn': '', disabled: busy === 'check', onClick: onCheck }, '连通性检测'),
              h('button', { 'data-bd-btn': '', disabled: busy === 'update', onClick: onCheckUpdate }, '检查更新'),
              h('button', { 'data-bd-btn': '', disabled: busy === 'login', onClick: onLoginStart }, '扫码登录'),
              (newVer && selfUpgrade) ? h('button', { 'data-bd-btn': '', 'data-primary': '', disabled: busy === 'upgrade', onClick: onUpgrade }, '升级到 v' + newVer) : null)),
            loginState ? h('div', {
              'data-bd-msg': '', 'data-bd-msg-gap': '',
              'data-good': loginTone === 'good' ? '' : undefined,
              'data-warn': loginTone === 'warn' ? '' : undefined,
            }, loginState) : null,
            login?.qr ? h('div', { 'data-bd-qr': '' },
              h('img', { src: login.qr, alt: 'B站登录二维码' }),
              h('div', { 'data-bd-qr-note': '' },
                '手机 B站 → 我的 → 扫一扫。',
                h('br'),
                '确认时请选择「记住我 / 长期」；选择 24 小时则次日需重新扫码。')) : null,
            h(LogFold, {
              label: st.installing ? '主依赖安装进度' : '主依赖日志',
              desc: st.installing ? '' : '（末尾 1400 字）',
              text: st.installTail,
              open: logOpen,
              onToggle: () => setLogOpen((v) => !v),
            }),

            /* ── 数据目录 ── */
            h(Divider),
            h(StackRow, { label: '数据目录' },
              h('div', { 'data-bd-kv': '' },
                h('b', null, '插件数据目录：'), st.home, h('br'),
                h('b', null, '今日报告：'), st.report),
              h('div', { 'data-bd-btns': '' },
                h('button', { 'data-bd-btn': '', disabled: busy === 'report', onClick: onShowReport },
                  report !== null ? '收起报告' : '查看今日报告'),
                h('button', { 'data-bd-btn': '', onClick: () => onOpenFolder('out') }, '打开报告目录'),
                h('button', { 'data-bd-btn': '', onClick: () => onOpenFolder('home') }, '打开数据目录'),
                h('button', { 'data-bd-btn': '', disabled: busy === 'verify', onClick: onVerify }, '复核评论'),
                h('button', { 'data-bd-btn': '', onClick: () => copyText(st.report) }, '复制报告路径')))) : null),

        /* ══ 页脚：作者 ═════════════════════════════════════════════════ */
        /* 只放事实：谁做的、去哪找他。不放推广、不放诱导、不放联系方式以外的任何东西。 */
        h('div', { 'data-bd-foot': '' },
          'B站鱼塘',
          h('span', { 'data-bd-foot-sep': '' }, '·'),
          '作者 ',
          h('a', {
            href: 'https://space.bilibili.com/14430149',
            target: '_blank',
            rel: 'noopener noreferrer',
            title: '在 B站 打开「变量探索SEQVEC」的主页',
          }, '@变量探索SEQVEC'),
          h('span', { 'data-bd-foot-sep': '' }, '·'),
          h('a', {
            href: 'https://github.com/YOYOLnFu/dsh-bili-pond',
            target: '_blank',
            rel: 'noopener noreferrer',
            title: '项目仓库（MIT）',
          }, 'GitHub')),
      )
    }

    /* ⭐⭐ 2026-10-23 大肥鱼整页（左上侧栏图标 + 主面板）
     * 宿主机制（cordis_inspect 查到的原文）：`sidebar.panellist` 是「Global panel icons.
     * Each list id addresses the matching main panel; the sidebar owns the button」，
     * `main` 是「Central panel selected by sidebar entry id」。
     * ⇒ 图标 id 与 main key 用同一个 POND_ID，点图标就切到整页，和「插件 / 市场 / 日程」平级。
     * ⚠️ 页面里的数据全部来自宿主 `/api/bili-pond/pond`，一处失败只让该块空着，不炸整页。 */
    const POND_ID = 'dsh-bili-pond'
    const POND_ICON = 'data:image/png;base64,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'
    let openPond = () => {}

    const POND_CSS = `
      .pond { display:flex; flex-direction:column; gap:12px; padding:16px 20px 26px; max-height:calc(100vh - 120px); box-sizing:border-box; overflow-y:auto; overflow-x:hidden; background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-primary); }
        /* ⭐ 1.3.9 真根因：.pond 是纵向 flex，子项默认可被压缩；.pond-card 的 overflow:hidden 让它的
           自动最小高度归零，被压到 509px，设置内容 1600+px 被静默裁掉（没有滚动条）。
           修法：.pond 的直接子卡片不裁剪、不压缩（flex:0 0 auto），内容撑开 .pond 由它统一滚动。 */
        .pond > .pond-card { overflow:visible; flex:0 0 auto; }
        /* 1.3.12：设置页按自己的容器宽度重排；这里只取消 max-width，不再维护第二套 grid 规则。 */
        .pond-settings [data-bd-page] { max-width:none; }
        /* 嵌进鱼塘页的设置页：外层 .pond 已经在滚，内层不再自己滚、不再另设高度（避免双层滚动条 + 被裁） */
        .pond [data-bd-page]{ max-height:none; overflow:visible; padding-right:0; }
      .pond {
        --bd-accent:#2563eb; --bd-accent-2:#1d4ed8;
        --bd-fg:var(--dsw-alias-label-primary); --bd-fg-2:var(--dsw-alias-label-secondary); --bd-fg-3:var(--dsw-alias-label-secondary);
        --bd-line:var(--dsw-alias-border-l1); --bd-line-2:var(--dsw-alias-border-l2);
        --bd-hover:var(--dsw-alias-bg-layer-2); --bd-surface:var(--dsw-alias-bg-layer-1); --bd-surface-2:var(--dsw-alias-bg-layer-2);
        --bd-ok:#2ea043; --bd-warn:#d29922; --bd-err:#f85149;
      }
      /* 按钮：底色/字色明确给足，不靠未定义变量 */
      .pond [data-bd-btn] { color:var(--bd-fg); background:transparent; border:1px solid var(--bd-line-2); border-radius:6px; height:32px; padding:0 12px; font-size:13px; font-family:inherit; cursor:pointer; }
      .pond [data-bd-btn]:hover { background:var(--bd-hover); border-color:var(--bd-fg-3); }
      .pond [data-bd-btn][data-primary] { background:var(--bd-accent); border-color:var(--bd-accent); color:#fff; }
      .pond [data-bd-btn][data-primary]:hover { background:var(--bd-accent-2); }
      .pond [data-bd-btn][disabled] { opacity:.45; cursor:not-allowed; }
      /* 选中态（Tab / 关键词 / 徽标）明确蓝底白字，原来用的是 brand-primary + #fff，碰上浅色主题就是白底白字 */
      .pond .pond-tab.on, .pond .pond-chip.on { background:var(--bd-accent); border-color:var(--bd-accent); color:#fff; }
      .pond * { box-sizing:border-box; }
      .pond-hero { display:flex; gap:14px; align-items:center; padding:14px 16px; border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-1); border-radius:12px; }
      .pond-hero > img { width:46px; height:46px; border-radius:11px; flex:none; }
      .pond-who { min-width:186px; flex:none; }
      .pond-who h1 { font-size:17px; margin:0 0 2px; letter-spacing:.4px; }
      .pond-who h1 span { font-size:11px; font-weight:400; color:var(--dsw-alias-label-tertiary); margin-left:6px; letter-spacing:0; }
      .pond-by { font-size:11px; color:var(--dsw-alias-label-tertiary); }
      .pond-by a { color:var(--dsw-alias-link); text-decoration:none; }
      .pond-by a:hover { text-decoration:underline; }
      .pond-lv { display:flex; align-items:center; gap:7px; font-size:11px; color:var(--dsw-alias-label-secondary); margin-top:6px; }
      .pond-lv .track { flex:1; height:5px; border-radius:3px; background:var(--dsw-alias-bg-layer-2); overflow:hidden; }
      .pond-lv .track b { display:block; height:100%; background:var(--dsw-alias-brand-primary); border-radius:3px; }
      .pond-say { flex:1; min-width:0; text-align:center; font-size:13px; line-height:1.6; color:var(--dsw-alias-label-secondary); }
      .pond-ava { width:52px; height:52px; border-radius:14px; object-fit:cover; flex:none; background:var(--dsw-alias-bg-layer-2); }
      .pond-meta { font-size:11px; line-height:1.6; color:var(--dsw-alias-label-tertiary); text-align:right; white-space:nowrap; }
      .pond-meta a { color:var(--dsw-alias-label-secondary); text-decoration:none; }
      .pond-meta a:hover { color:var(--dsw-alias-brand-primary); text-decoration:underline; }
      .pond-meta .pond-en { font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:10.5px; letter-spacing:.1px; }
      .pond-hero h1 { font-size:17px; margin:0; }
      .pond-say em { display:inline; margin-left:8px; white-space:nowrap; font-size:11px; font-style:normal; color:var(--dsw-alias-label-tertiary); }
      /* 大主页快捷开关：只放最常改的三类，详细项仍留在「设置」 */
      .pond-quick { display:flex; flex-wrap:wrap; align-items:center; gap:8px 14px; padding:9px 12px; border:1px solid var(--dsw-alias-border-l1); border-radius:10px; background:var(--dsw-alias-bg-layer-1); }
      .pond-quick-group { display:flex; align-items:center; gap:7px; min-width:0; }
      .pond-quick-k { font-size:11.5px; color:var(--dsw-alias-label-tertiary); white-space:nowrap; }
      .pond-quick-seg { display:inline-flex; border:1px solid var(--dsw-alias-border-l2); border-radius:7px; overflow:hidden; background:var(--dsw-alias-bg-layer-2); }
      .pond-quick-seg button { flex:0 0 auto; height:28px; padding:0 10px; border:0; border-left:1px solid var(--dsw-alias-border-l1); background:transparent; color:var(--dsw-alias-label-secondary); font:inherit; font-size:12px; cursor:pointer; white-space:nowrap; }
      .pond-quick-seg button:first-child { border-left:0; }
      .pond-quick-seg button.on { background:var(--bd-accent); color:#fff; }
      .pond-quick-seg button:hover:not([disabled]):not(.on) { background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-primary); }
      .pond-quick-seg button[disabled] { opacity:.5; cursor:wait; }
      .pond-quick-switches { gap:13px; }
      .pond-quick-sw { display:inline-flex; align-items:center; gap:6px; font-size:12px; color:var(--dsw-alias-label-secondary); white-space:nowrap; }
      .pond-quick-acts { display:flex; align-items:center; flex-wrap:wrap; gap:6px; margin-left:auto; }
      .pond-quick-acts [data-bd-btn] { height:28px; padding:0 10px; font-size:12px; }
      .pond-quick-more { height:28px; padding:0 9px; border:1px solid var(--dsw-alias-border-l2); border-radius:6px; background:transparent; color:var(--dsw-alias-label-secondary); font:inherit; font-size:12px; cursor:pointer; }
      .pond-quick-more:hover { background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-primary); }
      .pond-quick-toast {
        position:fixed; right:24px; bottom:24px; z-index:1000; max-width:min(360px, calc(100vw - 48px));
        padding:9px 14px; border:1px solid var(--dsw-alias-border-l2); border-radius:9px;
        background:var(--dsw-alias-bg-layer-1); box-shadow:0 10px 32px rgba(0,0,0,.20);
        font-size:12px; line-height:1.5; color:var(--dsw-alias-label-secondary);
        overflow-wrap:anywhere; pointer-events:none; animation:pond-toast-in .16s ease-out;
      }
      @keyframes pond-toast-in { from { opacity:0; transform:translateY(6px); } to { opacity:1; transform:translateY(0); } }
      .pond-quick-toast.warn { color:var(--dsw-alias-state-warn-primary); border-color:rgba(210,153,34,.55); }
      .pond-bind { flex:none; height:24px; padding:0 7px; border:1px solid var(--dsw-alias-border-l1); border-radius:999px; background:transparent; color:var(--dsw-alias-label-tertiary); font:inherit; font-size:10.5px; white-space:nowrap; cursor:pointer; }
      .pond-bind.ok { color:var(--dsw-alias-state-success-primary); border-color:rgba(46,160,67,.45); }
      .pond-bind.warn { color:var(--dsw-alias-state-warn-primary); border-color:rgba(210,153,34,.50); }
      .pond-quick-stats { display:flex; flex-wrap:wrap; align-items:center; gap:3px 12px; min-width:0; font-size:11.5px; line-height:1.5; color:var(--dsw-alias-label-secondary); }
      .pond-quick-stats b { color:var(--dsw-alias-label-primary); font-weight:600; }
      /* 发光：悬停/按下/聚焦时加一圈蓝光（底色已在上面的调色板里给足） */
      .pond [data-bd-btn] { transition:box-shadow .16s ease, background .12s ease, border-color .12s ease; }
      .pond [data-bd-btn]:hover { box-shadow:0 0 0 2px rgba(37,99,235,.34), 0 0 16px rgba(37,99,235,.40) !important; }
      .pond [data-bd-btn]:active { box-shadow:0 0 0 3px rgba(37,99,235,.50), 0 0 22px rgba(37,99,235,.55) !important; }
      .pond [data-bd-btn]:focus-visible { outline:none; box-shadow:0 0 0 2px rgba(37,99,235,.46), 0 0 16px rgba(37,99,235,.38) !important; }
      .pond [data-bd-btn][disabled] { box-shadow:none; cursor:not-allowed; }
      .pond-tabs { display:flex; gap:8px; }
      .pond-tab { padding:5px 14px; border-radius:999px; font-size:12.5px; cursor:pointer; border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-secondary); }
      .pond-tab.on { background:var(--dsw-alias-brand-primary); border-color:var(--dsw-alias-brand-primary); color:#fff; }
      .pond-cols { display:grid; grid-template-columns:minmax(0,1fr) 300px; gap:12px; align-items:start; }
      .pond-card { border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-1); border-radius:12px; padding:12px 14px; min-width:0; overflow:hidden; }
      .pond-card h2 { font-size:12px; letter-spacing:.5px; color:var(--dsw-alias-label-tertiary); margin:0 0 8px; font-weight:600; }
      .pond-top { display:grid; grid-template-columns:minmax(0,190px) minmax(0,1fr); gap:14px; }
      .pond-donut { display:flex; flex-direction:column; gap:7px; font-size:11.5px; color:var(--dsw-alias-label-secondary); min-width:0; }
      .pond-donut .lg { display:flex; gap:6px; align-items:center; white-space:nowrap; overflow:hidden; }
      .pond-donut .lg i { width:8px; height:8px; border-radius:2px; flex:none; }
      .pond-donut .lg span { overflow:hidden; text-overflow:ellipsis; }
      .pond-nums { display:flex; justify-content:space-between; gap:10px; text-align:center; font-size:11px; color:var(--dsw-alias-label-tertiary); }
      .pond-nums b { display:block; font-size:17px; color:var(--dsw-alias-label-primary); font-weight:600; }
      .pond-bars { display:flex; gap:8px; align-items:flex-end; border-top:1px solid var(--dsw-alias-border-l1); padding-top:8px; margin-top:8px; }
      .pond-bar { flex:1; display:flex; flex-direction:column; align-items:center; gap:3px; font-size:10px; color:var(--dsw-alias-label-tertiary); }
      .pond-bar i { width:100%; max-width:24px; border-radius:3px; background:var(--dsw-alias-border-l2); display:block; }
      .pond-bar.now i { background:var(--dsw-alias-brand-primary); }
      .pond-kw { display:flex; flex-wrap:wrap; gap:6px; max-height:62px; overflow-y:auto; margin-top:10px; }
      .pond-chip { padding:3px 10px; border-radius:999px; font-size:12px; border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-secondary); cursor:pointer; }
      .pond-chip.on { background:var(--dsw-alias-brand-primary); border-color:var(--dsw-alias-brand-primary); color:#fff; }
      .pond-day { border-top:1px solid var(--dsw-alias-border-l1); margin-top:12px; }
      .pond-day > button { width:100%; display:flex; align-items:center; gap:9px; background:none; border:0; color:inherit; cursor:pointer; padding:9px 2px; font-size:13px; font-family:inherit; }
      .pond-day > button .m { color:var(--dsw-alias-label-tertiary); font-size:11.5px; }
      .pond-day > button .c { margin-left:auto; color:var(--dsw-alias-label-tertiary); font-size:11.5px; }
      .pond-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(200px,1fr)); gap:11px; padding:2px 0 10px; }
      .pond-v { border:1px solid var(--dsw-alias-border-l1); border-radius:10px; overflow:hidden; background:var(--dsw-alias-bg-layer-2); cursor:pointer; transition:border-color .14s ease; }
      .pond-v:hover { border-color:var(--dsw-alias-border-l2); }
      /* 已赞角标：跟 .tag / .dur 同一套观感；上膛后再点才真撤销 */
      .pond-v .liked { position:absolute; left:5px; bottom:5px; border:0; font-family:inherit; font-size:10.5px; line-height:16px; padding:1px 7px; border-radius:999px; background:rgba(37,99,235,.9); color:#fff; cursor:pointer; }
      .pond-v .liked.arm { background:rgba(210,153,34,.95); }
      .pond-v .liked[disabled] { opacity:.6; cursor:wait; }
      .pond-v .th { position:relative; aspect-ratio:16/10; background:var(--dsw-alias-bg-layer-1); }
      .pond-v .th img { width:100%; height:100%; object-fit:cover; display:block; }
      .pond-v .dur { position:absolute; right:5px; bottom:5px; background:rgba(0,0,0,.72); color:#fff; font-size:10.5px; padding:1px 5px; border-radius:4px; }
      .pond-v .tag { position:absolute; left:5px; right:5px; top:5px; font-size:10.5px; padding:2px 7px; border-radius:999px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; background:rgba(30,38,50,.85); color:#dbe3ef; }
      .pond-v .tag.p { background:rgba(37,99,235,.9); color:#fff; }
      .pond-v h3 { font-size:12.5px; line-height:1.45; margin:8px 9px 5px; height:36px; overflow:hidden; font-weight:500; }
      .pond-v p { display:flex; gap:7px; margin:0 9px 9px; font-size:11px; color:var(--dsw-alias-label-tertiary); white-space:nowrap; overflow:hidden; }
      .pond-list { font-size:12px; color:var(--dsw-alias-label-secondary); }
      .pond-list.cap { max-height:166px; overflow:hidden; }
      .pond-list.cap.open { max-height:none; }
      .pond-sh { display:flex; align-items:center; gap:8px; }
      .pond-sh h2 { margin:0 0 6px; }
      .pond-more { margin-left:auto; font-size:11px; color:var(--dsw-alias-link); cursor:pointer; margin-bottom:6px; }
      .pond-list > div { padding:5px 0; border-bottom:1px dashed var(--dsw-alias-border-l1); }
      .pond-list > div:last-child { border-bottom:0; }
      .pond-row { display:flex; gap:7px; align-items:baseline; white-space:nowrap; overflow:hidden; }
      .pond-row .q { flex:1 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; }
      .pond-ok { color:var(--dsw-alias-state-success-primary); }
      .pond-bad { color:var(--dsw-alias-state-error-primary); }
      .pond-empty { color:var(--dsw-alias-label-tertiary); font-size:12px; padding:8px 0; }
      .pond-diary { white-space:pre-wrap; font-size:13px; line-height:1.85; color:var(--dsw-alias-label-secondary); }
      .pond-foot { padding:6px 2px 0; font-size:11px; color:var(--dsw-alias-label-tertiary); }
      @media (max-width:1080px) { .pond-cols { grid-template-columns:minmax(0,1fr); } .pond-top { grid-template-columns:minmax(0,1fr); } }
      @media (max-width:760px) { .pond-quick-group, .pond-quick-acts, .pond-quick-stats { width:100%; } .pond-quick-acts { margin-left:0; } .pond-quick-acts [data-bd-btn], .pond-quick-more { flex:1 1 auto; } .pond-quick-seg { flex:1 1 auto; } .pond-quick-seg button { flex:1 0 auto; } }
    `

    const pondDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    const pondMmss = (s) => (!s ? '' : `${Math.floor(Number(s) / 60)}:${String(Number(s) % 60).padStart(2, '0')}`)
    const pondTime = (ts) => new Date(Number(ts)).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
    const POND_COLORS = ['#2563eb', '#7c3aed', '#0d9488', '#d97706', '#db2777', '#0891b2']

    function PondIcon({ size = 20, active }) {
      return h('img', {
        src: POND_ICON, alt: 'B站鱼塘', width: size, height: size,
        style: { borderRadius: Math.round(size / 4), display: 'block', opacity: active ? 1 : 0.85 },
      })
    }

    function PondPage() {
      const [data, setData] = React.useState(null)
      const [tab, setTab] = React.useState('history')
      const [kw, setKw] = React.useState('全部')
      const [busy, setBusy] = React.useState(false)
      const [running, setRunning] = React.useState(false)
      const [finalizing, setFinalizing] = React.useState(false)
      const [runElapsed, setRunElapsed] = React.useState(0)
      const [fold, setFold] = React.useState({})
      const [err, setErr] = React.useState('')
      const [quickBusy, setQuickBusy] = React.useState('')
      const [quickMsg, setQuickMsg] = React.useState(null)
      const [quickCommentMode, setQuickCommentMode] = React.useState(null)
      const [likes, setLikes] = React.useState(null)     // GET /likes：今日计数 + 明细（角标就靠它）
      const [undoArm, setUndoArm] = React.useState('')   // 已「上膛」待二次确认的 bvid
      const [undoBusy, setUndoBusy] = React.useState('')
      const runLock = React.useRef(false)
      const quickLock = React.useRef(false)

      const loadLikes = React.useCallback(async () => {
        try {
          const r = await jget('/likes')
          if (r && r.ok !== false) setLikes(r)
        } catch { /* 拿不到就下次再问，不炸面板 */ }
      }, [])

      /* 跟 /pond 一起刷新：跑完一轮后点赞计数和角标都该跟着变，不该等第二次手动刷新 */
      const load = React.useCallback(async () => {
        try {
          const r = await jget('/pond?limit=120')
          if (r && r.ok !== false) { setData(r); setErr('') }
        } catch (e) { setErr(String(e && e.message ? e.message : e)) }
        await loadLikes()
      }, [loadLikes])

      const syncRun = React.useCallback(async () => {
        try {
          const s = await jget('/status')
          const state = {
            running: Boolean(s && s.running),
            finalizing: Boolean(s && s.finalizing),
          }
          setRunning(state.running)
          setFinalizing(state.finalizing)
          setRunElapsed(Number(s && s.runElapsedSec) || 0)
          return state
        } catch { return null }
      }, [])

      React.useEffect(() => {
        load()
        syncRun()
        const id = setInterval(() => { load(); syncRun() }, 30000)
        return () => clearInterval(id)
      }, [load, syncRun])

      // 从设置页切回大主页时立刻重拉一次：设置页里可能刚绑定 UID、改了开关或启动了一轮。
      // 只 syncRun 不够，首页的 data.config 会一直停在进入设置页前的旧快照。
      React.useEffect(() => {
        if (tab !== 'history') return
        setQuickCommentMode(null)
        load()
        syncRun()
      }, [tab, load, syncRun])

      // 快捷保存提示只短暂出现，避免常驻文字把控制条撑得不稳定。
      React.useEffect(() => {
        if (!quickMsg) return
        const t = setTimeout(() => setQuickMsg(null), quickMsg.tone === 'warn' ? 8000 : 2500)
        return () => clearTimeout(t)
      }, [quickMsg])

      /* 运行中每 2 秒问一次；子进程退出后还有一个 finalizing（写历史 / 补封面）阶段，
         必须等它也为 false 再拉 /pond，否则封面墙会读到旧文件，只能靠手动刷新。 */
      React.useEffect(() => {
        if (!running && !finalizing) return
        let alive = true
        const tick = async () => {
          try {
            const s = await jget('/status')
            if (!alive) return
            const on = Boolean(s && s.running)
            const fin = Boolean(s && s.finalizing)
            setRunElapsed(Number(s && s.runElapsedSec) || 0)
            setRunning(on)
            setFinalizing(fin)
            if (!on && !fin) await load()
          } catch { /* 下一次再问 */ }
        }
        tick()
        const id = setInterval(tick, 2000)
        return () => { alive = false; clearInterval(id) }
      }, [running, finalizing, load])

      const run = async () => {
        if (runLock.current || running || finalizing) return
        runLock.current = true
        setBusy(true)
        setErr('')
        try {
          const r = await jpost('/run', {})
          if (r && (r.started || r.busy)) {
            setRunning(Boolean(r.started))
            setFinalizing(Boolean(r.busy && !r.started))
            setRunElapsed(Number(r.elapsedSec) || 0)
            const synced = await syncRun()
            if (synced && !synced.running && !synced.finalizing) await load()
          } else {
            setErr(String((r && r.error) || '这一轮没有启动'))
            await syncRun()
          }
          await load()
        } catch (e) {
          setErr(String(e && e.message ? e.message : e))
          await syncRun()
        } finally {
          runLock.current = false
          setBusy(false)
        }
      }

      /* 首页快捷保存：先乐观更新，失败时回滚并重新拉一次真配置。 */
      const quickSave = async (patch, what) => {
        if (quickBusy || quickLock.current) return
        quickLock.current = true
        const previous = (data && data.config) || {}
        setQuickBusy(what)
        setQuickMsg({ text: what + '：保存中…', tone: '' })
        setData((prev) => prev ? { ...prev, config: { ...(prev.config || {}), ...patch } } : prev)
        try {
          const r = await jpost('/config', patch)
          if (!r || r.ok === false) throw new Error((r && r.error) || '接口没有返回成功')
          // 意图 patch 放最后：宿主回包若还是旧快照，也不能把刚点下的模式视觉回滚。
          setData((prev) => prev ? { ...prev, config: { ...(prev.config || {}), ...(r.config || {}), ...patch } } : prev)
          if (r.host && r.host.ok === false && !r.host.noForm) {
            setQuickMsg({ text: what + '：已保存到插件，但同步到 DSH 设置失败（' + r.host.error + '）', tone: 'warn' })
          } else {
            setQuickMsg({ text: what + '：已更新', tone: 'ok' })
          }
          return true
        } catch (e) {
          setData((prev) => prev ? { ...prev, config: previous } : prev)
          setQuickMsg({ text: what + '没保存：' + String(e && e.message ? e.message : e), tone: 'warn' })
          await load()
          return false
        } finally {
          quickLock.current = false
          setQuickBusy('')
        }
      }

      /* 撤销点赞：第一次点只「上膛」，第二次才真发请求 —— 点一下就撤掉账号上的表态太容易误触 */
      const onUndoLike = async (bvid) => {
        if (!bvid || undoBusy) return
        if (undoArm !== bvid) { setUndoArm(bvid); return }
        setUndoArm('')
        setUndoBusy(bvid)
        try {
          const r = await jpost('/likes/undo', { bvid, kind: 'like' })
          if (!r || r.ok === false) setQuickMsg({ text: '撤销失败：' + ((r && r.error) || '未知原因'), tone: 'warn' })
          else setQuickMsg({ text: '已撤销这条点赞', tone: 'ok' })
        } catch (e) {
          setQuickMsg({ text: '撤销失败：' + String(e && e.message ? e.message : e), tone: 'warn' })
        } finally {
          setUndoBusy('')
          await loadLikes()
        }
      }

      const d = data || {}
      const st = d.stats || { xp: 0, level: 1, step: 200, xpIn: 0, days: 0, items: 0, picked: 0, replies: 0, keywords: [], week: [] }
      const items = d.items || []
      const daily = d.daily || { count: 0, cap: 0 }
      const qcfg = d.config || {}
      const savedCommentMode = qcfg.circleMode ? 'circle' : (qcfg.autoComment ? 'comment' : 'off')
      const commentMode = quickCommentMode || savedCommentMode
      const mentionReady = Boolean(qcfg.mentionName || Number(qcfg.mentionUid) > 0)
      const dmReady = Number(qcfg.dmUid) > 0
      /* 只有 undone:false 的才算「已赞」—— 撤销过的就不再显示角标 */
      const likedMap = {}
      for (const it of ((likes && likes.like && likes.like.items) || [])) {
        if (it && it.bvid && !it.undone) likedMap[it.bvid] = it
      }
    const fmtTok = (n) => n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n || 0)
      const kws = [{ k: '全部', n: items.length }].concat(st.keywords || [])
      const kwOf = (e) => (e.keywords && e.keywords.length ? e.keywords : ['未标'])
      const shown = kw === '全部' ? items : items.filter((e) => kwOf(e).indexOf(kw) >= 0)

      const today = pondDay(new Date())
      const yest = pondDay(new Date(Date.now() - 86400000))
      const weekAgo = pondDay(new Date(Date.now() - 7 * 86400000))
      const bucket = (date) => (date >= today ? '今天' : date === yest ? '昨天' : date >= weekAgo ? '本周' : '更早')
      const groups = ['今天', '昨天', '本周', '更早']
        .map((g) => ({ g, list: shown.filter((e) => bucket(e.date) === g) }))
        .filter((x) => x.list.length)
      const firstOpen = groups.length ? groups[0].g : ''

      const dayBar = (st.week || []).map((w, i) => {
        const max = Math.max(1, ...(st.week || []).map((x) => x.n))
        return h('div', { key: 'b' + i, className: 'pond-bar' + (w.date === today ? ' now' : ''), title: `${w.date} · ${w.n} 条` }, [
          h('i', { key: 'i', style: { height: Math.max(3, Math.round((w.n / max) * 34)) } }),
          h('span', { key: 's' }, w.date.slice(8)),
        ])
      })

      /* 饼图最多显示 5 块：前 4 个关键词 + 其他。关键词一多就把扇区切得太碎，
         既看不清，百分比也会给人一种“没占满”的错觉。完整关键词仍由下面那排筛选。 */
      const keywordStats = st.keywords || []
      const restKeywordCount = keywordStats.slice(4).reduce((a, x) => a + x.n, 0)
      const donutParts = keywordStats.slice(0, 4).map((x) => ({ ...x }))
      if (restKeywordCount > 0) donutParts.push({ k: '其他', n: restKeywordCount, rest: true })
      const donutTotal = Math.max(1, donutParts.reduce((a, x) => a + x.n, 0))
      let acc = 0
      const donutStops = donutParts.map((x, i) => {
        const from = acc / donutTotal * 360
        acc += x.n
        const to = acc / donutTotal * 360
        return `${POND_COLORS[i % POND_COLORS.length]} ${from}deg ${to}deg`
      })
      const donutBg = donutStops.length ? `conic-gradient(${donutStops.join(',')})` : 'var(--dsw-alias-bg-layer-2)'

      /* 封面墙 / 历史卡：点卡片 = 用系统默认浏览器打开这条视频（桌面宿主只接 target=_blank 的 https）。
       * ⚠️ 点开 ≠ 表态：这里不调任何点赞接口。 */
      const card = (e) => {
        const lk = likedMap[e.bvid]
        const armed = undoArm === e.bvid
        return h('article', {
          key: e.date + '|' + e.bvid,
          className: 'pond-v',
          title: '点击用默认浏览器打开这条视频',
          onClick: () => {
            window.open('https://www.bilibili.com/video/' + e.bvid, '_blank', 'noopener,noreferrer')
          },
        }, [
          h('div', { key: 'th', className: 'th' }, [
            e.pic ? h('img', { key: 'img', src: e.pic + '@480w_300h_1c.webp', alt: '', referrerPolicy: 'no-referrer', loading: 'lazy' }) : null,
            e.duration ? h('span', { key: 'd', className: 'dur' }, pondMmss(e.duration)) : null,
            h('span', {
              key: 't', className: 'tag' + (e.picked ? ' p' : ''),
              title: e.picked ? '已归档' : '跳过 · ' + (e.skipReason || '其他'),
            }, e.picked ? '已归档' + (e.replyCount ? ' · 回过 ' + e.replyCount : '') : '跳过 · ' + (e.skipReason || '其他')),
            /* 已赞角标：点一下「上膛」，再点一下才真撤销；鼠标移开就撤掉上膛态 */
            lk ? h('button', {
              key: 'lk', type: 'button',
              className: 'liked' + (armed ? ' arm' : ''),
              disabled: undoBusy === e.bvid,
              title: armed ? '再点一次就撤销这条点赞' : '这条点过赞，点这里可以撤销',
              onClick: (ev) => { ev.stopPropagation(); onUndoLike(e.bvid) },
              onMouseLeave: () => { if (armed) setUndoArm('') },
            }, armed ? '撤销？' : '已赞 ✓') : null,
          ]),
          h('h3', { key: 'h', title: e.title || e.bvid }, e.title || e.bvid),
          h('p', { key: 'm' }, [
            h('span', { key: 'u' }, e.owner || '—'),
            h('span', { key: 'd' }, String(e.date || '').slice(5).replace('-', '/')),
            e.views ? h('span', { key: 'v' }, (Number(e.views) / 10000).toFixed(1) + '万') : null,
          ]),
        ])
      }

      const dayGroups = groups.map((grp) => {
        const open = fold[grp.g] === undefined ? grp.g === firstOpen : !!fold[grp.g]
        const replied = grp.list.filter((e) => e.replyCount > 0).length
        return h('div', { key: grp.g, className: 'pond-day' }, [
          h('button', { key: 'b', onClick: () => setFold(Object.assign({}, fold, { [grp.g]: !open })) }, [
            h('span', { key: 'g' }, grp.g),
            h('span', { key: 'm', className: 'm' }, grp.list.length + ' 条' + (replied ? ' · 回过 ' + replied : '')),
            h('span', { key: 'c', className: 'c' }, open ? '收起 ⌃' : '展开 ⌄'),
          ]),
          open ? h('div', { key: 'grid', className: 'pond-grid' }, grp.list.map(card)) : null,
        ])
      })

      const sideLog = (d.scans || []).map((s, i) => h('div', { key: 's' + i }, [
        h('span', { key: 't', style: { color: 'var(--dsw-alias-label-tertiary)' } }, pondTime(s.ts) + ' '),
        '扫 ' + (s.comments || 0) + ' 条 → 派 ' + (s.queued || 0) + ' 条',
      ]))

      const sideReply = (d.replies || []).map((r, i) => h('div', { key: 'r' + i }, h('div', { className: 'pond-row' }, [
        h('span', { key: 't', style: { color: 'var(--dsw-alias-label-tertiary)' } }, pondTime(r.ts)),
        h('span', { key: 'q', className: 'q' }, (r.uname || '某人') + '「' + String(r.quote || '').slice(0, 24) + '」'),
        h('span', { key: 'k', className: r.ok ? 'pond-ok' : 'pond-bad' }, r.ok ? '✓' : '✗'),
      ])))

      const memoryList = (d.memory || []).length
        ? (d.memory || []).slice(-12).reverse().map((m, i) => h('div', { key: 'm' + i }, [
          h('div', null, m.t || m.text || ''),
          h('div', { style: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 10.5, fontFamily: 'ui-monospace,monospace' } }, (m.d || m.date || '') + ' · ' + (m.bv || m.bvid || '')),
        ]))
        : h('div', { className: 'pond-empty' }, '还没有记住什么。等值班轮跑完、日报写出来，这里会慢慢攒起来。')

      /* 右侧三块记录：默认限高，条数多时给「展开」，避免把右栏拉得比左栏长一大截 */
      const sideBlock = (key, title, rows, empty) => {
        const k = 'side:' + key
        const open = !!fold[k]
        const has = rows && rows.length
        return h('div', { key }, [
          h('div', { key: 'h', className: 'pond-sh' }, [
            h('h2', { key: 't' }, title),
            has ? h('span', { key: 'x', className: 'pond-more', onClick: () => setFold(Object.assign({}, fold, { [k]: !open })) }, open ? '收起' : '展开') : null,
          ]),
          h('div', { key: 'l', className: 'pond-list cap' + (open ? ' open' : '') }, has ? rows : h('div', { className: 'pond-empty' }, empty)),
        ])
      }

      const diaryText = (d.diary && d.diary.text) || ''
      const settingsTab = h('div', { className: 'pond-card pond-settings' }, h(Panel, {
        layout: 'embedded',
        onConfigChanged: (p) => setData((prev) => prev ? { ...prev, config: { ...(prev.config || {}), ...p } } : prev),
      }))

      const historyTab = h('div', { className: 'pond-cols' }, [
        h('div', { key: 'l', style: { display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 } }, [
          h('div', { key: 'top', className: 'pond-card' }, [
            h('div', { key: 'tp', className: 'pond-top' }, [
              h('div', { key: 'dn', className: 'pond-donut' }, [
                h('div', { key: 'c', style: { display: 'flex', gap: 10, alignItems: 'center' } }, [
                  h('div', {
                    key: 'ring',
                    style: {
                      width: 74, height: 74, borderRadius: '50%', background: donutBg, flex: 'none',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                    },
                  }, h('div', {
                    style: {
                      width: 54, height: 54, borderRadius: '50%', background: 'var(--dsw-alias-bg-layer-1)',
                      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                      fontSize: 15, fontWeight: 600, color: 'var(--dsw-alias-label-primary)',
                    },
                  }, [h('span', { key: 'n' }, String(items.length)), h('span', { key: 'l', style: { fontSize: 9.5, fontWeight: 400, color: 'var(--dsw-alias-label-tertiary)' } }, '看过')])),
                ]),
                h('div', { key: 'lg', style: { display: 'flex', flexDirection: 'column', gap: 4 } }, donutParts.map((x, i) => h('div', {
                  key: 'k' + i, className: 'lg', title: x.k + ' · ' + x.n + ' 条',
                }, [
                  h('i', { key: 'i', style: { background: POND_COLORS[i % POND_COLORS.length] } }),
                  h('span', { key: 's' }, x.k + ' ' + Math.round((x.n / donutTotal) * 100) + '%'),
                ]))),
              ]),
              h('div', { key: 'rt', style: { minWidth: 0 } }, [
                h('div', { key: 'nums', className: 'pond-nums' }, [
                  h('div', { key: 'p' }, [h('b', { key: 'b' }, String(st.picked || 0)), h('span', { key: 's' }, '挑中')]),
                  h('div', { key: 'k' }, [h('b', { key: 'b' }, String((st.items || 0) - (st.picked || 0))), h('span', { key: 's' }, '跳过')]),
                  h('div', { key: 'r' }, [h('b', { key: 'b' }, String(st.replies || 0)), h('span', { key: 's' }, '回过')]),
                  h('div', { key: 'd' }, [h('b', { key: 'b' }, String(st.days || 0)), h('span', { key: 's' }, '天')]),
                ]),
                h('div', { key: 'bars', className: 'pond-bars' }, dayBar),
              ]),
            ]),
            h('div', { key: 'kw', className: 'pond-kw' }, kws.map((x, i) => h('span', {
              key: 'c' + i, className: 'pond-chip' + (kw === x.k ? ' on' : ''),
              onClick: () => setKw(x.k),
            }, x.k + ' ' + x.n))),
            /* 今日表态小统计：跟卡片角标同一份 /likes 数据；收藏没开且今天没收藏过就不显示 */
            likes ? h('div', { key: 'lk', className: 'pond-quick-stats', style: { marginTop: 8 } }, [
              h('span', { key: 'a' }, ['今天已赞 ', h('b', null, String(Number(likes?.like?.today) || 0) + '/' + String(Number(likes?.like?.perDay) || 0))]),
              (qcfg.favOn || (Number(likes?.fav?.today) || 0) > 0)
                ? h('span', { key: 'b' }, ['已收藏 ', h('b', null, String(Number(likes?.fav?.today) || 0) + '/' + String(Number(likes?.fav?.perDay) || 0))])
                : null,
            ]) : null,
          ]),
          h('div', { key: 'days', className: 'pond-card', style: { paddingTop: 4 } }, dayGroups.length ? dayGroups : h('div', { className: 'pond-empty' }, '还没有历史记录。跑一轮值班，这里就会出现封面墙。')),
        ]),
        h('div', { key: 'r', className: 'pond-card', style: { display: 'flex', flexDirection: 'column', gap: 14 } }, [
          sideBlock('log', '守护记录', sideLog, '还没扫过'),
          sideBlock('reply', '回复记录', sideReply, '还没有回复记录'),
          sideBlock('mem', '鱼记得', (d.memory || []).length ? memoryList : null, '还没记住什么'),
        ]),
      ])

      const memoryTab = h('div', { className: 'pond-card' }, [
        h('h2', { key: 'h' }, '鱼记得'),
        h('div', { key: 'l', className: 'pond-list' }, memoryList),
      ])

      const diaryTab = h('div', { className: 'pond-card' }, [
        h('h2', { key: 'h' }, '日记 · ' + ((d.diary && d.diary.date) || today)),
        diaryText ? h('div', { key: 't', className: 'pond-diary' }, diaryText) : h('div', { key: 'e', className: 'pond-empty' }, '今天还没写。等这一天结束，鱼会自己写一篇。'),
      ])

      const tabBar = h('div', { className: 'pond-tabs' }, [
        ['history', '历史'], ['memory', '记忆'], ['diary', '日记'], ['settings', '设置'],
      ].map((t) => h('span', { key: t[0], className: 'pond-tab' + (tab === t[0] ? ' on' : ''), onClick: () => setTab(t[0]) }, t[1])))

      return h('div', { className: 'pond' }, [
        h('style', { key: 'css' }, POND_CSS),
        h('div', { key: 'hero', className: 'pond-hero' }, [
          h('img', { key: 'i', className: 'pond-ava', src: (d.account && d.account.face) ? d.account.face : POND_ICON, alt: '' }),
          h('div', { key: 'w', className: 'pond-who' }, [
            h('h1', { key: 'h', title: (d.account && d.account.uname) || '还没登录小号' }, (d.account && d.account.uname) ? d.account.uname : '还没登录小号'),
            h('div', { key: 'lv', className: 'pond-lv' }, [
              h('b', { key: 'b' }, 'Lv.' + (st.level || 1)),
              h('span', { key: 't', className: 'track' }, h('b', { style: { width: Math.round(((st.xpIn || 0) / (st.step || 200)) * 100) + '%' } })),
              h('span', { key: 'n' }, (st.xpIn || 0) + '/' + (st.step || 200)),
            ]),
          ]),
          h('div', { key: 's', className: 'pond-say' }, [
            (d.say && d.say.text) ? d.say.text : '今天还没说话。跑一轮，我就有得聊了。',
            h('em', { key: 'e' }, '—— 鱼说'),
          ]),
          h('div', { key: 'a', className: 'pond-meta' }, [
              'B站鱼塘 · ',
              h('span', { key: 'en', className: 'pond-en' }, 'dsh-bili-pond'),
              ' · ',
              h('a', { key: 'up', href: 'https://space.bilibili.com/14430149', target: '_blank', rel: 'noreferrer', title: '去 B站 看 变量探索SEQVEC' }, '变量探索SEQVEC'),
              ' · ',
              h('a', { key: 'gh', href: 'https://github.com/YOYOLnFu/dsh-bili-pond', target: '_blank', rel: 'noreferrer' }, 'GitHub'),
              ' · v1.3.12',
          ]),
        ]),
        h('div', { key: 'quick', className: 'pond-quick', 'data-pond-quick': '' }, [
          h('div', { key: 'mode', className: 'pond-quick-group' }, [
            h('span', { key: 'k', className: 'pond-quick-k' }, '评论'),
            h('div', { key: 'seg', className: 'pond-quick-seg' },
              [['off', '关闭'], ['circle', '圈地自萌'], ['comment', '普通评论']].map(([id, label]) => h('button', {
                key: id, type: 'button', className: commentMode === id ? 'on' : '',
                'aria-pressed': commentMode === id ? 'true' : 'false',
                'data-quick-mode': id,
                disabled: Boolean(quickBusy) || !data,
                title: id === 'circle' ? '只回 UP 主本人邀请的一级评论，绝不起新楼' : (id === 'comment' ? '在选中的视频下发布新楼' : '只生成报告，不发评论'),
                onClick: () => {
                  setQuickCommentMode(id)
                  const p = id === 'circle'
                    ? { autoComment: false, circleMode: true, replyToComments: false }
                    : (id === 'comment'
                      ? { autoComment: true, circleMode: false, replyToComments: false }
                      : { autoComment: false, circleMode: false, replyToComments: false })
                  quickSave(p, id === 'circle' ? '圈地自萌' : (id === 'comment' ? '普通评论' : '评论模式'))
                    .then(() => setQuickCommentMode(null))
                },
              }, label))),
            quickMsg ? h('div', {
              key: 'quick-msg',
              className: 'pond-quick-toast' + (quickMsg.tone === 'warn' ? ' warn' : ''),
              title: quickMsg.text,
              role: 'status',
              'aria-live': 'polite',
              'data-quick-msg': quickMsg.tone || 'ok',
            }, quickMsg.text) : null,
            h('button', {
              key: 'mention-bind', type: 'button',
              className: 'pond-bind ' + (mentionReady ? 'ok' : 'warn'),
              title: mentionReady ? '评论 @ 的 UID 已绑定，点击去设置查看' : '评论 @ 的 UID 还没绑定，点击去设置',
              onClick: () => setTab('settings'),
            }, mentionReady ? '@ 已绑定' : '@ 未绑定'),
          ]),
          h('div', { key: 'sw', className: 'pond-quick-group pond-quick-switches' }, [
            h('span', { key: 'dm', className: 'pond-quick-sw' }, [
              h(Switch, {
                key: 's', on: Boolean(qcfg.dmOn), disabled: Boolean(quickBusy) || !data,
                onChange: (v) => {
                  if (v && !dmReady) {
                    setQuickMsg({ text: '私信还没绑定 UID，先去设置里识别收件人', tone: 'warn' })
                    return
                  }
                  quickSave({ dmOn: v }, '私信')
                },
              }),
              h('span', { key: 't' }, '私信'),
            ]),
            h('button', {
              key: 'dm-bind', type: 'button',
              className: 'pond-bind ' + (dmReady ? 'ok' : 'warn'),
              title: dmReady ? '私信 UID 已绑定，点击去设置查看' : '私信 UID 还没绑定，点击去设置',
              onClick: () => setTab('settings'),
            }, dmReady ? 'UID 已绑定' : 'UID 未绑定'),
            h('span', { key: 'run', className: 'pond-quick-sw' }, [h(Switch, { key: 's', on: Boolean(qcfg.autoRun), disabled: Boolean(quickBusy) || !data, onChange: (v) => quickSave({ autoRun: v }, '自动运行') }), h('span', { key: 't' }, '自动运行')]),
            h('span', { key: 'guard', className: 'pond-quick-sw' }, [h(Switch, { key: 's', on: Boolean(qcfg.guardOn), disabled: Boolean(quickBusy) || !data, onChange: (v) => quickSave({ guardOn: v }, '评论区守护') }), h('span', { key: 't' }, '评论区守护')]),
            h('span', { key: 'asr', className: 'pond-quick-sw' }, [h(Switch, { key: 's', on: Boolean(qcfg.transcribe), disabled: Boolean(quickBusy) || !data, onChange: (v) => quickSave({ transcribe: v }, '自动转写') }), h('span', { key: 't' }, '自动转写')]),
          ]),
          h('div', { key: 'stats', className: 'pond-quick-stats', 'data-pond-stats': '' }, [
            h('span', { key: 'items' }, ['看过 ', h('b', null, String(st.items || 0)), ' 条']),
            h('span', { key: 'replies' }, ['回过 ', h('b', null, String(st.replies || 0)), ' 条']),
            h('span', { key: 'today' }, ['今天回过 ', h('b', null, String(daily.count || 0) + '/' + String(daily.cap || 0))]),
            d.usage
              ? h('span', {
                  key: 'tokens',
                  title: '输入 ' + fmtTok(d.usage.in || 0) + ' · 缓存 ' + fmtTok(d.usage.cache || 0)
                    + ' · 输出 ' + fmtTok(d.usage.out || 0),
                }, ['今日 token ', h('b', null, fmtTok(d.usage.tokens || 0))])
              : null,
            h('span', { key: 'xp' }, ['攒了 ', h('b', null, String(st.xp || 0)), ' 点经验']),
            err ? h('span', { key: 'err', className: 'pond-bad' }, '接口出错：' + err) : null,
          ]),
          h('div', { key: 'acts', className: 'pond-quick-acts' }, [
            h('button', {
              key: 'run', 'data-bd-btn': '', 'data-primary': '', type: 'button',
              disabled: busy || running || finalizing,
              'aria-busy': (busy || running || finalizing) ? 'true' : 'false',
              title: running ? '这一轮结束前不会重复启动' : (finalizing ? '正在写历史 / 补封面' : (busy ? '正在启动这一轮' : '手动跑一轮')),
              onClick: run,
            }, busy ? '启动中…' : (running ? ('跑着呢' + (runElapsed > 0 ? ' · ' + pondMmss(runElapsed) : '')) : (finalizing ? '收尾中…' : '跑一轮'))),
            h('button', { key: 'refresh', 'data-bd-btn': '', type: 'button', onClick: load }, '刷新'),
            h('button', { key: 'more', type: 'button', className: 'pond-quick-more', onClick: () => setTab('settings') }, '更多设置'),
          ]),
        ]),
        tabBar,
        tab === 'history' ? historyTab : tab === 'memory' ? memoryTab : tab === 'diary' ? diaryTab : settingsTab,
        h('div', { key: 'foot', className: 'pond-foot' }, [
          h('a', { key: 'gh', href: 'https://github.com/YOYOLnFu/dsh-bili-pond', target: '_blank', rel: 'noreferrer' }, 'GitHub'),
          ' · ',
          h('a', { key: 'up', href: 'https://space.bilibili.com/14430149', target: '_blank', rel: 'noreferrer' }, '变量探索SEQVEC'),
          ' · 数据和开关都在这一页',
        ]),
      ])
    }

    return {
      inject: ['slots', 'layout'],
      apply(ctx) {
        const style = document.createElement('style')
        style.setAttribute('data-plugin-css', 'dsh-bili-pond')
        style.textContent = CSS + POND_CSS
        document.head.appendChild(style)
        ctx.effect(() => () => style.remove(), 'dsh-bili-pond: 设置页样式')

        // ⭐ 进「设置」：label 就是左侧导航里那一项（抄 dsh-meme 的写法）
        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
        if (!slots) return
        slots.inject('settings.section', () => slots.register(
          { name: 'settings.section', id: 'bili-pond', order: 30, label: 'B站鱼塘' },
          () => h(Panel, { layout: 'summary' }),
        ))

        /* ⭐ 2026-10-23 整页入口：只保留左上侧栏图标（id 与 main key 相同） */
        openPond = (id) => {
          try {
            const layout = ctx.get('layout')
            if (layout && typeof layout.selectPanel === 'function') layout.selectPanel(id)
          } catch (e) { /* 拿不到 layout 就只留图标入口，不影响页面本身 */ }
        }
        slots.inject('sidebar.panellist', () => slots.register(
          { name: 'sidebar.panellist', id: POND_ID, order: 5, label: 'B站鱼塘' },
          () => h(PondIcon),
        ))
        slots.inject('main', () => slots.register(
          { name: 'main', key: POND_ID },
          () => h(PondPage),
        ))
      },
    }
  },
})
