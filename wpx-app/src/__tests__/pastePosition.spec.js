import { describe, it, expect } from 'vitest'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import {
  splitInlineFirstHtml,
  insertInlineFirstContent,
} from '@/composables/useHtmlImporter'

/**
 * 回归测试：粘贴内容「追加到光标后面 + 单行不换行」
 *
 * 历史 bug 链：
 *  V5 之前：chain().focus() 重置选区 → 内容插错位置
 *  V5：insertContentAt(pasteRange) 修好位置，但块级内容仍会拆段换行
 *  V6（当前）：splitInlineFirstHtml + insertInlineFirstContent
 *    —— 单块内容解包为内联 JSON 插到光标处（不换行，格式保留）；
 *       多块内容 = 首块内联 + 其余块级段落
 *
 * 本文件用与 handlePaste 完全一致的链路（split → insert）验证。
 */

function buildEditor(initialContent = '<p>前文内容</p>') {
  return new Editor({
    extensions: [StarterKit.configure({ heading: { levels: [1, 2, 3, 4, 5, 6] } })],
    content: initialContent,
  })
}

/** 与 EditorCore.handlePaste 一致的插入链路 */
function pasteAtCursor(editor, html, rangeOverride) {
  const range = rangeOverride || { from: editor.state.selection.from, to: editor.state.selection.to }
  const { inlineJson, restHtml } = splitInlineFirstHtml(html)
  insertInlineFirstContent(editor, range, inlineJson, restHtml)
}

describe('粘贴插入位置：光标中间', () => {
  it('光标在段落中间 → 单块内容内联追加，不换行、不拆段', () => {
    const ed = buildEditor('<p>前文内容</p>')
    ed.commands.setTextSelection({ from: 3, to: 3 })
    pasteAtCursor(ed, '<p>插入X</p>')
    expect(ed.getHTML()).toBe('<p>前文插入X内容</p>')
    ed.destroy()
  })

  it('单行文本内联插入 → 不拆散段落', () => {
    const ed = buildEditor('<p>前文内容</p>')
    ed.commands.setTextSelection({ from: 3, to: 3 })
    pasteAtCursor(ed, '<p>插入</p>')
    expect(ed.getHTML()).toBe('<p>前文插入内容</p>')
    ed.destroy()
  })
})

describe('粘贴插入位置：文档末尾', () => {
  it('光标在最后一段末尾 → 内容内联追加在段末（不换行）', () => {
    const ed = buildEditor('<p>第一段</p><p>第二段</p>')
    const end = ed.state.doc.content.size - 1
    ed.commands.setTextSelection({ from: end, to: end })
    pasteAtCursor(ed, '<p>追加段</p>')
    expect(ed.getHTML()).toBe('<p>第一段</p><p>第二段追加段</p>')
    ed.destroy()
  })

  it('光标在第一段末尾 → 内容内联追加，不产生新段', () => {
    const ed = buildEditor('<p>第一段</p><p>第二段</p>')
    ed.commands.setTextSelection({ from: 4, to: 4 }) // "第一段" 文末
    pasteAtCursor(ed, '<p>插入段</p>')
    expect(ed.getHTML()).toBe('<p>第一段插入段</p><p>第二段</p>')
    ed.destroy()
  })
})

describe('粘贴插入位置：有选区时替换（与原生一致）', () => {
  it('选中 "内容"（from=3,to=5）→ 选区被内联内容替换，不拆段', () => {
    const ed = buildEditor('<p>前文内容</p>')
    ed.commands.setTextSelection({ from: 3, to: 5 })
    pasteAtCursor(ed, '<p>X</p>')
    expect(ed.getHTML()).toBe('<p>前文X</p>')
    ed.destroy()
  })

  it('选中 "内容" 替换为内联文本 → 不拆段', () => {
    const ed = buildEditor('<p>前文内容</p>')
    ed.commands.setTextSelection({ from: 3, to: 5 })
    pasteAtCursor(ed, '<p>Y</p>')
    expect(ed.getHTML()).toBe('<p>前文Y</p>')
    ed.destroy()
  })
})

describe('粘贴插入位置：多行内容', () => {
  it('多段内容粘贴到段落中间 → 首段内联 + 其余段落，全部保留', () => {
    const ed = buildEditor('<p>前文内容</p>')
    ed.commands.setTextSelection({ from: 3, to: 3 })
    pasteAtCursor(ed, '<p>甲</p><p>乙</p>')
    expect(ed.getHTML()).toBe('<p>前文甲</p><p>乙</p><p>内容</p>')
    ed.destroy()
  })

  it('空文档粘贴 → 内容完整落地', () => {
    const ed = buildEditor('<p></p>')
    pasteAtCursor(ed, '<p>粘贴的内容</p>')
    expect(ed.getText().trim()).toBe('粘贴的内容')
    ed.destroy()
  })
})
