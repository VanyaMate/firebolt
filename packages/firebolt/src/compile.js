import fs, { outputFile } from 'fs-extra'
import path from 'path'
import { fileURLToPath } from 'url'
import { fork } from 'child_process'
import { performance } from 'perf_hooks'
import chokidar from 'chokidar'
import * as esbuild from 'esbuild'
import { isEqual, debounce, defaultsDeep } from 'lodash-es'
import mdx from '@mdx-js/esbuild'
import { polyfillNode } from 'esbuild-plugin-polyfill-node'

import * as style from './utils/style'
import * as log from './utils/log'
import { reimport } from './utils/reimport'
import { getFilePaths } from './utils/getFilePaths'
import { fileToRoutePattern } from './utils/fileToRoutePattern'
import {
  BundlerError,
  isEsbuildError,
  logCodeError,
  parseEsbuildError,
  parseServerError,
} from './utils/errors'
import { registryPlugin } from './utils/registryPlugin'
import { zombieImportPlugin } from './utils/zombieImportPlugin'
import { virtualModule } from './utils/virtualModule'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

export async function compile(opts) {
  const prod = !!opts.production
  const env = prod ? 'production' : 'development'

  const dir = __dirname
  const appDir = process.cwd()
  const appPagesDir = path.join(appDir, 'pages')
  const appApiDir = path.join(appDir, 'api')
  const appConfigFile = path.join(appDir, 'firebolt.config.js')

  const buildDir = path.join(appDir, '.firebolt')
  const buildPageShimsDir = path.join(appDir, '.firebolt/page-shims')
  const buildCoreFile = path.join(appDir, '.firebolt/core.js')
  const buildConfigFile = path.join(appDir, '.firebolt/config.js')
  const buildManifestFile = path.join(appDir, '.firebolt/manifest.json')
  const buildLibFile = path.join(appDir, '.firebolt/lib.js')
  const buildBoostrapFile = path.join(appDir, '.firebolt/bootstrap.js')
  const buildRegistryFile = path.join(appDir, '.firebolt/registry.js')
  const buildServerFile = path.join(appDir, '.firebolt/server.js')
  const buildInspectionFile = path.join(appDir, '.firebolt/inspection.js')

  const extrasDir = path.join(dir, '../extras')

  const serverServerFile = path.join(appDir, '.firebolt/server/index.js')

  const tmpConfigFile = path.join(appDir, '.firebolt/tmp/config.js')
  const tmpInspectionFile = path.join(appDir, '.firebolt/tmp/inspection.js')

  let freshBuild = true
  let freshConfig = true
  let config
  let mdxPlugin
  const mdxCache = {} // pageFile -> js
  const ctx = {
    configValidator: null,
    pageInspector: null,
    clientBundles: null,
    serverEntry: null,
  }
  let clientEntryPoints = []

  log.intro()

  async function build() {
    // start tracking build time
    const startAt = performance.now()
    log.info(`${freshBuild ? 'building...' : 'rebuilding...'}`)

    // ensure empty build directory
    if (freshBuild) {
      await fs.emptyDir(buildDir)
    }

    // ensure app has config file
    if (!(await fs.exists(appConfigFile))) {
      throw new BundlerError(`missing ${style.mark('firebolt.config.js')} file`)
    }

    // create config entry
    // todo: couldn't this be an `extras` file?
    if (freshBuild) {
      const configCode = `
        export { default as getConfig } from '../firebolt.config.js'
      `
      await fs.writeFile(buildConfigFile, configCode)
    }

    // temporarily build, import and validate config
    if (!ctx.configValidator) {
      ctx.configValidator = await esbuild.context({
        entryPoints: [buildConfigFile],
        outfile: tmpConfigFile,
        bundle: true,
        treeShaking: true,
        sourcemap: true,
        minify: false,
        platform: 'node',
        format: 'esm',
        packages: 'external',
        logLevel: 'silent',
        define: {
          'process.env.NODE_ENV': JSON.stringify(env),
          FIREBOLT_NODE_ENV: JSON.stringify(env),
        },
        loader: {
          '.js': 'jsx',
        },
        jsx: 'automatic',
        jsxImportSource: '@firebolt/jsx',
        plugins: [
          // mdxPlugin,
        ],
      })
    }
    console.time('configValidator')
    await ctx.configValidator.rebuild()
    console.timeEnd('configValidator')
    const { getConfig } = await reimport(tmpConfigFile)
    config = getConfig()

    defaultsDeep(config, {
      port: 3000,
      productionBrowserSourceMaps: false,
    })

    // create mdx plugin
    // we try to re-use the same mdx plugin across builds for performance
    // but if our config changes then our mdx options might have changed, so we re-create it!
    if (freshConfig) {
      mdxPlugin = mdx({
        jsx: false,
        jsxRuntime: 'automatic',
        jsxImportSource: '@firebolt/jsx',
        remarkPlugins: config.mdx?.remarkPlugins || [],
        rehypePlugins: config.mdx?.rehypePlugins || [],
      })
    }

    // initialize manifest
    const manifest = {
      pageFiles: {},
      bootstrapFile: null,
    }

    // get a list of page files
    const pageFiles = await getFilePaths(appPagesDir, ['js', 'mdx'])

    // generate route details
    let ids = 0
    const routes = []
    for (const pageFile of pageFiles) {
      const id = `route${++ids}`
      const file = pageFile
      const isMDX = pageFile.endsWith('.mdx')
      const prettyFileBase = path.relative(appDir, pageFile)
      const pageFileBase = path.relative(appPagesDir, pageFile)
      let shimFile = path.join(buildPageShimsDir, pageFileBase.replace('/', '.')) // prettier-ignore
      if (isMDX) shimFile = shimFile.replace('.mdx', '.js')
      let shimFileName = path.relative(path.dirname(shimFile), shimFile) // prettier-ignore
      const pattern = fileToRoutePattern('/' + pageFileBase)
      const relBuildToPageFile = path.relative(buildDir, pageFile)
      const relShimToPageFile = path.relative(path.dirname(shimFile), pageFile) // prettier-ignore
      routes.push({
        id,
        file,
        prettyFileBase,
        pattern,
        shimFile,
        shimFileName,
        relBuildToPageFile,
        relShimToPageFile,
        isMDX,
      })
    }

    // sort routes so that explicit routes have priority over dynamic routes
    routes.sort((a, b) => {
      const isDynamicA = a.pattern.includes(':')
      const isDynamicB = b.pattern.includes(':')
      if (isDynamicA && !isDynamicB) {
        return 1
      } else if (!isDynamicA && isDynamicB) {
        return -1
      }
      return 0
    })

    // build any mdx pages missing from our cache.
    // building mdx pages is really slow so we build them once and use their output in future builds (and rebuilds) as a virtual module.
    // our file watcher will evict mdx pages from the cache so they get rebuilt.
    const routesNeedingMDXBuild = routes.filter(route => {
      // if config changed then all mdx pages need building
      if (freshConfig) return route.isMDX
      // otherwise only include mdx pages not cached
      return route.isMDX && !mdxCache[route.file]
    })
    if (routesNeedingMDXBuild.length) {
      console.log(
        'building mdx',
        routesNeedingMDXBuild.map(r => r.prettyFileBase)
      )
      console.time('mdx')
      const result = await esbuild.build({
        entryPoints: routesNeedingMDXBuild.map(r => r.file),
        outdir: 'out',
        write: false,
        // bundle: true,
        // treeShaking: true,
        // sourcemap: true,
        // minify: false,
        platform: 'neutral',
        format: 'esm',
        packages: 'external',
        // external: ['react', 'react-dom', '@firebolt/jsx'],
        // external: [],
        logLevel: 'silent',
        // alias: {
        //   firebolt: buildLibFile,
        // },
        define: {
          'process.env.NODE_ENV': JSON.stringify(env),
          FIREBOLT_NODE_ENV: JSON.stringify(env),
        },
        // loader: {
        //   '.js': 'jsx',
        // },
        // jsx: 'automatic',
        // jsxImportSource: '@firebolt/jsx',
        plugins: [mdxPlugin, zombieImportPlugin],
      })
      // todo: this doesn't feel like a robust way to match output files
      // back to routes but it seems to work :sweat:
      let i = 0
      for (let out of result.outputFiles) {
        const route = routesNeedingMDXBuild[i]
        // console.log(route.file)
        // console.log(out.path)
        mdxCache[route.file] = out.text
        console.log(out.text)
        i++
      }
      console.timeEnd('mdx')
    }

    // copy over extras
    if (freshBuild) {
      await fs.copy(extrasDir, buildDir)
    }

    // build and inspect pages
    const inspectionCode = `
      ${routes.map(route => `export * as ${route.id} from '${route.relBuildToPageFile}'`).join('\n')}
    `
    await fs.outputFile(buildInspectionFile, inspectionCode)
    if (!ctx.pageInspector) {
      ctx.pageInspector = await esbuild.context({
        entryPoints: [buildInspectionFile],
        outfile: tmpInspectionFile,
        bundle: true,
        treeShaking: true,
        sourcemap: true,
        minify: false,
        platform: 'node',
        format: 'esm',
        packages: 'external',
        // external: ['react', 'react-dom', '@firebolt/jsx'],
        // external: [],
        logLevel: 'silent',
        alias: {
          firebolt: buildLibFile,
        },
        define: {
          'process.env.NODE_ENV': JSON.stringify(env),
          FIREBOLT_NODE_ENV: JSON.stringify(env),
        },
        loader: {
          '.js': 'jsx',
        },
        jsx: 'automatic',
        jsxImportSource: '@firebolt/jsx',
        plugins: [
          // mdxPlugin,
          virtualModule(mdxCache),
        ],
      })
    }
    console.time('pageInspector')
    await ctx.pageInspector.rebuild()
    console.timeEnd('pageInspector')
    const inspection = await reimport(tmpInspectionFile)
    // console.log('inspection', inspection)
    for (const route of routes) {
      if (!inspection[route.id].default) {
        throw new BundlerError(
          `missing default page export for ${style.mark(route.prettyFileBase)}`
        )
      }
      if (route.isMDX && inspection[route.id].components) {
        route.hasMDXComponents = true
      }
    }

    // create core
    const coreCode = `
      ${routes.map(route => `import * as ${route.id} from '${route.relBuildToPageFile}'`).join('\n')}
      export const routes = [
        ${routes
          .map(route => {
            return `
            {
              module: ${route.id},
              id: '${route.id}',
              prettyFileBase: '${route.prettyFileBase}',
              pattern: '${route.pattern}',
              shimFile: '${route.shimFile}',
              shimFileName: '${route.shimFileName}',
              relBuildToPageFile: '${route.relBuildToPageFile}',
              relShimToPageFile: '${route.relShimToPageFile}',
              Page: ${route.hasMDXComponents ? `function MDXPage() { return <${route.id}.default components={${route.id}.components} /> }` : `${route.id}.default`},
            },
          `
          })
          .join('\n')}
      ]
    `
    await fs.outputFile(buildCoreFile, coreCode)

    // generate page shims for client (tree shaking)
    // TODO: can't we just import * and always use a wrapper for simplicity?
    for (const route of routes) {
      let code
      if (route.hasMDXComponents) {
        code = `
          import Page, { components } from '${route.relShimToPageFile}'
          function MDXPage() {
            return <Page components={components} />
          }
          globalThis.$firebolt.push('registerPage', '${route.id}', MDXPage)
        `
      } else {
        code = `
          import Page from '${route.relShimToPageFile}'
          globalThis.$firebolt.push('registerPage', '${route.id}', Page)
        `
      }
      await fs.outputFile(route.shimFile, code)
    }

    const registry = {} // [id]: { file, fnName }

    // build client bundles (pages + chunks + bootstrap)
    const publicDir = path.join(buildDir, 'public')
    const newClientEntryPoints = []
    for (const route of routes) {
      newClientEntryPoints.push(route.shimFile)
    }
    newClientEntryPoints.push(buildBoostrapFile)
    let clientEntryPointsChanged = !isEqual(
      clientEntryPoints,
      newClientEntryPoints
    )
    if (clientEntryPointsChanged) {
      clientEntryPoints = newClientEntryPoints
    }
    if (!ctx.clientBundles || freshConfig || clientEntryPointsChanged) {
      // config changes require new mdxPlugin + productionBrowserSourceMaps value
      ctx.clientBundles = await esbuild.context({
        entryPoints: clientEntryPoints,
        entryNames: '/[name]-[hash]',
        outdir: publicDir,
        bundle: true,
        treeShaking: true,
        sourcemap: prod ? config.productionBrowserSourceMaps : true,
        splitting: true,
        platform: 'browser',
        // mainFields: ["browser", "module", "main"],
        // external: ['fs', 'path', 'util'],
        format: 'esm',
        minify: prod,
        metafile: true,
        logLevel: 'silent',
        alias: {
          firebolt: buildLibFile,
        },
        define: {
          'process.env.NODE_ENV': JSON.stringify(env),
          FIREBOLT_NODE_ENV: JSON.stringify(env),
        },
        loader: {
          '.js': 'jsx',
        },
        jsx: 'automatic',
        jsxImportSource: '@firebolt/jsx',
        plugins: [
          // mdxPlugin,
          virtualModule(mdxCache),
          registryPlugin({ registry }),
          // polyfill fs, path etc for browser environment
          // polyfillNode({}),
          // ensure pages are marked side-effect free for tree shaking
          // {
          //   name: 'no-side-effects',
          //   setup(build) {
          //     build.onResolve({ filter: /.*/ }, async args => {
          //       // ignore this if we called ourselves
          //       if (args.pluginData) return
          //       console.log(args.path)
          //       const { path, ...rest } = args
          //       // avoid infinite recursion
          //       rest.pluginData = true
          //       const result = await build.resolve(path, rest)
          //       result.sideEffects = false
          //       return result
          //     })
          //   },
          // },
        ],
      })
    }
    console.time('clientBundles')
    const bundleResult = await ctx.clientBundles.rebuild()
    console.timeEnd('clientBundles')
    // reconcile hashed build files with their source
    const metafile = bundleResult.metafile
    for (const file in metafile.outputs) {
      const output = metafile.outputs[file]
      if (output.entryPoint) {
        // page wrappers
        if (output.entryPoint.startsWith('.firebolt/page-shims/')) {
          const shimFileName = output.entryPoint.replace('.firebolt/page-shims/', '') // prettier-ignore
          const route = routes.find(route => {
            return route.shimFileName === shimFileName
          })
          manifest.pageFiles[route.id] = file.replace(
            '.firebolt/public',
            '/_firebolt'
          )
        }
        // bootstrap
        if (output.entryPoint === '.firebolt/bootstrap.js') {
          manifest.bootstrapFile = file.replace('.firebolt/public', '/_firebolt') // prettier-ignore
        }
      }
    }
    await fs.outputFile(buildManifestFile, JSON.stringify(manifest, null, 2))

    // generate our registry file
    const getRegistryRelPath = file => path.relative(buildDir, file)
    const registryCode = `
      ${Object.keys(registry)
        .map(
          id =>
            `export { ${registry[id].fnName} as ${id} } from '${getRegistryRelPath(registry[id].file)}'`
        )
        .join('\n')}      
    `
    await fs.outputFile(buildRegistryFile, registryCode)

    // build server entry
    if (!ctx.serverEntry || freshConfig) {
      // config changes require new mdxPlugin
      ctx.serverEntry = await esbuild.context({
        entryPoints: [buildServerFile],
        outfile: serverServerFile,
        bundle: true,
        treeShaking: true,
        sourcemap: true,
        minify: prod,
        platform: 'node',
        format: 'esm',
        packages: 'external',
        logLevel: 'silent',
        alias: {
          firebolt: buildLibFile,
        },
        define: {
          'process.env.NODE_ENV': JSON.stringify(env),
          FIREBOLT_NODE_ENV: JSON.stringify(env),
        },
        loader: {
          '.js': 'jsx',
        },
        jsx: 'automatic',
        jsxImportSource: '@firebolt/jsx',
        plugins: [
          mdxPlugin,
          registryPlugin({ registry: null }), // dont write to registry, we already have it from the client bundles
        ],
      })
    }
    console.time('serverEntry')
    await ctx.serverEntry.rebuild()
    console.timeEnd('serverEntry')
    const elapsed = (performance.now() - startAt).toFixed(0)
    log.info(`${freshBuild ? 'built' : 'rebuilt'} ${style.dim(`(${elapsed}ms)`)}\n`) // prettier-ignore
    freshBuild = false
    freshConfig = false
  }

  let server
  let controller

  async function serve() {
    let SILENT_STARTUP
    if (server) {
      SILENT_STARTUP = config && config.port === server.port ? 'yes' : undefined
    }
    // destroy previous server if any
    if (server) {
      await new Promise(resolve => {
        server.once('exit', resolve)
        controller.abort()
      })
      controller = null
      server = null
    }
    // spawn server
    controller = new AbortController()
    server = fork(serverServerFile, {
      signal: controller.signal,
      env: { SILENT_STARTUP },
    })
    server.port = config?.port
    server.on('error', err => {
      // ignore abort signals
      if (err.code === 'ABORT_ERR') return
      // log other errors
      console.log('server error')
      console.error(err)
    })
    await new Promise(resolve => {
      server.once('message', msg => {
        if (msg === 'ready') resolve()
      })
    })
    server.on('message', msg => {
      if (msg.type === 'error') {
        logCodeError(parseServerError(msg.error, appDir))
      }
    })
  }

  // ensure any running server is killed on exit
  process.on('exit', () => {
    controller?.abort()
  })

  let runInProgress = false
  let runPending = false

  // handle bundler runs/re-runs safely
  const run = async () => {
    // if run is called while another run is in progress we
    // queue it up to re-run again after
    if (runInProgress) {
      runPending = true
      return
    }
    runInProgress = true
    // build
    if (opts.build) {
      try {
        await build()
      } catch (err) {
        if (err instanceof BundlerError) {
          log.error(err.message)
        } else if (isEsbuildError(err)) {
          logCodeError(parseEsbuildError(err))
        } else {
          log.error('\n')
          console.error(err)
        }
        runInProgress = false
        runPending = false
        return
      }
    }
    // only serve if there isn't anothe run pending
    if (opts.serve && !runPending) {
      await serve()
    }
    runInProgress = false
    // if another run was queued, lets run it again!
    if (runPending) {
      runPending = false
      run()
    }
  }

  // execute our initial run
  await run()

  // watch for file changes and then re-run the bundler
  if (opts.watch) {
    const watchOptions = {
      ignoreInitial: true,
      ignored: ['**/.firebolt/**'],
    }
    const watcher = chokidar.watch([appDir], watchOptions)
    const onChange = async (type, file) => {
      const relFile = path.relative(appDir, file)
      log.change(`~/${relFile}`)

      // track config file changes
      if (relFile === 'firebolt.config.js') {
        freshConfig = true
      }

      // track mdx pages and evict from cache
      if (relFile.endsWith('.mdx')) {
        delete mdxCache[file]
      }

      run()
    }
    watcher.on('all', debounce(onChange))
  }

  // todo: isolated builds don't exit the process automatically so
  // for now we just force exit.
  if (!opts.serve && !opts.watch) {
    process.exit()
  }
}
