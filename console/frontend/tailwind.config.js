/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        dark: {
          canvas: '#0f172a',
          card: '#1e293b',
          'card-hover': '#243247',
          border: '#334155',
          'border-subtle': '#1e293b',
          highlight: '#38bdf8'
        },
        accent: {
          primary: '#38bdf8',
          alert: '#8b5cf6',
          purple: '#a855f7'
        },
        neon: {
          emerald: '#10b981',
          cyan: '#38bdf8',
          sky: '#38bdf8',
          indigo: '#6366f1',
          violet: '#8b5cf6',
          purple: '#a855f7',
          rose: '#f43f5e',
          red: '#ef4444',
          amber: '#f59e0b'
        }
      },
      fontFamily: {
        sans: ['Geist', 'Inter', 'DM Sans', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'Fira Code', 'monospace']
      },
      animation: {
        'pulse-subtle': 'pulse-subtle 3s ease-in-out infinite',
        'pulse-danger': 'pulse-danger 1.5s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        radar: 'radar 4s linear infinite'
      },
      keyframes: {
        'pulse-danger': {
          '0%, 100%': { opacity: '1', transform: 'scale(1)', boxShadow: '0 0 15px rgba(239, 68, 68, 0.6)' },
          '50%': { opacity: '0.85', transform: 'scale(1.02)', boxShadow: '0 0 25px rgba(239, 68, 68, 0.9)' }
        }
      }
    }
  },
  plugins: []
};
