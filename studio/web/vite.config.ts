import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Dev: the FastAPI backend (python -m kgstudio) runs on :8000 and Vite proxies /api to it.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:8000', changeOrigin: true },
    },
  },
})
