import { describe, it, expect } from 'vitest'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { tiptapJsonToMarkdown } from '@/utils/tiptapToMarkdown'
import {
  sanitizePastedHtml,
  plainTextToEditableHtml,
  pastedHtmlHasVisibleContent,
} from '@/composables/useHtmlImporter'

/**
 * 回归测试：粘贴「多出多个换行符」bug 修复
 *
 * 背景：EditorCore.handlePaste 的 HTML 分支曾直接 insertContent(原始剪贴板 HTML)。
 * 常见来源（网页 / Word / 微信 / ChatGPT）的剪贴板 HTML 带有三类噪音：
 *   1) 段落末尾的 <br>（Word 风格 <p>line<br></p>）→ 段尾 hardBreak → 多一个换行
 *   2) 空块（<p><br></p>、<div> </div>、<p>&nbsp;</p>）→ 空段落 → 可见空行
 *   3) 注释 / meta / <o:p> 等包装噪音
 * 修复：插入前经 sanitizePastedHtml 清洗。
 */

function buildEditor() {
  return new Editor({
    extensions: [StarterKit.configure({ heading: { levels: [1, 2, 3, 4, 5, 6] } })],
    content: '',
  })
}

/** 统计文档结构：段落数 / 空段落数 / 段尾 hardBreak 数 */
function analyzeDoc(editor) {
  const blocks = editor.getJSON().content || []
  let emptyParagraphs = 0
  let trailingHardBreaks = 0
  for (const node of blocks) {
    const inline = node.content || []
    const textLength = inline
      .filter((c) => c.type === 'text')
      .reduce((sum, c) => sum + (c.text || '').replace(/\s|\u00A0/g, '').length, 0)
    if (node.type === 'paragraph' && textLength === 0 && inline.every((c) => c.type !== 'image')) {
      emptyParagraphs += 1
    }
    const last = inline[inline.length - 1]
    if (last && last.type === 'hardBreak') trailingHardBreaks += 1
  }
  return { blockCount: blocks.length, emptyParagraphs, trailingHardBreaks }
}

describe('sanitizePastedHtml：剪贴板噪音清洗', () => {
  it('去除 Word 风格段尾 <br>（<p>line<br></p>）', () => {
    const out = sanitizePastedHtml('<p>第一行</p><p>第二行<br></p><p>第三行<br /></p>')
    expect(out).toBe('<p>第一行</p><p>第二行</p><p>第三行</p>')
  })

  it('移除空段落 / 空块（<p><br></p>、<div> </div>、<p>&nbsp;</p>）', () => {
    const out = sanitizePastedHtml(
      '<div>第一行</div><div><br></div><div> </div><p>&nbsp;</p><div>第二行</div>',
    )
    expect(out).toBe('<div>第一行</div><div>第二行</div>')
  })

  it('迭代移除嵌套空块（<section><p><br></p></section>）', () => {
    const out = sanitizePastedHtml('<p>正文</p><section><div><p><br></p></div></section><p>结尾</p>')
    expect(out).toBe('<p>正文</p><p>结尾</p>')
  })

  it('剥离注释 / meta / script / style / <o:p> 包装噪音', () => {
    const out = sanitizePastedHtml(
      '<meta charset="utf-8"><!-- StartFragment --><p>第一<o:p></o:p>行</p>' +
        '<style>.x{color:red}</style><script>bad()</script><!-- EndFragment -->',
    )
    expect(out).toBe('<p>第一行</p>')
  })

  it('保留正文内容与正常结构（含列表 / 标题 / 加粗 / 段内 <br>）', () => {
    const out = sanitizePastedHtml(
      '<h2>标题</h2><p>第一段<strong>加粗</strong></p><ul><li>项一</li><li>项二</li></ul>' +
        '<p>段内换行<br>第二行</p>',
    )
    expect(out).toBe(
      '<h2>标题</h2><p>第一段<strong>加粗</strong></p><ul><li>项一</li><li>项二</li></ul>' +
        '<p>段内换行<br>第二行</p>',
    )
  })

  it('容错：空值 / 非字符串输入', () => {
    expect(sanitizePastedHtml('')).toBe('')
    expect(sanitizePastedHtml(null)).toBe('')
    expect(sanitizePastedHtml(undefined)).toBe('')
  })

  it('【核心】嵌套内联标签包裹的空白块（正则盲区）：前后成串空行被清除', () => {
    // 真实网页/飞书/ChatGPT 剪贴板形态：空 div + span 包裹 nbsp/br
    const out = sanitizePastedHtml(
      '<div><span>&nbsp;</span></div><div><span><br></span></div><div>1</div>' +
        '<div><span>&nbsp;</span></div><div><span><br></span></div>',
    )
    expect(out).toBe('<div>1</div>')
  })

  it('【核心】内容前后多个空白块 + 尾部顶层 <br> 全部清除', () => {
    const out = sanitizePastedHtml(
      '<meta charset="utf-8"><div><br></div><div> </div><p>正文</p><div><br></div><p> </p><br>',
    )
    expect(out).toBe('<p>正文</p>')
  })

  it('【核心】零宽字符（\\u200B/\\uFEFF）从正文剔除', () => {
    const out = sanitizePastedHtml('<p>1\u200B</p><p>\uFEFF</p>')
    expect(out).toBe('<p>1</p>')
  })

  it('【核心】Word 全文档形态（前导空段 + mso 标记 + o:p 包裹 nbsp）', () => {
    const out = sanitizePastedHtml(
      '<html><body><!--StartFragment--><p class=MsoNormal><o:p>&nbsp;</o:p></p>' +
        "<p class=MsoNormal><span style='mso-bookmark:_Hlk'> </span></p>" +
        '<p class=MsoNormal>1</p><!--EndFragment--></body></html>',
    )
    expect(out).toContain('1')
    expect(out).not.toContain('nbsp')
    expect(out).not.toContain('o:p')
  })

  it('图片/表格/代码块等有内容元素不受误删', () => {
    const out = sanitizePastedHtml(
      '<p><br></p><figure><img src="x.png"></figure><p><img src="y.png"></p><table><tr><td><br></td></tr></table><pre><code>code</code></pre>',
    )
    expect(out).toContain('<img src="x.png"')
    expect(out).toContain('<table>')
    expect(out).toContain('<pre>')
  })
})

