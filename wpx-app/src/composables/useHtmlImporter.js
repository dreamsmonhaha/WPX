/**
 * WPX HTML 文件导入工具
 *
 * 职责：
 *  1. 检测剪贴板/文件中的 HTML 内容
 *  2. 解析 HTML 源码 → Tiptap 文档（通过 editor.commands.setContent 内部走 prosemirror-model DOMParser）
 *  3. 把 HTML 源码 + 元数据写入 doc 节点 attrs（依赖 HtmlSourceExtension 注册的 schema）
 *  4. 提供 getHtmlImportMeta / hasHtmlImport / clearHtmlAttrs / restoreFromHtmlSource 等 API
 *
 * 设计原则：
 *  - 业务层不直接写 transaction，所有 doc attrs 修改走扩展命令
 *  - "导入无感"：本模块不触发任何弹窗，只在调用方决定是否提示
 *  - HTML 源码大小阈值：超过 2MB 时返回错误（避免 attrs 过大导致 JSON 序列化卡顿）
 */

const MAX_HTML_SOURCE_BYTES = 2 * 1024 * 1024 // 2MB

/** @typedef {'paste' | 'file' | 'url'} HtmlImportSource */

/**
 * 检测字符串是否像 HTML（含 <html>、<!DOCTYPE 或至少一个开标签 + 闭标签）
 * 用于区分「粘贴的是 HTML 源码」和「粘贴的是纯文本」。
 * @param {string} text
 * @returns {boolean}
 */
export function looksLikeHtml(text) {
  if (!text || typeof text !== 'string') return false
  const trimmed = text.trim()
  if (trimmed.length < 16) return false
  // 1. DOCTYPE / <html> 标签
  if (/^<!doctype\s+html/i.test(trimmed)) return true
  if (/<html[\s>]/i.test(trimmed)) return true
  // 2. 至少一个开标签 + 对应闭标签（如 <p>...</p>、<h1>...</h1>）
  if (/<([a-z][a-z0-9]*)\b[^>]*>([\s\S]*?)<\/\1>/i.test(trimmed)) return true
  // 3. 自闭合标签密集（如 <br/><hr/><img ... />）
  if ((trimmed.match(/<(br|hr|img|input|meta|link)\b[^>]*\/?>/gi) || []).length >= 2) return true
  return false
}

/**
 * 从 ClipboardEvent.clipboardData 中检测是否存在 HTML 内容。
 * - 优先取 text/html，长度 > 100 视为真实 HTML（避免误判 < 100 char 的纯文本中偶然出现的尖括号）
 * @param {DataTransfer | null} clipboardData
 * @returns {string | null}
 */
export function extractHtmlFromClipboard(clipboardData) {
  if (!clipboardData) return null
  let html = ''
  try {
    html = clipboardData.getData('text/html') || ''
  } catch {
    return null
  }
  if (!html || html.length < 100) return null
  return html
}

/**
 * 检测剪贴板中是否含 HTML（高于纯文本优先级的判别）。
 * @param {DataTransfer | null} clipboardData
 * @returns {boolean}
 */
export function detectHtmlInClipboard(clipboardData) {
  return Boolean(extractHtmlFromClipboard(clipboardData))
}

/**
 * 粘贴 HTML 清洗正则集合：
 *  - CLIPBOARD_NOISE_RE    剪贴板包装噪音（注释 / meta / link / script / style / title / Word 的 <o:p>）
 *  - TRAILING_BREAK_RE     块级元素闭合标签前的 <br> / &nbsp; / 空白（Word 风格 <p>line<br></p>）
 *  - EMPTY_BLOCK_RE        内容仅含 <br> / &nbsp; / 空白的空块级元素（<p><br></p>、<div> </div>）
 */
const CLIPBOARD_NOISE_RE = [
  /<!--[\s\S]*?-->/g, // HTML 注释（含 Chrome 的 StartFragment/EndFragment）
  /<(script|style|title)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, // 成对出现的可丢弃节点
  /<(meta|link)\b[^>]*\/?>/gi, // 自闭合的头部标签（<meta charset='utf-8'> 等）
  /<\/?o:p\s*>/gi, // MS Word 命名空间标签（解包，内容保留）
]

