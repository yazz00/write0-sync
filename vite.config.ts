import path from 'path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // Chemins relatifs : le build fonctionne à la racine du site comme dans un sous-dossier.
  base: './',
  server: {
    port: 3000,
    // En dev, api.php est servi par `php -S 127.0.0.1:8765 -t server` (voir README).
    proxy: { '/api.php': 'http://127.0.0.1:8765' },
  },
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
});
