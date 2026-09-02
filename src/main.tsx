import React from 'react'
import { createRoot } from 'react-dom/client'
import './styles/base.css'
import './styles/annotations.css'
import './styles/design-platform.css'
import './styles/scrollbar.css'
import { App } from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
createRoot(document.getElementById('root')!).render(<React.StrictMode><ErrorBoundary><App /></ErrorBoundary></React.StrictMode>)