const BLOCK_CLOSE_TAGS = 'p|div|h[1-6]|li|dt|dd|blockquote|section|article|aside|main|nav|figure|figcaption|td|th|pre|body|html'

const TRAILING_BREAK_RE = new RegExp(
  `(?:<br\\s*/?>|&nbsp;|\\s)+(?=\\s*</(?:${BLOCK_CLOSE_TAGS})\\b)`,
  'gi',
)

const EMPTY_BLOCK_RE = new RegExp(
  `<(p|div|h[1-6]|li|blockquote|section|article|aside)\\b[^>]*>(?:\\s|&nbsp;|<br\\s*/?>)*</\\1\\s*>`,
  'gi',
)

/** 空块移除的最大迭代轮数（嵌套空块如 <div><p><br></p></div> 需要 2 轮） */
const MAX_EMPTY_BLOCK_PASSES = 10

/* ---------------------------------------------------------------------------
 * DOM 级深度清洗（正则的盲区兜底）
 *
 * 字符串级正则无法处理「空白被嵌套内联标签包裹」的形态，例如：
 *   <p><span>&nbsp;</span></p>、<div><span><br></span></div>、<li><b> </b></li>
 * 这些会被 Tiptap 解析为空段落 → 粘贴后内容上方/中间出现成串空行。
 * 故在字符串预清洗后追加 DOM 解析一遍，自底向上移除"视觉空块"。
 * ------------------------------------------------------------------------- */

/** 需要做首尾 <br>/空白修剪的容器选择器（含表格单元格，单元格本身不会被移除） */
const DOM_ENDSTRIP_SELECTOR =
  'p,div,h1,h2,h3,h4,h5,h6,li,dt,dd,blockquote,section,article,aside,main,nav,figure,figcaption,header,footer,pre,td,th'

/** 允许被整体移除的"视觉空块"选择器（不含 td/th/pre，避免破坏表格/代码块结构） */
const DOM_EMPTY_REMOVABLE_SELECTOR =
  'p,div,h1,h2,h3,h4,h5,h6,li,dt,dd,blockquote,section,article,aside,main,nav,figure,figcaption,header,footer'

/** 有实际内容含义、出现即认为块非空的元素 */
const DOM_MEDIA_SELECTOR =
  'img,video,audio,table,hr,iframe,svg,canvas,embed,object,input,textarea,select'

/** 可作为"空块填充物"存在的内联格式标签（br / span / b / i 等） */
const INLINE_NOISE_TAG_RE =
  /^(?:BR|SPAN|B|I|EM|STRONG|U|S|STRIKE|DEL|INS|SMALL|SUB|SUP|FONT|A|CODE|MARK|ABBR|CITE|Q)$/

/** 零宽字符（网页复制常见，ProseMirror 会当正文文本保留） */
const ZERO_WIDTH_RE = /[\u200B-\u200D\uFEFF]/g

/** 归一化文本：nbsp → 空格、去零宽字符，判断是否还有可见文本 */
function hasVisibleText(el) {
  const text = (el.textContent || '').replace(/\u00A0/g, ' ').replace(ZERO_WIDTH_RE, '')
  return text.trim() !== ''
}

/** 判断块级元素是否为「视觉空块」（可安全整体移除） */
function isRemovableEmptyBlock(el) {
  if (el.querySelector(DOM_MEDIA_SELECTOR)) return false
  if (hasVisibleText(el)) return false
  // 后代元素必须全部是无内容含义的内联标签，否则视为承载结构
  for (const child of el.querySelectorAll('*')) {
    if (!INLINE_NOISE_TAG_RE.test(child.tagName)) return false
  }
  return true
}

/** 判断顶层首尾的节点是否为可修剪的"空白填充"（空白文本 / <br> / 空内联标签） */
function isBlankPaddingNode(node) {
  if (!node) return false
  if (node.nodeType === 3 /* TEXT */) return !(node.textContent || '').trim()
  if (node.nodeType !== 1 /* ELEMENT */) return false
  if (node.tagName === 'BR') return true
  if (INLINE_NOISE_TAG_RE.test(node.tagName)) {
    return !hasVisibleText(node) && !node.querySelector(DOM_MEDIA_SELECTOR)
  }
  return false
}

