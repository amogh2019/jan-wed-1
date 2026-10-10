/** @type {import('tailwindcss').Config} */
const kumkum = { 50: '#fdf3f4', 100: '#fbe5e8', 200: '#f5c4cb', 300: '#ec96a3', 400: '#d95d72', 500: '#bb2f48', 600: '#9b1c34', 700: '#7f162b', 800: '#641224', 900: '#4a0d1a' };

module.exports = {
  content: ['./index.html', './app.js'],
  theme: {
    extend: {
      colors: {
        kumkum,
        brand: kumkum, // legacy alias
        marigold: { 50: '#fff8eb', 100: '#ffeec7', 200: '#ffdb8a', 300: '#ffc34d', 400: '#ffaa1f', 500: '#f98c07', 600: '#dd6902', 700: '#b74906', 800: '#94380c', 900: '#7a2f0d' },
        haldi: { 50: '#fdf9ec', 100: '#fbf1d3', 200: '#f6e0a3', 300: '#eecb6c', 400: '#e3b23f', 500: '#c9962b', 600: '#a7741f', 700: '#86591a', 800: '#6b4616' },
        mehndi: { 50: '#f1f8ee', 100: '#ddeed6', 200: '#bfdcb2', 300: '#9cc78a', 400: '#73a95f', 500: '#4f8a3c', 600: '#3e7030', 700: '#2f5626', 800: '#26441f' },
        ivory: { 50: '#fffdf8', 100: '#fffaf0', 200: '#f8efdc', 300: '#efe0c2' },
        ink: { 300: '#bfaea4', 400: '#9a8478', 500: '#7a6359', 600: '#5c4740', 700: '#3f2e29', 800: '#30221c', 900: '#24170f' },
      },
      fontFamily: {
        display: ['"Yatra One"', 'Georgia', 'serif'],
        sans: ['Poppins', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
      },
      boxShadow: {
        card: '0 1px 2px rgb(74 13 26 / .05), 0 4px 16px -4px rgb(74 13 26 / .08)',
        lift: '0 10px 30px -10px rgb(127 22 43 / .45)',
      },
    },
  },
};
