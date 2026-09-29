const $ = (id) => document.getElementById(id)
const label = (k) => k.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())

async function get(path) {
  const r = await fetch(path)
  if (!r.ok) throw new Error(`${path} → HTTP ${r.status}`)
  return r.json()
}

async function refresh() {
  try {
    const status = await get('/api/status')
    $('status').innerHTML = Object.entries(status).map(([k, v]) => {
      const ok = String(v).startsWith('healthy')
      return `<li><span>${label(k)}</span><span class="${ok ? 'healthy' : 'unhealthy'}" title="${v}">${ok ? 'Healthy' : 'Unhealthy'}</span></li>`
    }).join('')
  } catch (e) {
    $('status').innerHTML = `<li class="unhealthy">Backend unreachable: ${e.message}</li>`
  }
  try {
    const s = await get('/api/state')
    const inst = s.snapshot?.instance ?? {}
    const rows = { Tick: s.tick ?? 'waiting for first snapshot', 'Sim time': inst.sim_time ?? '—', Status: inst.status ?? '—',
      'Data age': s.age_seconds != null ? `${s.age_seconds.toFixed(1)} s` : '—', Stale: s.stale ? 'yes' : 'no' }
    $('state').innerHTML = Object.entries(rows).map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')
  } catch (e) {
    $('state').innerHTML = `<dt>Error</dt><dd class="unhealthy">${e.message}</dd>`
  }
}

refresh()
setInterval(refresh, 3000)
