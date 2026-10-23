/**
 * 客户端 i18n 上下文（issue #12）。
 *
 * 只做三件事：
 * 1. 把「当前解析出的语言」放进 React Context；
 * 2. 给组件一个 `t(key, params?)`，未翻译的 key 原样返回（见 shared/i18n.ts 文件头）；
 * 3. 提供 `count(n)`，把数字格式化也收口到同一份 locale。
 *
 * 语言值本身来自设置域（`WorkbenchSettings.uiLocale`），本模块不拥有它。
 */
import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { formatCount, resolveLocale, translate, type ResolvedLocale, type UiLocale } from '../shared/i18n.js'

export interface I18n {
  locale: ResolvedLocale
  /** 中文原文 → 当前语言；未翻译时原样返回中文。 */
  t: (key: string, params?: Record<string, string | number>) => string
  /** 按当前 locale 格式化数字（千分位等）。 */
  count: (value: number) => string
}

const FALLBACK: I18n = {
  locale: 'zh-CN',
  t: (key, params) => translate('zh-CN', key, params),
  count: (value) => formatCount('zh-CN', value),
}

const I18nContext = createContext<I18n>(FALLBACK)

export function createI18n(locale: ResolvedLocale): I18n {
  return {
    locale,
    t: (key, params) => translate(locale, key, params),
    count: (value) => formatCount(locale, value),
  }
}

export function I18nProvider({ locale, children }: { locale: ResolvedLocale; children: ReactNode }): ReactNode {
  const value = useMemo(() => createI18n(locale), [locale])
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n(): I18n {
  return useContext(I18nContext)
}

/** 从设置值与浏览器语言解析出实际语言（组件层唯一调用点）。 */
export function localeFromSettings(uiLocale: UiLocale | undefined, navigatorLanguage: string | undefined): ResolvedLocale {
  return resolveLocale(uiLocale, navigatorLanguage)
}
