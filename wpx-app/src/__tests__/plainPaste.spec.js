import { describe, it, expect } from 'vitest'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { tiptapJsonToMarkdown } from '@/utils/tiptapToMarkdown'
import { plainTextToEditableHtml } from '@/composables/useHtmlImporter'

/**
 * 回归测试：纯文本 / 字符串粘贴（无 HTML 或 HTML < 100 字符路径）
 *
 * 根因（修复前，ProseMirror 默认管线实测）：
 *  - 粘贴 "\n\n正文\n\n" → 「空段落 + 正文 + 空段落」→ 内容上下多出空行
 *  - 粘贴连续 3+ 空行的多行文本 → 成串空段落
 * 修复：handlePaste 分支 3 统一走 plainTextToEditableHtml 规范化后插入
 * （代码块内保持默认行为）。
 *
 * 本文件验证「转换 + 插入」组合在真实 Tiptap 编辑器中的最终文档结构，
 * 等价于 handlePaste 新逻辑的执行结果。
 */

function buildEditor(initialContent = '') {
  return new Editor({
    extensions: [StarterKit.configure({ heading: { levels: [1, 2, 3, 4, 5, 6] } })],
    content: initialContent,
  })
}

/** 模拟 handlePaste 分支 3 的处理（与 EditorCore 实现一致，含单行内联优化） */
function handlePlainTextPaste(editor, text) {
  const html = plainTextToEditableHtml(text)
  if (html) {
    const isSingleLine = !html.includes('<br') && !html.includes('</p><p')
    const content = isSingleLine ? html.replace(/^<p>|<\/p>$/g, '') : html
    editor.commands.insertContent(content)
  }
}

function blockCount(editor) {
  return (editor.getJSON().content || []).length
}

function emptyParagraphCount(editor) {
  return (editor.getJSON().content || []).filter(
    (node) => node.type === 'paragraph' && !(node.content || []).length,
  ).length
}

describe('纯文本粘贴：字符串', () => {
  it('单个字符串 "1" → 一个段落，无空段落', () => {
    const ed = buildEditor()
    handlePlainTextPaste(ed, '1')
    expect(blockCount(ed)).toBe(1)
    expect(emptyParagraphCount(ed)).toBe(0)
    expect(ed.getText()).toBe('1')
    ed.destroy()
  })

  it('含首尾换行的字符串 "\\n\\n1\\n\\n" → 只剩内容', () => {
    const ed = buildEditor()
    handlePlainTextPaste(ed, '\n\n1\n\n')
    expect(blockCount(ed)).toBe(1)
    expect(emptyParagraphCount(ed)).toBe(0)
    expect(ed.getText()).toBe('1')
    ed.destroy()
  })

  it('网页复制的短文本（剪贴板 HTML < 100 字符走纯文本路径）', () => {
    const ed = buildEditor()
    handlePlainTextPaste(ed, '  网页短文本  ')
    expect(ed.getText().trim()).toBe('网页短文本')
    expect(emptyParagraphCount(ed)).toBe(0)
    ed.destroy()
  })
})

describe('纯文本粘贴：多行文本（终端 / 代码复制形态）', () => {
  it('连续 3+ 空行 → 合并为单个分段，无成串空行', () => {
    const ed = buildEditor()
    handlePlainTextPaste(ed, 'A\n\n\n\n\nB')
    expect(emptyParagraphCount(ed)).toBe(0)
    expect(tiptapJsonToMarkdown(ed.getJSON())).toBe('A\n\nB')
    ed.destroy()
  })

  it('首尾带空行的多段文本 → 只保留内容分段', () => {
    const ed = buildEditor()
    handlePlainTextPaste(ed, '\n\n第一段\n\n第二段\n\n\n')
    expect(emptyParagraphCount(ed)).toBe(0)
    expect(blockCount(ed)).toBe(2)
    expect(tiptapJsonToMarkdown(ed.getJSON())).toBe('第一段\n\n第二段')
    ed.destroy()
  })

  it('行内单换行 → 段内 <br>（紧凑显示，不产生空段落）', () => {
    const ed = buildEditor()
    handlePlainTextPaste(ed, '第一行\n第二行\n第三行')
    expect(blockCount(ed)).toBe(1)
    expect(emptyParagraphCount(ed)).toBe(0)
    expect(ed.getText()).toBe('第一行\n第二行\n第三行')
    ed.destroy()
  })

  it('Windows \\r\\n 换行 → 与 \\n 等价处理', () => {
    const ed = buildEditor()
    handlePlainTextPaste(ed, 'A\r\n\r\n\r\nB\r\nC')
    expect(emptyParagraphCount(ed)).toBe(0)
    expect(tiptapJsonToMarkdown(ed.getJSON())).toBe('A\n\nB\nC')
    ed.destroy()
  })

  it('纯空白文本（只有换行/空格）→ 不插入任何内容', () => {
    const ed = buildEditor()
    handlePlainTextPaste(ed, '\n\n   \n\n')
    expect(blockCount(ed)).toBeLessThanOrEqual(1)
    expect(ed.getText().trim()).toBe('')
    ed.destroy()
  })
})

describe('纯文本粘贴：插入位置兼容', () => {
  it('粘贴到已有段落中间 → 正确分段的完整文档', () => {
    const ed = buildEditor('<p>前文内容</p>')
    ed.commands.setTextSelection({ from: 3, to: 3 })
    handlePlainTextPaste(ed, '插入文本')
    expect(emptyParagraphCount(ed)).toBe(0)
    expect(ed.getText()).toContain('前文插入文本内容')
    ed.destroy()
  })

  it('粘贴多行到空文档 → 文本内容一字不丢', () => {
    const ed = buildEditor()
    const text = '标题行\n\n要点一\n要点二\n\n结论'
    handlePlainTextPaste(ed, text)
    expect(ed.getText().replace(/\n/g, '')).toBe(text.replace(/\n/g, ''))
    expect(emptyParagraphCount(ed)).toBe(0)
    ed.destroy()
  })
})
