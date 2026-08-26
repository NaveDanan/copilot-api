import { useState } from 'react'

import { useLanguage } from '../contexts/LanguageContext'

interface SecuritySuggestionDialogProps {
  onDecision: (enabled: boolean) => Promise<void>
}

const IconShield = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="20"
    height="20"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M20 13c0 5-3.5 7.5-8 9-4.5-1.5-8-4-8-9V5l8-3 8 3v8Z" />
    <path d="m9 12 2 2 4-4" />
  </svg>
)

export default function SecuritySuggestionDialog({
  onDecision,
}: SecuritySuggestionDialogProps) {
  const { t } = useLanguage()
  const [saving, setSaving] = useState(false)

  const decide = async (enabled: boolean) => {
    setSaving(true)
    try {
      await onDecision(enabled)
    } catch (error) {
      window.alert(error instanceof Error ? error.message : String(error))
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 px-4 dark:bg-black/70">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="security-suggestion-title"
        className="w-full max-w-[420px] overflow-hidden rounded-xl bg-surface shadow-xl ring-1 ring-line-soft dark:bg-[#141419] dark:shadow-[0_24px_80px_rgba(0,0,0,0.55)] dark:ring-white/10"
      >
        <div className="flex items-start gap-3.5 px-5 pb-4 pt-5">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-blue-50 text-blue-700 ring-1 ring-blue-200 dark:bg-blue-500/15 dark:text-blue-300 dark:ring-blue-400/20">
            <IconShield />
          </div>
          <div className="min-w-0">
            <h2
              id="security-suggestion-title"
              className="text-[15px] font-semibold text-ink"
            >
              {t('settings.securitySuggestionTitle')}
            </h2>
            <p className="mt-1.5 text-[13px] leading-relaxed text-ink-soft">
              {t('settings.securitySuggestionBody')}
            </p>
            <p className="mt-2 text-[12px] leading-relaxed text-ink-faint">
              {t('settings.securitySuggestionNote')}
            </p>
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t border-line-soft bg-sunken px-5 py-3 dark:border-white/10 dark:bg-[#101014]">
          <button
            type="button"
            autoFocus
            disabled={saving}
            onClick={() => void decide(false)}
            className="rounded-lg border border-line bg-surface px-3.5 py-2 text-[13px] font-medium text-ink transition-colors hover:bg-canvas disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/10 dark:bg-[#202027] dark:hover:bg-[#292932]"
          >
            {t('settings.securitySuggestionNotNow')}
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={() => void decide(true)}
            className="rounded-lg bg-accent-strong px-3.5 py-2 text-[13px] font-semibold text-white transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50 dark:bg-blue-500 dark:hover:bg-blue-400"
          >
            {t('settings.securitySuggestionEnable')}
          </button>
        </div>
      </div>
    </div>
  )
}