describe('pastedHtmlHasVisibleContent：全空白粘贴守卫', () => {
  it('纯空白块 / nbsp / 零宽字符 → 无可见内容', () => {
    expect(pastedHtmlHasVisibleContent('<div><span>&nbsp;</span></div><div><br></div>')).toBe(false)
    expect(pastedHtmlHasVisibleContent('<p>\u200B</p>')).toBe(false)
    expect(pastedHtmlHasVisibleContent('')).toBe(false)
    expect(pastedHtmlHasVisibleContent(null)).toBe(false)
  })

  it('有文本 / 图片 → 有可见内容', () => {
    expect(pastedHtmlHasVisibleContent('<div>1</div>')).toBe(true)
    expect(pastedHtmlHasVisibleContent('<p><img src="a.png"></p>')).toBe(true)
    expect(pastedHtmlHasVisibleContent(sanitizePastedHtml('<div>1</div>'))).toBe(true)
  })
})

describe('真实 Tiptap 编辑器：粘贴插入后不再产生多余换行', () => {
  it('Word 风格 HTML → 无段尾 hardBreak，markdown 段距正常', () => {
    const ed = buildEditor()
    ed.commands.insertContent(
      sanitizePastedHtml('<p>第一行</p><p>第二行<br></p><p>第三行</p>'),
    )
    const stats = analyzeDoc(ed)
    expect(stats.trailingHardBreaks).toBe(0)
    expect(tiptapJsonToMarkdown(ed.getJSON())).toBe('第一行\n\n第二行\n\n第三行')
    ed.destroy()
  })

  it('空段落 HTML → 无空段落，无成串空行', () => {
    const ed = buildEditor()
    ed.commands.insertContent(
      sanitizePastedHtml('<div>第一行</div><div><br></div><div> </div><div>第二行</div>'),
    )
    const stats = analyzeDoc(ed)
    expect(stats.emptyParagraphs).toBe(0)
    expect(stats.blockCount).toBe(2)
    expect(tiptapJsonToMarkdown(ed.getJSON())).toBe('第一行\n\n第二行')
    ed.destroy()
  })

  it('微信风格嵌套 section + nbsp 空段 → 内容紧凑', () => {
    const ed = buildEditor()
    ed.commands.insertContent(
      sanitizePastedHtml('<section><p>第一行</p><p>&nbsp;</p><p>第二行<br></p></section>'),
    )
    const stats = analyzeDoc(ed)
    expect(stats.emptyParagraphs).toBe(0)
    expect(stats.trailingHardBreaks).toBe(0)
    expect(tiptapJsonToMarkdown(ed.getJSON())).toBe('第一行\n\n第二行')
    ed.destroy()
  })

  it('完整 Chrome 剪贴板包装（meta + 注释 + 空块）→ 只剩正文段落', () => {
    const ed = buildEditor()
    const raw =
      "<meta charset='utf-8'><!-- StartFragment --><div>第一行</div><div><br></div>" +
      '<div>第二行<br></div><!-- EndFragment -->'
    ed.commands.insertContent(sanitizePastedHtml(raw))
    const stats = analyzeDoc(ed)
    expect(stats.emptyParagraphs).toBe(0)
    expect(stats.trailingHardBreaks).toBe(0)
    expect(tiptapJsonToMarkdown(ed.getJSON())).toBe('第一行\n\n第二行')
    ed.destroy()
  })

  it('【核心·端到端】前后成串空行 + 内容 + 后成串空行 → 只剩内容', () => {
    const ed = buildEditor()
    const raw =
      '<meta charset="utf-8"><!--StartFragment-->' +
      '<div><span>&nbsp;</span></div><div><br></div><div> </div>' +
      '<div>粘贴内容</div>' +
      '<div><span><br></span></div><div>&nbsp;</div><div><br></div>' +
      '<!--EndFragment-->'
    const cleaned = sanitizePastedHtml(raw)
    expect(pastedHtmlHasVisibleContent(cleaned)).toBe(true)
    ed.commands.insertContent(cleaned)
    const stats = analyzeDoc(ed)
    expect(stats.emptyParagraphs).toBe(0)
    expect(stats.trailingHardBreaks).toBe(0)
    expect(stats.blockCount).toBe(1)
    expect(tiptapJsonToMarkdown(ed.getJSON())).toBe('粘贴内容')
    ed.destroy()
  })
})

