import { onBeforeUnmount } from 'vue'
import { useAppStore } from '@/stores/app'
import { useGeneralSettingsStore } from '@/stores/generalSettings'
import { scopedStorageKey } from '@/utils/windowContext'

export const EDITOR_DRAFT_STORAGE_KEY = 'wpx-editor-draft'

/** 草稿中含"有效可见字符"（字母 / 数字 / CJK / 其他文字）才算有意义 */
const DRAFT_MEANINGFUL_CHAR_RE = /[\p{L}\p{N}]/u

/**
 * 判断草稿内容是否值得恢复。
 *
 * 背景：自动保存会把任意编辑内容写入 localStorage 草稿（哪怕只敲了一个
 * 字符），而默认启动行为是 restore-last —— 于是「测试时粘贴的 1」这类
 * 无意义内容会在每次打开时被恢复出来，用户期望打开是空白文档。
 *
 * 规则：剥掉纯空白后，必须至少含 2 个有效字符且含文字/数字字符，
 * 否则视为无意义草稿，跳过恢复。
 * （2 字符阈值：单字符/纯空白/纯标点直接忽略；两字以上正常恢复）
 *
 * @param {string} content
 * @returns {boolean}
 */
export function isDraftContentMeaningful(content) {
  if (!content || typeof content !== 'string') return false
  const visible = content.replace(/[\u200B-\u200D\uFEFF]/g, '').trim()
  if (visible.length < 2) return false
  return DRAFT_MEANINGFUL_CHAR_RE.test(visible)
}

/**
 * @returns {{ content: string, title?: string, updatedAt?: number } | null}
 */
export function loadEditorDraft() {
  if (typeof localStorage === 'undefined') return null

  try {
    const raw = localStorage.getItem(scopedStorageKey(EDITOR_DRAFT_STORAGE_KEY))
    if (!raw) return null

    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || !parsed.content) return null

    return parsed
  } catch {
    return null
  }
}

/**
 * 编辑器内容自动保存到 localStorage，并驱动标题栏保存状态指示灯
 * @param {() => { content: string, title?: string }} getPayload
 * @param {{ debounceMs?: number }} [options]
 */
export function useAutoSave(getPayload, options = {}) {
  const appStore = useAppStore()
  const generalSettings = useGeneralSettingsStore()
  let timer = null

  function getDebounceMs() {
    return options.debounceMs ?? generalSettings.autoSaveIntervalMs
  }

  async function flushDraft() {
    const payload = getPayload()
    const content = payload?.content ?? ''

    appStore.setDocumentSaveStatus('saving')

    await new Promise((resolve) => {
      window.setTimeout(resolve, 0)
    })

    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(
          scopedStorageKey(EDITOR_DRAFT_STORAGE_KEY),
          JSON.stringify({
            content,
            title: payload?.title ?? appStore.documentTitle,
            updatedAt: Date.now(),
          }),
        )
      }
      appStore.setDocumentSaveStatus('saved')
    } catch {
      appStore.setDocumentSaveStatus('unsaved')
    }
  }

  function scheduleAutoSave() {
    appStore.markDocumentDirty()

    if (!generalSettings.autoSaveEnabled) {
      if (timer) {
        window.clearTimeout(timer)
        timer = null
      }
      return
    }

    if (timer) window.clearTimeout(timer)
    timer = window.setTimeout(() => {
      timer = null
      flushDraft()
    }, getDebounceMs())
  }

  function cancelAutoSave() {
    if (timer) {
      window.clearTimeout(timer)
      timer = null
    }
  }

  onBeforeUnmount(cancelAutoSave)

  return {
    scheduleAutoSave,
    cancelAutoSave,
    flushDraft,
  }
}