/** 从容器两端修剪空白填充（尾端 <br> 会变成段尾 hardBreak、首端 <br> 会多出空行） */
function trimBlankPadding(el) {
  for (let guard = 0; guard < 200; guard += 1) {
    const last = el.lastChild
    if (isBlankPaddingNode(last)) {
      last.remove()
      continue
    }
    const first = el.firstChild
    if (isBlankPaddingNode(first)) {
      first.remove()
      continue
    }
    break
  }
}

/**
 * DOM 深度清洗剪贴板内容（在字符串预清洗之后调用）。
 * @param {DocumentFragment} root
 */
function domSanitizePastedContent(root) {
  // a) 去除文本节点中的零宽字符（\u200B 等，会被解析为正文文本）
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const textNodes = []
  while (walker.nextNode()) textNodes.push(walker.currentNode)
  for (const textNode of textNodes) {
    const original = textNode.textContent || ''
    const cleaned = original.replace(ZERO_WIDTH_RE, '')
    if (cleaned !== original) {
      if (cleaned) textNode.textContent = cleaned
      else textNode.remove()
    }
  }

  // b) 块级/容器/顶层两端修剪 <br>、空白、空内联标签
  for (const el of [...root.querySelectorAll(DOM_ENDSTRIP_SELECTOR), root]) {
    trimBlankPadding(el)
  }

  // c) 迭代移除「视觉空块」，自底向上消化嵌套（<div><p><br></p></div>）
  for (let pass = 0; pass < MAX_EMPTY_BLOCK_PASSES; pass += 1) {
    let removed = false
    for (const el of [...root.querySelectorAll(DOM_EMPTY_REMOVABLE_SELECTOR)]) {
      if (isRemovableEmptyBlock(el)) {
        el.remove()
        removed = true
      }
    }
    if (!removed) break
  }
}

/**
 * 清洗粘贴进来的剪贴板 HTML，消除「粘贴后多出多个换行符/空行/大片空白」问题。
 *
 * 常见来源（网页 / Word / 微信 / ChatGPT）的剪贴板 HTML 带有四类噪音：
 *   1. 段落末尾的 <br>（Word 风格 <p>line<br></p>）→ Tiptap 解析为段尾 hardBreak
 *   2. 空块（<p><br></p>、<div> </div>、<p>&nbsp;</p>）→ 解析为空段落（可见空行）
 *   3. 注释 / meta / <o:p> 等剪贴板包装噪音
 *   4. 嵌套内联标签包裹的空白（<p><span>&nbsp;</span></p>、<div><span><br></span></div>）
 *      → 正则盲区，需 DOM 级深度清洗（本函数第 3 步）
 *
 * 注意：调用方仍应把「原始 HTML」存入 doc.attrs.htmlSource（供「恢复原样」使用），
 * 本函数只服务于插入渲染。
 *
 * @param {string | null | undefined} htmlString
 * @returns {string}
 */
export function sanitizePastedHtml(htmlString) {
  if (!htmlString || typeof htmlString !== 'string') return ''

  let html = htmlString

  // 1) 剥离剪贴板包装噪音（注释、meta/link、script/style/title、<o:p>）
  for (const re of CLIPBOARD_NOISE_RE) {
    html = html.replace(re, '')
  }

  // 2) 去掉块级元素闭合标签前的 <br> / &nbsp; / 纯空白（字符串级快速通道）
  html = html.replace(TRAILING_BREAK_RE, '')

  // 3) DOM 级深度清洗：嵌套内联包裹的空白块、块首尾 <br>、零宽字符
  if (typeof document !== 'undefined') {
    try {
      const template = document.createElement('template')
      template.innerHTML = html
      domSanitizePastedContent(template.content)
      html = template.innerHTML
    } catch (e) {
      // DOM 解析失败（极端畸形 HTML）：退回字符串级结果
    }
  }

  // 4) 字符串级空块移除兜底（无 DOM 环境或解析异常时生效）
  for (let i = 0; i < MAX_EMPTY_BLOCK_PASSES; i += 1) {
    const next = html.replace(EMPTY_BLOCK_RE, '')
    if (next === html) break
    html = next
  }

  return html.trim()
}

