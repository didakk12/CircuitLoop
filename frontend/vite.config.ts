import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

/**
 * The dev server proxies /api to the backend so the app and the API share one
 * origin.
 *
 * This is required by the httpOnly session cookie, not a convenience: the app
 * on localhost:5173 and the API on 127.0.0.1:8000 are different hosts, so a
 * browser treats them as cross-site and withholds a SameSite=Lax cookie.
 * SameSite=None would need Secure, which plain http:// dev cannot provide.
 * Proxying makes both same-origin, so the cookie is sent normally and no CORS
 * preflight is involved.
 */
const BACKEND_URL = process.env.VITE_BACKEND_URL ?? 'http://127.0.0.1:8000'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: BACKEND_URL,
        changeOrigin: false,
      },
    },
  },
})
