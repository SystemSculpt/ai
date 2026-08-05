import { useCallback, useEffect, useRef } from 'react'
import type { TextareaHTMLAttributes } from 'react'

type Props = Omit<
  TextareaHTMLAttributes<HTMLTextAreaElement>,
  'rows' | 'onChange'
> & {
  value: string
  onChange: (value: string) => void
  /** Minimum visible lines when empty. Default 3. */
  minRows?: number
  /** Cap growth so the page stays scrollable. Default 16. */
  maxRows?: number
}

/**
 * Textarea that grows with its content up to `maxRows`, then scrolls inside.
 * Used for Seedance prompts (studio + chat) so long briefs don't feel cramped.
 */
export default function AutoGrowTextarea({
  value,
  onChange,
  minRows = 3,
  maxRows = 16,
  className = '',
  ...rest
}: Props) {
  const ref = useRef<HTMLTextAreaElement>(null)

  const resize = useCallback(() => {
    const el = ref.current
    if (!el) return
    // Reset height so scrollHeight reflects content, not the previous box.
    el.style.height = 'auto'
    const styles = window.getComputedStyle(el)
    const lineHeight = Number.parseFloat(styles.lineHeight) || 20
    const paddingY =
      Number.parseFloat(styles.paddingTop) +
      Number.parseFloat(styles.paddingBottom)
    const borderY =
      Number.parseFloat(styles.borderTopWidth) +
      Number.parseFloat(styles.borderBottomWidth)
    const minH = lineHeight * minRows + paddingY + borderY
    const maxH = lineHeight * maxRows + paddingY + borderY
    const next = Math.min(maxH, Math.max(minH, el.scrollHeight))
    el.style.height = `${next}px`
    el.style.overflowY = el.scrollHeight > maxH ? 'auto' : 'hidden'
  }, [minRows, maxRows])

  useEffect(() => {
    resize()
  }, [value, resize])

  return (
    <textarea
      {...rest}
      ref={ref}
      value={value}
      rows={minRows}
      onChange={(event) => onChange(event.target.value)}
      className={`resize-none overflow-hidden ${className}`}
    />
  )
}
