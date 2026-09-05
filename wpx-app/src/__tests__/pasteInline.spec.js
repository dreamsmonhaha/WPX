import { describe, it, expect } from 'vitest'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { TextStyle } from '@tiptap/extension-text-style'
import { Color } from '@tiptap/extension-color'
import { EditorImage } from '@/extensions/EditorImage'
import { tiptapJsonToMarkdown } from '@/utils/tiptapToMarkdown'
import {
  sanitizePastedHtml,
  splitInlineFirstHtml,
  insertInlineFirstContent,
} from '@/composables/useHtmlImporter'

/**
 * 回归测试：粘贴内容「直接追加到光标后面，不换行」
 *
 * 根因：剪贴板 HTML 的内容包在 <div>/<p> 块级标签里，块级插入必然在
 * 光标处拆段 → 内容总是从新行开始。
 * 修复：splitInlineFirstHtml 把内容拆成「首块内联 JSON + 其余块 HTML」，
 * insertInlineFirstContent 先插块再在原光标处插内联 → 首行不换行、
 * 格式（加粗/斜体/链接/颜色）保留，多段内容结构不丢。
 *
 * 本文件用与 handlePaste 完全一致的链路（sanitize → split → insert）验证。
 */

function buildEditor(initialContent = '<p>前文内容</p>') {
  return new Editor({
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3, 4, 5, 6] } }),
      TextStyle,
      Color,
      EditorImage.configure({ allowBase64: true }),
    ],
    content: initialContent,
  })
}

/** 与 handlePaste HTML 分支一致的完整链路 */
function pasteHtml(editor, rawHtml, range) {
  const cleaned = sanitizePastedHtml(rawHtml)
  const { inlineJson, restHtml } = splitInlineFirstHtml(cleaned)
  insertInlineFirstContent(editor, range, inlineJson, restHtml)
}

function cursorAt(editor, pos) {
  editor.commands.setTextSelection({ from: pos, to: pos })
  return { from: pos, to: pos }
}

describe('单行内容粘贴：不换行，直接跟在光标后', () => {
  it('网页单 div 文本（光标在段中）→ 内联追加，无新段落', () => {
    const ed = buildEditor()
    const range = cursorAt(ed, 3) // 前文|内容
    pasteHtml(ed, '<div style="color:red">粘贴文本</div>', range)
    expect(ed.getHTML()).toBe('<p>前文粘贴文本内容</p>')
    ed.destroy()
  })

  it('带格式的单行（加粗+链接）→ 内联追加且格式保留', () => {
    const ed = buildEditor()
    const range = cursorAt(ed, 3)
    pasteHtml(ed, '<div><b>加粗</b>和<a href="https://x.com">链接</a></div>', range)
    const html = ed.getHTML()
    // 格式保留 + 仍是单个段落（Link 扩展会自动加 target/rel 安全属性）
    expect(html).toContain('<strong>加粗</strong>')
    expect(html).toContain('href="https://x.com"')
    expect(html.startsWith('<p>前文<strong>加粗</strong>和<a')).toBe(true)
    expect(html.endsWith('>链接</a>内容</p>')).toBe(true)
    ed.destroy()
  })

  it('单行纯字符串 "1"（光标在段中）→ 不换行', () => {
    const ed = buildEditor()
    const range = cursorAt(ed, 3)
    // 纯文本路径：plainTextToEditableHtml → split → insert（模拟分支 3）
    const cleaned = '<p>1</p>'
    const { inlineJson, restHtml } = splitInlineFirstHtml(cleaned)
    insertInlineFirstContent(ed, range, inlineJson, restHtml)
    expect(ed.getHTML()).toBe('<p>前文1内容</p>')
    ed.destroy()
  })

  it('光标在段落末尾 → 追加在段末，无新段落', () => {
    const ed = buildEditor()
    const range = cursorAt(ed, 5) // 前文内容|
    pasteHtml(ed, '<div>追加</div>', range)
    expect(ed.getHTML()).toBe('<p>前文内容追加</p>')
    ed.destroy()
  })

  it('光标在文档末尾（空段）→ 内联追加', () => {
    const ed = buildEditor('<p>正文</p>')
    const end = ed.state.doc.content.size - 1
    const range = cursorAt(ed, end)
    pasteHtml(ed, '<div>末尾追加</div>', range)
    expect(ed.getHTML()).toBe('<p>正文末尾追加</p>')
    ed.destroy()
  })
})

