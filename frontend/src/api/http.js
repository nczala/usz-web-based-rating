const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL ??
  import.meta.env.VITE_BACKEND_URL ??
  'http://localhost:8000'

export async function request(path, options = {}) {
  const headers = {
    ...options.headers,
  }

  if (options.body && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json'
  }

  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    credentials: options.credentials ?? 'include',
    headers,
  })

  const contentType = response.headers.get('content-type') ?? ''

  if (!response.ok) {
    let message = `Request failed with status ${response.status}`

    if (contentType.includes('application/json')) {
      const payload = await response.json()
      message = payload?.detail ?? message
    } else {
      const text = await response.text()
      if (text) {
        message = text
      }
    }

    throw new Error(message)
  }

  if (response.status === 204) {
    return null
  }

  if (contentType.includes('application/json')) {
    return response.json()
  }

  return response.text()
}