/**
 * 判断（清洗后的）粘贴 HTML 是否还有任何可见内容。
 * 用于「粘贴内容全是空白」时静默吞掉粘贴：不插入、不弹「已插入」提示。
 * @param {string | null | undefined} html
 * @returns {boolean}
 */
export function pastedHtmlHasVisibleContent(html) {
  if (!html || typeof html !== 'string') return false

  if (typeof document !== 'undefined') {
    try {
      const template = document.createElement('template')
      template.innerHTML = html
      if (template.content.querySelector(DOM_MEDIA_SELECTOR)) return true
      return hasVisibleText(template.content)
    } catch (e) {
      // fall through 到字符串级判断
    }
  }

  const withoutTags = html.replace(/<[^>]*>/g, ' ')
  return withoutTags.replace(/\u00A0/g, ' ').replace(ZERO_WIDTH_RE, '').trim() !== ''
}

/* ---------------------------------------------------------------------------
 * 「内联优先」插入（粘贴不换行）
 *
 * 需求：粘贴的内容直接追加到光标后面，不要先换行。
 * 根因：剪贴板 HTML 的内容几乎都包在 <div>/<p> 块级标签里，insertContentAt
 * 插入块级内容必然在光标处拆段 → 内容出现在新行。
 * 方案：把粘贴内容拆成「首块内联 JSON + 其余块 HTML」：
 *   - 首个简单块（纯内联内容的 p/div/h）解包成内联节点（保留 bold/italic/
 *     underline/strike/code/link/color 标记），以 Fragment 形式插到光标处 → 不换行
 *   - 其余块级内容仍作为块插入（跟在首行后面），多段结构不丢
 *   - 纯文本路径复用同一机制：首行内联、其余分段
 * ------------------------------------------------------------------------- */

/** 内联格式标签 → Tiptap mark 类型（均为项目已注册扩展） */
const INLINE_MARK_TAG_MAP = {
  B: 'bold',
  STRONG: 'bold',
  EM: 'italic',
  I: 'italic',
  U: 'underline',
  INS: 'underline',
  S: 'strike',
  STRIKE: 'strike',
  DEL: 'strike',
  CODE: 'code',
}

/** 顶层块级元素判定（含媒体；出现即不能整体内联） */
const BLOCKISH_TAG_RE =
  /^(P|DIV|H[1-6]|UL|OL|LI|DL|DT|DD|TABLE|THEAD|TBODY|TR|TD|TH|PRE|BLOCKQUOTE|HR|IMG|VIDEO|AUDIO|IFRAME|SVG|CANVAS|SECTION|ARTICLE|ASIDE|MAIN|NAV|FIGURE|FIGCAPTION|HEADER|FOOTER|DETAILS|SUMMARY)$/

/** 从 style 属性提取颜色（color: rgb(...)/#hex） */
function parseStyleColor(el) {
  const style = el.getAttribute?.('style') || ''
  const m = style.match(/(?:^|;)\s*color\s*:\s*([^;]+)/i)
  if (!m) return null
  return m[1].trim() || null
}

/**
 * DOM 节点列表 → Tiptap 内联 JSON 数组（text / hardBreak，携带 marks）。
 * 未知标签透明递归（保留其文本与已知格式后代）。
 * @param {NodeList | Node[]} nodes
 * @param {object[]} inheritedMarks
 * @returns {object[]}
 */
