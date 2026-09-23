import { createApp } from 'vue'

import App from './App.vue'

import 'element-plus/theme-chalk/dark/css-vars.css'
import './style.css'

document.documentElement.classList.add('dark')

createApp(App).mount('#app')
