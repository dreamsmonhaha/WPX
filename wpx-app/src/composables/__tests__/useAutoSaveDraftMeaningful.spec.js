import { describe, it, expect } from 'vitest'
import { isDraftContentMeaningful } from '@/composables/useAutoSave'

/**
 * 单元测试：isDraftContentMeaningful — 无意义草稿判定
 *
 * 背景：自动保存会把任意内容（哪怕 1 个字符）写进 localStorage 草稿，
 * 默认启动行为 restore-last 会在每次打开时恢复 —— 导致「打开出现 1」。
 * 修复：无意义草稿不恢复。
 */

describe('isDraftContentMeaningful', () => {
  it('单字符（数字/字母/汉字）→ 无意义', () => {
    expect(isDraftContentMeaningful('1')).toBe(false)
    expect(isDraftContentMeaningful('a')).toBe(false)
    expect(isDraftContentMeaningful('你')).toBe(false)
  })

  it('纯空白 / 换行 / 零宽字符 → 无意义', () => {
    expect(isDraftContentMeaningful('')).toBe(false)
    expect(isDraftContentMeaningful('   \n\n\t  ')).toBe(false)
    expect(isDraftContentMeaningful('\u200B\u200C\uFEFF')).toBe(false)
    expect(isDraftContentMeaningful('\u200B\n\n  \n\u200B')).toBe(false)
  })

  it('纯标点 / 纯 Markdown 符号（无文字字符）→ 无意义', () => {
    expect(isDraftContentMeaningful('...!!!')).toBe(false)
    expect(isDraftContentMeaningful('# -- ***')).toBe(false)
  })

  it('两个及以上文字字符 → 有意义（正常恢复）', () => {
    expect(isDraftContentMeaningful('12')).toBe(true)
    expect(isDraftContentMeaningful('你好')).toBe(true)
    expect(isDraftContentMeaningful('# 新文档\n\n在这里开始你的创作…')).toBe(true)
    expect(isDraftContentMeaningful('hello world')).toBe(true)
  })

  it('容错：非字符串输入', () => {
    expect(isDraftContentMeaningful(null)).toBe(false)
    expect(isDraftContentMeaningful(undefined)).toBe(false)
    expect(isDraftContentMeaningful(123)).toBe(false)
  })
})