function nodesToInlineJson(nodes, inheritedMarks = []) {
  const out = []
  for (const node of nodes) {
    if (node.nodeType === 3 /* TEXT */) {
      const text = (node.textContent || '').replace(ZERO_WIDTH_RE, '')
      if (text) {
        out.push({ type: 'text', text, ...(inheritedMarks.length ? { marks: [...inheritedMarks] } : {}) })
      }
      continue
    }
    if (node.nodeType !== 1 /* ELEMENT */) continue

    const tag = node.tagName
    if (tag === 'BR') {
      out.push({ type: 'hardBreak' })
      continue
    }
    if (tag === 'A') {
      const href = node.getAttribute('href') || ''
      if (href) {
        out.push(...nodesToInlineJson(node.childNodes, [...inheritedMarks, { type: 'link', attrs: { href } }]))
        continue
      }
    }
    if (tag === 'SPAN' || tag === 'FONT') {
      const color = parseStyleColor(node)
      if (color) {
        out.push(...nodesToInlineJson(node.childNodes, [...inheritedMarks, { type: 'color', attrs: { color } }]))
        continue
      }
    }
    const markType = INLINE_MARK_TAG_MAP[tag]
    if (markType) {
      out.push(...nodesToInlineJson(node.childNodes, [...inheritedMarks, { type: markType }]))
      continue
    }
    // 未知内联标签：透明递归（保文本）
    out.push(...nodesToInlineJson(node.childNodes, inheritedMarks))
  }
  return out
}

/** 块是否为「简单块」：自身是块级标签，但后代全是内联内容（无块/无媒体） */
function isSimpleInlineBlock(el) {
  return !el.querySelector(
    'p,div,h1,h2,h3,h4,h5,h6,ul,ol,li,dl,dt,dd,table,thead,tbody,tr,td,th,pre,blockquote,hr,img,video,audio,iframe,svg,canvas,section,article,aside,main,nav,figure,figcaption,header,footer',
  )
}

/**
 * 把（已清洗的）粘贴 HTML 拆成「首块内联 JSON + 其余块 HTML」。
 *
 * 规则：
 *  - 顶层无块级元素 → 全部转内联 JSON（restHtml 为空）
 *  - 首个块级元素是简单块（p/div/h1-6 等，只含内联内容）→ 解包为内联 JSON，
 *    其后的顶层节点归入 restHtml
 *  - 首个块级元素不简单（列表/表格/图片块等）→ inlineJson 只含其前的顶层
 *    文本（通常为空），全部内容归入 restHtml（保持块级结构插入）
 *
 * @param {string | null | undefined} html
 * @returns {{ inlineJson: object[], restHtml: string }}
 */
export function splitInlineFirstHtml(html) {
  const result = { inlineJson: [], restHtml: '' }
  if (!html || typeof html !== 'string') return result
  if (typeof document === 'undefined') {
    // 无 DOM 环境：退化为整体块级插入
    result.restHtml = html
    return result
  }

  let template
  try {
    template = document.createElement('template')
    template.innerHTML = html
  } catch (e) {
    result.restHtml = html
    return result
  }

  const topNodes = [...template.content.childNodes]
  const firstBlock = topNodes.find((n) => n.nodeType === 1 && BLOCKISH_TAG_RE.test(n.tagName))

  if (!firstBlock) {
    // 顶层全是内联内容 → 整体内联
    result.inlineJson = nodesToInlineJson(topNodes)
    return result
  }

  const idx = topNodes.indexOf(firstBlock)
  const before = topNodes.slice(0, idx)
  const after = topNodes.slice(idx + 1)

  if (isSimpleInlineBlock(firstBlock)) {
    // 首块解包：内联部分 = 首块内容 + 其前面的顶层文本
    result.inlineJson = [
      ...nodesToInlineJson(before),
      ...nodesToInlineJson(firstBlock.childNodes),
    ]
  } else {
    // 首块承载结构（列表/表格等）：内联部分只有其前的顶层文本（通常为空）
    result.inlineJson = nodesToInlineJson(before)
  }

  // restHtml = 首块（若未解包）+ 其后的顶层节点
  const wrapper = document.createElement('div')
  if (!isSimpleInlineBlock(firstBlock)) {
    // eslint-disable-next-line no-console
    wrapper.appendChild(firstBlock.cloneNode(true))
  }
  for (const n of after) wrapper.appendChild(n.cloneNode(true))
  result.restHtml = wrapper.innerHTML
  return result
}

