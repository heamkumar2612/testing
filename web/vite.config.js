import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';

export default defineConfig(({mode})=>({
  plugins:[react(),...(mode==='singlefile'?[viteSingleFile()]:[])],
  // GitHub Pages serves this project from the repository path.
  base:mode==='singlefile'?'./':'/kairos/',
  server:{proxy:{'/api':'http://localhost:4000'}}
}));
