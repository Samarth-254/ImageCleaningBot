/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  darkMode: 'media',
  theme: {
    extend: {
      colors: {
        wa: {
          header: '#075E54',
          headerDark: '#202C33',
          bg: '#ECE5DD',
          bgDark: '#0B141A',
          out: '#DCF8C6',
          outDark: '#005C4B',
          in: '#FFFFFF',
          inDark: '#202C33',
          teal: '#128C7E',
          green: '#25D366',
          tickBlue: '#53BDEB',
        },
      },
      keyframes: {
        msgIn: {
          '0%': { opacity: '0', transform: 'translateY(8px) scale(0.98)' },
          '100%': { opacity: '1', transform: 'translateY(0) scale(1)' },
        },
      },
      animation: {
        msgIn: 'msgIn 180ms ease-out forwards',
      },
    },
  },
  plugins: [],
};
