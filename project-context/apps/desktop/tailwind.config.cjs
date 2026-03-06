module.exports = {
  content: [
    "./src/renderer/**/*.{ts,tsx,html}",
    "./index.html"
  ],
  theme: {
    extend: {
      fontFamily: {
        display: ["\"DM Serif Display\"", "serif"],
        body: ["\"IBM Plex Sans\"", "\"Avenir Next\"", "sans-serif"]
      }
    }
  },
  plugins: []
};
