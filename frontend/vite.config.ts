import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
  },
  define: {
    'process.env.NODE_ENV': '"production"',
  },
  build: {
    lib: {
      entry: 'src/components/ChatWidget/index.ts',
      name: 'AIChatWidget',
      fileName: (format) => `ai-chat-widget.${format}.js`,
      formats: ['iife'],
    },
  },
})
