import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';
export default defineConfig(({mode})=>({
  plugins:[react(),...(mode==='singlefile'?[viteSingleFile()]:[])],
  base:mode==='singlefile'?'./':'/',
  server:{proxy:{'/api':'http://localhost:4000'}}
}));