/**
 * 按「内联优先」语义把粘贴内容插入编辑器：
 *   1. restHtml（块级部分）先插入到粘贴时的光标范围
 *   2. inlineJson（首行内联部分）再插入到光标处 —— 最终顺序：
 *      光标前文 + 内联首行 + 其余块级段落 + 光标后文
 *
 * 单块/单行内容（restHtml 为空）只走第 2 步 → 完全不换行。
 *
 * @param {object} editor Tiptap Editor 实例
 * @param {{from: number, to: number}} range 粘贴事件发生时的光标/选区
 * @param {object[]} inlineJson
 * @param {string} restHtml
 */
export function insertInlineFirstContent(editor, range, inlineJson, restHtml) {
  if (!editor) return
  const hasInline = Array.isArray(inlineJson) && inlineJson.length > 0

  if (restHtml) {
    editor.chain().insertContentAt(range, restHtml).run()
    if (hasInline) {
      editor.chain().insertContentAt({ from: range.from, to: range.from }, inlineJson).run()
    }
  } else if (hasInline) {
    editor.chain().insertContentAt(range, inlineJson).run()
  }
}

/**
 * 把纯文本转换为可插入编辑器的 HTML 片段（右键菜单「粘贴」用）。
 *
 * 背景：直接 insertContent(纯文本) 会把 \n 作为字面量塞进单个文本节点，
 * 视觉上换行丢失；而 markdown 序列化又把字面量 \n 原样输出，造成
 * 「导出后换行数量错乱」。此处按纯文本语义正确转换：
 *   - 空行（\n{2,}）分段 → <p>
 *   - 段内单个换行 → <br>
 *
 * @param {string | null | undefined} text
 * @returns {string}
 */
export function plainTextToEditableHtml(text) {
  if (!text || typeof text !== 'string') return ''

  // 统一 Windows/Mac 换行符；去掉首尾空行（粘贴时不产生多余空段落）
  const normalized = text
    .replace(/\r\n?/g, '\n')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/^\n+|\n+$/g, '')
  if (!normalized) return ''

  const escapeHtmlText = (s) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

  return normalized
    .split(/\n{2,}/)
    .map((para) => `<p>${escapeHtmlText(para).replace(/\n/g, '<br>')}</p>`)
    .join('')
}

/**
 * 校验 HTML 源码大小是否在阈值内。
 * @param {string} htmlString
 * @returns {{ ok: boolean, bytes?: number, error?: string }}
 */
function validateHtmlSize(htmlString) {
  if (!htmlString || typeof htmlString !== 'string') {
    return { ok: false, error: 'html-empty' }
  }
  // 粗略估计：JS 字符串按 UTF-16 编码，每个字符 2 字节
  const bytes = htmlString.length * 2
  if (bytes > MAX_HTML_SOURCE_BYTES) {
    return { ok: false, bytes, error: `html-too-large (${(bytes / 1024 / 1024).toFixed(1)}MB > 2MB)` }
  }
  return { ok: true, bytes }
}

/**
 * 读取当前 doc 的 HTML 导入元数据。
 * @param {import('@tiptap/core').Editor | null} editor
 * @returns {{
 *   htmlSource: string | null,
 *   sourceUrl: string | null,
 *   importedAt: string | null,
 *   importSource: HtmlImportSource | null,
 *   lastFormattedTemplate: string | null,
 *   lastFormattedAt: string | null,
 * } | null}
 */
export function getHtmlImportMeta(editor) {
  if (!editor || !editor.state || !editor.state.doc) return null
  const attrs = editor.state.doc.attrs || {}
  if (!attrs.htmlSource && !attrs.sourceUrl && !attrs.importedAt) return null
  return {
    htmlSource: attrs.htmlSource ?? null,
    sourceUrl: attrs.sourceUrl ?? null,
    importedAt: attrs.importedAt ?? null,
    importSource: attrs.importSource ?? null,
    lastFormattedTemplate: attrs.lastFormattedTemplate ?? null,
    lastFormattedAt: attrs.lastFormattedAt ?? null,
  }
}

/**
 * 当前文档是否含 HTML 导入元数据（用于决定是否触发排版弹窗）。
 * @param {import('@tiptap/core').Editor | null} editor
 * @returns {boolean}
 */
