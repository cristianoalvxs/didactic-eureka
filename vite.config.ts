import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src',
  base: './',
  build: {
    outDir: '../renderer-dist',
    emptyOutDir: true,
  },
});
