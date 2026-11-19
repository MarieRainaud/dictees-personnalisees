import {defineConfig} from 'vite';
export default defineConfig({build:{target:'es2022'},server:{proxy:{'/api':'http://127.0.0.1:8122','/auth':'http://127.0.0.1:8122'}}});
