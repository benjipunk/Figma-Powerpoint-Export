// Bundles src/code.ts -> dist/code.js and src/ui.ts (+ src/ui.html) -> dist/ui.html
// Usage: node build.js [--watch]
const esbuild = require('esbuild')
const fs = require('fs')
const path = require('path')

const watch = process.argv.includes('--watch')
const dist = path.join(__dirname, 'dist')
fs.mkdirSync(dist, { recursive: true })

function inlineUi() {
  let html = fs.readFileSync(path.join(__dirname, 'src/ui.html'), 'utf8')
  const js = fs.readFileSync(path.join(dist, 'ui.js'), 'utf8').replace(/<\/script/gi, '<\\/script')
  if (!html.includes('/*BUILD_INJECT_SCRIPT*/')) throw new Error('src/ui.html is missing the /*BUILD_INJECT_SCRIPT*/ marker')
  fs.writeFileSync(path.join(dist, 'ui.html'), html.replace('/*BUILD_INJECT_SCRIPT*/', () => js))
  fs.unlinkSync(path.join(dist, 'ui.js'))
}

const codeOpts = {
  entryPoints: ['src/code.ts'],
  bundle: true,
  outfile: 'dist/code.js',
  target: 'es2020',
  format: 'iife',
  logLevel: 'info',
}

const uiOpts = {
  entryPoints: ['src/ui.ts'],
  bundle: true,
  outfile: 'dist/ui.js',
  target: 'es2020',
  format: 'iife',
  platform: 'browser',
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'info',
  plugins: [
    {
      name: 'inline-ui',
      setup(build) {
        build.onEnd((result) => {
          if (result.errors.length === 0) inlineUi()
        })
      },
    },
  ],
}

async function main() {
  if (watch) {
    const [codeCtx, uiCtx] = await Promise.all([esbuild.context(codeOpts), esbuild.context(uiOpts)])
    await Promise.all([codeCtx.watch(), uiCtx.watch()])
    // Rebuild ui when the html template changes too.
    fs.watch(path.join(__dirname, 'src/ui.html'), () => uiCtx.rebuild().catch(() => {}))
    console.log('Watching src/ …')
  } else {
    await esbuild.build(codeOpts)
    await esbuild.build(uiOpts)
    const sizes = ['code.js', 'ui.html'].map((f) => `${f} ${(fs.statSync(path.join(dist, f)).size / 1024).toFixed(0)} KB`)
    console.log('Built dist/: ' + sizes.join(', '))
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
