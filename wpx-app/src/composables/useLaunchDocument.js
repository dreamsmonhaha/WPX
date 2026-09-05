import { onMounted } from 'vue'
import { isDraftContentMeaningful, loadEditorDraft } from '@/composables/useAutoSave'
import { useGeneralSettingsStore } from '@/stores/generalSettings'
import {
  getDocPathFromUrl,
  getLaunchIntentFromUrl,
  getLaunchModeFromUrl,
  getLaunchTemplateIdFromUrl,
  getWindowId,
} from '@/utils/windowContext'
import { loadDocumentFromPath } from '@/utils/launchDocument'

/**
 * 启动时根据 URL docPath 加载文档；多窗口模式下无 docPath 时打开空白文档。
 * @param {{
 *   onOpen: (payload: { path?: string, content: string, title?: string, format?: object | null }) => void,
 *   onBlank?: () => void,
 *   onAiIntent?: (intent: string) => void,
 *   onTemplate?: (templateId: string) => void,
 * }} handlers
 */
export function useLaunchDocument({ onOpen, onBlank, onAiIntent, onTemplate }) {
  onMounted(async () => {
    const mode = getLaunchModeFromUrl()
    const docPath = getDocPathFromUrl()

    if (docPath) {
      const payload = await loadDocumentFromPath(docPath)
      if (payload) {
        onOpen(payload)
      }
      return
    }

    // 新建窗口强制空白路径：跳过草稿恢复逻辑
    if (mode === 'blank') {
      onBlank?.()
      return
    }

    // 新建窗口 + AI 写文路径：先清空，再把意图交由渲染层处理
    if (mode === 'ai') {
      onBlank?.()
      const intent = getLaunchIntentFromUrl()
      if (intent) {
        onAiIntent?.(intent)
      }
      return
    }

    // 新建窗口 + 模板路径：先清空，再按 templateId 应用冷启动模板
    if (mode === 'template') {
      onBlank?.()
      const templateId = getLaunchTemplateIdFromUrl()
      if (templateId) {
        onTemplate?.(templateId)
      }
      return
    }

    // 普通窗口（首启动 / 任务栏点击恢复）走草稿恢复
    const generalSettings = useGeneralSettingsStore()

    if (generalSettings.startupBehavior === 'restore-last') {
      const draft = loadEditorDraft()
      // 只恢复「有意义」的草稿：单个字符 / 纯空白 / 纯标点等
      // 测试残留内容不恢复，保证打开是干净的空白文档
      if (draft?.content && isDraftContentMeaningful(draft.content)) {
        onOpen({
          content: draft.content,
          title: draft.title,
        })
        return
      }
      // 存在草稿但内容无意义：视为无草稿，直接进入空白文档
      // （不落回首页空态，符合「打开即空白可编辑」的预期）
      if (draft?.content && getWindowId() === 0) {
        onBlank?.()
        return
      }
    }

    if (getWindowId() > 0 || generalSettings.startupBehavior === 'blank') {
      onBlank?.()
    }
  })
}