describe('plainTextToEditableHtml：右键菜单纯文本粘贴转换', () => {
  it('空行分段 → 多个 <p>', () => {
    expect(plainTextToEditableHtml('第一段\n\n第二段')).toBe('<p>第一段</p><p>第二段</p>')
  })

  it('段内单个换行 → <br>', () => {
    expect(plainTextToEditableHtml('第一行\n第二行')).toBe('<p>第一行<br>第二行</p>')
  })

  it('统一 Windows \\r\\n 换行符', () => {
    expect(plainTextToEditableHtml('第一段\r\n\r\n第二段\r\n第三行')).toBe(
      '<p>第一段</p><p>第二段<br>第三行</p>',
    )
  })

  it('首尾空行被裁剪（不产生多余空段落）', () => {
    expect(plainTextToEditableHtml('\n\n第一段\n\n')).toBe('<p>第一段</p>')
  })

  it('HTML 特殊字符被转义', () => {
    expect(plainTextToEditableHtml('a < b & c > d')).toBe('<p>a &lt; b &amp; c &gt; d</p>')
  })

  it('容错：空值输入', () => {
    expect(plainTextToEditableHtml('')).toBe('')
    expect(plainTextToEditableHtml(null)).toBe('')
  })

  it('编辑器插入后：段落结构正确、无字面量 \\n 文本节点', () => {
    const ed = buildEditor()
    ed.commands.insertContent(plainTextToEditableHtml('第一行\n第二行\n\n第二段'))
    const blocks = ed.getJSON().content || []
    // 两个段落；第一段含 1 个 hardBreak；文本节点内不含字面量换行符
    expect(blocks.length).toBe(2)
    const literalNewlines = JSON.stringify(ed.getJSON()).match(/\\n/g) || []
    expect(literalNewlines.length).toBe(0)
    expect(tiptapJsonToMarkdown(ed.getJSON())).toBe('第一行\n第二行\n\n第二段')
    ed.destroy()
  })
})
