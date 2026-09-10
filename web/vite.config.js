import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';

export default defineConfig(({mode})=>({
  plugins:[react(),...(mode==='singlefile'?[viteSingleFile()]:[])],
  // Deploy the standard production build at the site root.  A `/testing/`
  // base makes Vite request assets from a path that most hosts do not serve.
  base:mode==='singlefile'?'./':'/',
  server:{proxy:{'/api':'http://localhost:4000'}}
}));
