import { loadEnvFile } from 'node:process'
import { createApp } from './app.js'
for(const path of ['.env','.env.local']) { try { loadEnvFile(path) } catch { /* Optional configuration, never a fallback. */ } }
createApp().listen(8787,'127.0.0.1',()=>console.log('Jev API server: http://127.0.0.1:8787'))
