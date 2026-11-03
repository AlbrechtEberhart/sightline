// Small UI helpers shared by both apps. No dependencies.

export function showError(container, { title, body, actions = [] }) {
  const card = document.createElement('div')
  card.className = 'error-card'
  card.setAttribute('role', 'alert')
  const h = document.createElement('h2')
  h.textContent = title || 'Something went wrong'
  card.append(h)
  if (body) {
    const p = document.createElement('p')
    p.textContent = body
    card.append(p)
  }
  if (actions.length) {
    const row = document.createElement('div')
    row.className = 'actions'
    for (const { label, onClick } of actions) {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'pill'
      b.textContent = label
      b.addEventListener('click', (e) => onClick?.(e))
      row.append(b)
    }
    card.append(row)
  }
  container.append(card)
  return card
}

export function formatEta(seconds) {
  if (!Number.isFinite(seconds)) return '—'
  const s = Math.max(0, Math.round(seconds))
  if (s < 60) return `${s} s`
  const m = Math.floor(s / 60)
  return `${m} min ${String(s % 60).padStart(2, '0')} s`
}

export function loadSettings(key, defaults) {
  try {
    const raw = window.localStorage.getItem(key)
    if (raw == null) return { ...defaults }
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return { ...defaults, ...parsed }
  } catch { /* storage blocked or corrupt: fall back to defaults */ }
  return { ...defaults }
}

export function saveSettings(key, obj) {
  try {
    window.localStorage.setItem(key, JSON.stringify(obj))
    return true
  } catch {
    return false
  }
}