export function hasHtmlImport(editor) {
  if (!editor || !editor.state || !editor.state.doc) return false
  const attrs = editor.state.doc.attrs || {}
  return Boolean(attrs.htmlSource)
}

/**
 * 把 HTML 字符串导入到编辑器，并把元数据写入 doc attrs。
 *
 * @param {import('@tiptap/core').Editor | null} editor
 * @param {string} htmlString
 * @param {{
 *   sourceUrl?: string | null,
 *   importSource?: HtmlImportSource,
 *   importedAt?: string,
 * }} [opts]
 * @returns {{
 *   ok: boolean,
 *   htmlSource?: string,
 *   sourceUrl?: string | null,
 *   importedAt?: string,
 *   importSource?: HtmlImportSource,
 *   bytes?: number,
 *   error?: string,
 *   message?: string,
 * }}
 */
export function importHtmlString(editor, htmlString, opts = {}) {
  if (!editor) {
    return { ok: false, error: 'editor-unavailable', message: '编辑器不可用' }
  }
  const sizeCheck = validateHtmlSize(htmlString)
  if (!sizeCheck.ok) {
    return { ok: false, error: sizeCheck.error, message: 'HTML 源码过大，已拒绝导入' }
  }

  const importSource = opts.importSource || 'paste'
  const importedAt = opts.importedAt || new Date().toISOString()
  const sourceUrl = opts.sourceUrl ?? null

  try {
    // 1. 用 Tiptap 内部 DOMParser 解析 HTML 为 ProseMirror 文档
    // setContent 接受 HTML 字符串，内部走 prosemirror-model 的 DOMParser
    editor.commands.setContent(htmlString, { emitUpdate: false })

    // 2. 写入 doc attrs（通过扩展命令，避免直接构造 transaction）
    editor.commands.setHtmlSource({
      htmlSource: htmlString,
      sourceUrl,
      importedAt,
      importSource,
    })
  } catch (error) {
    console.error('[useHtmlImporter] importHtmlString failed:', error)
    return {
      ok: false,
      error: error?.message || String(error),
      message: 'HTML 解析失败：' + (error?.message || '未知错误'),
    }
  }

  return {
    ok: true,
    htmlSource: htmlString,
    sourceUrl,
    importedAt,
    importSource,
    bytes: sizeCheck.bytes,
  }
}

/**
 * 清除所有 HTML 内部 attrs（"清除格式"或主动重置时调用）。
 * 保留 doc 已有内容，仅清除元数据。
 * @param {import('@tiptap/core').Editor | null} editor
 * @returns {{ ok: boolean }}
 */
export function clearHtmlAttrs(editor) {
  if (!editor) return { ok: false }
  try {
    editor.commands.clearHtmlSource()
    return { ok: true }
  } catch (error) {
    console.warn('[useHtmlImporter] clearHtmlAttrs failed:', error)
    return { ok: false, error: error?.message }
  }
}

/**
 * 仅更新 doc.attrs.htmlSource 字段，不替换文档内容。
 * 用于 HTML 源码编辑模式：用户在左侧源码面板编辑源码后，
 * 将新源码写入 attrs.htmlSource（不触发 setContent，由调用方负责重渲染）。
 *
 * 与 importHtmlString 的区别：
 *  - importHtmlString: 替换 doc 内容 + 写入 htmlSource（用于初次导入）
 *  - updateHtmlSource:  不替换 doc 内容，仅更新 htmlSource（用于源码面板编辑）
 *  - 调用 updateHtmlSource 不会重置 sourceUrl / importedAt / importSource
 *
 * 与 restoreFromHtmlSource 的区别：
 *  - restoreFromHtmlSource: 用保存的源码重渲染文档（保留原样）
 *  - updateHtmlSource: 仅保存源码，不改变文档（编辑后保存）
 *
 * @param {import('@tiptap/core').Editor | null} editor
 * @param {string|null} htmlSource 新的 HTML 源码；传 null 或空字符串表示清空
 * @returns {{ ok: boolean, error?: string, message?: string }}
 */
