module.exports = {
  sourceDir: 'dist/firefox',
  artifactsDir: 'dist',
  build: {
    overwriteDest: true,
  },
  run: {
    firefox: '/Applications/Firefox.app/Contents/MacOS/firefox',
    startUrl: ['https://www.komoot.com/plan'],
    browserConsole: false,
  },
  ignoreFiles: ['.DS_Store'],
};
