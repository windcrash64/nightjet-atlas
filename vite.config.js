import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: { target: 'es2022' },
  // react-three-fiber keeps its store in module scope. If Vite pre-bundles
  // drei and fiber into separate chunks, drei's <Line> looks up a *different*
  // store than <Canvas> created and throws "Hooks can only be used within the
  // Canvas component". Optimising them together keeps one instance.
  optimizeDeps: { include: ['three', '@react-three/fiber', '@react-three/drei'] },
  resolve: { dedupe: ['three', '@react-three/fiber', 'react', 'react-dom'] },
  server: { proxy: { '/api': 'http://127.0.0.1:8080' } },
});