export function updateHtmlSource(editor, htmlSource) {
  if (!editor) {
    return { ok: false, error: 'editor-unavailable', message: '编辑器不可用' }
  }
  if (typeof htmlSource !== 'string') {
    return { ok: false, error: 'invalid-html-source', message: 'HTML 源码必须是字符串' }
  }
  try {
    const result = editor.commands.updateHtmlSource(htmlSource)
    if (result === false) {
      return { ok: false, error: 'command-rejected', message: 'Tiptap 拒绝更新源码' }
    }
    return { ok: true }
  } catch (error) {
    console.error('[useHtmlImporter] updateHtmlSource failed:', error)
    return {
      ok: false,
      error: error?.message || String(error),
      message: '更新源码失败：' + (error?.message || '未知错误'),
    }
  }
}

/**
 * 从保存的 htmlSource 重新渲染为 Tiptap 文档（"恢复原样"调用）。
 * 注意：本函数会**覆盖**当前文档内容为原始 HTML 渲染结果，
 *       并保留 htmlSource / sourceUrl / importedAt / importSource 不变。
 *
 * @param {import('@tiptap/core').Editor | null} editor
 * @param {string} [htmlSource] 默认从 doc.attrs.htmlSource 读取
 * @returns {{ ok: boolean, error?: string, message?: string }}
 */
export function restoreFromHtmlSource(editor, htmlSource) {
  if (!editor) {
    return { ok: false, error: 'editor-unavailable', message: '编辑器不可用' }
  }
  const source =
    typeof htmlSource === 'string' && htmlSource
      ? htmlSource
      : editor.state?.doc?.attrs?.htmlSource
  if (!source) {
    return { ok: false, error: 'no-html-source', message: '未找到原始 HTML 源码' }
  }
  try {
    editor.commands.setContent(source, { emitUpdate: false })
    // 保留元数据，仅清空排版状态（因为已恢复原样）
    editor.commands.setFormatState({ templateId: null, formattedAt: null })
    return { ok: true }
  } catch (error) {
    console.error('[useHtmlImporter] restoreFromHtmlSource failed:', error)
    return {
      ok: false,
      error: error?.message || String(error),
      message: '恢复原样失败：' + (error?.message || '未知错误'),
    }
  }
}

/**
 * 读取 doc 上的最近排版状态（用于顶部提示条显示）。
 * @param {import('@tiptap/core').Editor | null} editor
 * @returns {{
 *   templateId: string | null,
 *   templateLabel: string | null,
 *   formattedAt: string | null,
 *   htmlSource: string | null,
 * } | null}
 */
export function getFormatState(editor) {
  if (!editor || !editor.state || !editor.state.doc) return null
  const attrs = editor.state.doc.attrs || {}
  if (!attrs.lastFormattedTemplate) return null
  return {
    templateId: attrs.lastFormattedTemplate,
    templateLabel: attrs.lastFormattedTemplate, // label 解析由调用方通过 getTemplateById 完成
    formattedAt: attrs.lastFormattedAt ?? null,
    htmlSource: attrs.htmlSource ?? null,
  }
}

export function useHtmlImporter() {
  return {
    looksLikeHtml,
    extractHtmlFromClipboard,
    detectHtmlInClipboard,
    importHtmlString,
    getHtmlImportMeta,
    hasHtmlImport,
    clearHtmlAttrs,
    updateHtmlSource,
    restoreFromHtmlSource,
    getFormatState,
    sanitizePastedHtml,
    plainTextToEditableHtml,
    pastedHtmlHasVisibleContent,
    splitInlineFirstHtml,
    insertInlineFirstContent,
  }
}

export default {
  looksLikeHtml,
  extractHtmlFromClipboard,
  detectHtmlInClipboard,
  importHtmlString,
  getHtmlImportMeta,
  hasHtmlImport,
  clearHtmlAttrs,
  updateHtmlSource,
  restoreFromHtmlSource,
  getFormatState,
  useHtmlImporter,
  sanitizePastedHtml,
  plainTextToEditableHtml,
  pastedHtmlHasVisibleContent,
  splitInlineFirstHtml,
  insertInlineFirstContent,
  MAX_HTML_SOURCE_BYTES,
}