describe('多行/多段内容粘贴：首行内联 + 其余段落保留结构', () => {
  it('两段内容（光标在段中）→ 首段内联 + 第二段成段', () => {
    const ed = buildEditor()
    const range = cursorAt(ed, 3)
    pasteHtml(ed, '<div>第一行</div><div>第二行</div>', range)
    expect(ed.getHTML()).toBe('<p>前文第一行</p><p>第二行</p><p>内容</p>')
    ed.destroy()
  })

  it('三段内容（光标在段末）→ 首段内联 + 其余两段', () => {
    const ed = buildEditor()
    const range = cursorAt(ed, 5)
    pasteHtml(ed, '<div>甲</div><div>乙</div><div>丙</div>', range)
    expect(ed.getHTML()).toBe('<p>前文内容甲</p><p>乙</p><p>丙</p>')
    ed.destroy()
  })

  it('多行纯文本（含段内换行）→ 首行内联 + 换行/段落结构保留', () => {
    const ed = buildEditor()
    const range = cursorAt(ed, 3)
    // 模拟分支 3：plainTextToEditableHtml 输出
    const cleaned = '<p>行一<br>行二</p><p>次段</p>'
    const { inlineJson, restHtml } = splitInlineFirstHtml(cleaned)
    insertInlineFirstContent(ed, range, inlineJson, restHtml)
    expect(ed.getHTML()).toBe('<p>前文行一<br>行二</p><p>次段</p><p>内容</p>')
    ed.destroy()
  })

  it('列表内容 → 结构性首块保持块级插入（不强行内联）', () => {
    const ed = buildEditor()
    const range = cursorAt(ed, 3)
    pasteHtml(ed, '<ul><li>列表项</li></ul>', range)
    // 列表是结构块，不拆首行，整体块级插入
    expect(ed.getHTML()).toContain('<ul><li><p>列表项</p></li></ul>')
    ed.destroy()
  })

  it('带图片的内容 → 图片块保持块级，图片不丢', () => {
    const ed = buildEditor()
    const range = cursorAt(ed, 3)
    pasteHtml(ed, '<p>说明文字</p><figure><img src="x.png"></figure>', range)
    const html = ed.getHTML()
    expect(html).toContain('说明文字')
    expect(ed.getJSON()).toEqual(
      expect.objectContaining({
        content: expect.arrayContaining([
          expect.objectContaining({ type: 'image' }),
        ]),
      }),
    )
    ed.destroy()
  })

  it('多段内容在空文档 → 无空段落，段落齐全', () => {
    const ed = buildEditor('<p></p>')
    pasteHtml(ed, '<div>第一段</div><div>第二段</div>', { from: 1, to: 1 })
    const blocks = ed.getJSON().content || []
    const emptyParas = blocks.filter((b) => b.type === 'paragraph' && !(b.content || []).length)
    expect(emptyParas.length).toBeLessThanOrEqual(1)
    expect(ed.getText()).toContain('第一段')
    expect(ed.getText()).toContain('第二段')
    ed.destroy()
  })
})

describe('选区替换语义', () => {
  it('选中文字粘贴单行 → 选区被内联内容替换，不换行', () => {
    const ed = buildEditor()
    ed.commands.setTextSelection({ from: 3, to: 5 }) // 选中 "内容"
    pasteHtml(ed, '<div>X</div>', { from: 3, to: 5 })
    expect(ed.getHTML()).toBe('<p>前文X</p>')
    ed.destroy()
  })

  it('选中文字粘贴多段 → 首行内联替换 + 其余段落', () => {
    const ed = buildEditor()
    ed.commands.setTextSelection({ from: 3, to: 5 })
    pasteHtml(ed, '<div>甲</div><div>乙</div>', { from: 3, to: 5 })
    expect(ed.getHTML()).toBe('<p>前文甲</p><p>乙</p>')
    ed.destroy()
  })
})

describe('Markdown 导出一致性', () => {
  it('单行内联粘贴 → 不产生多余 \\n', () => {
    const ed = buildEditor()
    const range = cursorAt(ed, 3)
    pasteHtml(ed, '<div>文本</div>', range)
    expect(tiptapJsonToMarkdown(ed.getJSON())).toBe('前文文本内容')
    ed.destroy()
  })
})
