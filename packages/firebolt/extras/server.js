import './process'
import { renderToPipeableStream } from 'react-dom/server'
import React from 'react'
import { isbot } from 'isbot'
import { PassThrough } from 'stream'
import { Root } from 'firebolt'

import { matcher } from './matcher'
import { config } from './config.js'
import routes from './routes.js'
import api from './api.js'
import manifest from './manifest.json'
import * as registry from './registry'
import { cookieOptionsToExpress } from './cookies'
import { createRuntime } from './runtime'
import { FireboltRequest, FireboltResponse } from './request'

// suppress React warning about useLayoutEffect on server, this is nonsense because useEffect
// is similar and doesn't warn and is allowed in SSR
// see: https://gist.github.com/gaearon/e7d97cdf38a2907924ea12e4ebdf3c85
React.useLayoutEffect = React.useEffect

const match = matcher()

const prod = process.env.NODE_ENV === 'production'

export { config }

// provide Request global for api routes
globalThis.Response = FireboltResponse

// hydrate manifest
const bootstrapFile = manifest.bootstrapFile
// TODO: why can't these just be in routes.js?
for (const route of routes) {
  route.file = manifest.pageFiles[route.id]
}

// build route definitions to be used by the client
const routesForClient = routes.map(route => {
  return {
    id: route.id,
    pattern: route.pattern,
    file: route.file,
  }
})

const notFoundRoute = routes.find(r => r.pattern === '/not-found')

const defaultCookieOptions = config.cookie

// utility to find an api route from a url
function resolveApiAndParams(url) {
  url = url.slice(4) // remove /api prefix
  for (const route of api) {
    const [hit, params] = match(route.pattern, url)
    if (hit) return [route, params]
  }
  return [null, {}]
}

// utility to find a route from a url
function resolveRouteAndParams(url) {
  if (!url) {
    return [null, {}]
  }
  for (const route of routes) {
    const [hit, params] = match(route.pattern, url)
    if (hit) return [route, params]
  }
  return [null, {}]
}

// utility to call loader/action functions
async function callFunction(req, id, args) {
  await config.decorate(req)
  const fn = registry[id]
  if (!fn) throw new Error('Invalid function')
  let value = fn(req, ...args)
  if (value instanceof Promise) {
    value = await value
  }
  return value
}

// handle loader/action function call requests from the client
export async function handleFunction(req, res) {
  const { id, args } = req.body
  const fireboltRequest = new FireboltRequest({
    ctx: 'fn',
    xReq: req,
    params: {},
    defaultCookieOptions,
  })
  await config.decorate(fireboltRequest)
  let value
  let error
  try {
    value = await callFunction(fireboltRequest, id, args)
  } catch (err) {
    error = err
  }
  const data = {}
  // get changed cookies to notify client UI
  data.cookies = fireboltRequest.cookies._getChanged()
  // apply cookie changes to express response
  fireboltRequest.cookies._pushChangesToExpressResponse(res)
  // handle redirect if any
  if (error === fireboltRequest && error._redirectInfo) {
    data.redirect = error._redirectInfo
    return res.status(200).json(data)
  }
  if (error) {
    data.error = serializeFunctionError(error, prod)
    return res.status(400).json(data)
  }
  // otherwise respond with the return value
  data.value = value
  data.expire = fireboltRequest._expire
  res.status(200).json(data)
}

export async function handleApi(req, res) {
  const url = req.originalUrl
  const method = req.method.toLowerCase()

  const [route, params] = resolveApiAndParams(url)

  if (!route || !route.module[method]) {
    return res.status(404).end()
  }

  const fireboltRequest = new FireboltRequest({
    ctx: 'api',
    xReq: req,
    params,
    defaultCookieOptions,
  })
  let result
  try {
    result = route.module[method](fireboltRequest)
    if (result instanceof Promise) {
      result = await result
    }
  } catch (err) {
    console.error('Received error from API Route:')
    console.error(err)
    return res.status(500).end()
  }
  // apply any cookie changes
  fireboltRequest.cookies._pushChangesToExpressResponse(res)
  // if result is a FireboltResponse, pipe it through
  if (result instanceof FireboltResponse) {
    return result.applyToExpressResponse(res)
  }
  // otherwise assume json
  return res.json(result)
}

// handle requests for pages
export async function handlePage(req, res) {
  let url = req.originalUrl

  // handle page requests
  let [route, params] = resolveRouteAndParams(url)

  let notFound
  if (!route) {
    notFound = true
    route = notFoundRoute
    url = '/not-found'
  }

  const inserts = {
    value: '',
    read() {
      const str = this.value
      this.value = ''
      return str
    },
    write(str) {
      this.value += str
    },
  }

  const cookies = {
    get(key) {
      // console.log('s.cookies.get', key, req.cookies[key])
      return req.cookies[key]
    },
    set(key, value, options) {
      // console.log('s.cookies.set', key, value, options)
      res.cookie(key, value, cookieOptionsToExpress(options))
    },
    remove(key) {
      // console.log('scookies.remove', key)
      res.clearCookie(key)
    },
  }

  const options = {
    ssr: {
      url,
      params,
      inserts,
      cookies,
      async callFunction(...args) {
        const fireboltRequest = new FireboltRequest({
          ctx: 'page',
          xReq: req,
          params,
          defaultCookieOptions,
        })
        let value
        let error
        try {
          value = await callFunction(fireboltRequest, ...args)
        } catch (err) {
          error = err
        }
        // write out any cookies first
        fireboltRequest.cookies._pushChangesToStream(inserts)
        // if FireboltRequest error, write out the redirect and stop
        if (error instanceof FireboltRequest && error._redirectInfo) {
          return fireboltRequest._applyRedirectToExpressResponse(res)
        }
        // if FireboltRequest error or generic, return the error
        if (error) {
          return {
            error: serializeFunctionError(error, prod),
          }
        }
        // otherwise return the value
        const data = {
          value,
          expire: request._expire,
        }
        return data
      },
    },
    routes,
  }

  const runtime = createRuntime([['init', options]])

  const isBot = isbot(req.get('user-agent') || '')

  const stream = new PassThrough()
  stream.on('data', chunk => {
    let str = chunk.toString()

    // append any inserts (loader data, redirects etc)
    if (str.endsWith('</script>')) {
      str += inserts.read()
    }

    // console.log('---')
    // console.log(str)
    res.write(str)
    res.flush()
  })
  stream.on('end', () => {
    res.end()
  })

  let didError = false
  const { pipe, abort } = renderToPipeableStream(<Root runtime={runtime} />, {
    bootstrapScriptContent: isBot
      ? undefined
      : `
      globalThis.$firebolt = function (...args) {
        globalThis.$firebolt.stack.push(args)
      }
      globalThis.$firebolt.stack = []
      globalThis.$firebolt('init', {
        ssr: null,
        routes: ${JSON.stringify(routesForClient)},
        defaultCookieOptions: ${JSON.stringify(config.cookie)},
      })
    `,
    bootstrapModules: isBot ? [] : [route.file, bootstrapFile],
    onShellReady() {
      if (!isBot) {
        res.statusCode = notFound ? 404 : didError ? 500 : 200
        res.setHeader('Content-Type', 'text/html')
        pipe(stream)
      }
    },
    onAllReady() {
      if (isBot) {
        res.statusCode = notFound ? 404 : didError ? 500 : 200
        res.setHeader('Content-Type', 'text/html')
        // pipe(res)
        pipe(stream)
      }
    },
    onError(error) {
      console.error(error)
    },
    onShellError(err) {
      console.error(err)
      res.statusCode = 500
      res.setHeader('content-type', 'text/html')
      res.send('<p>Something went wrong</p>')
    },
  })
}

function serializeFunctionError(error, prod) {
  if (error instanceof FireboltRequest) {
    return {
      name: error._errorInfo.name,
      message: error._errorInfo.message,
      data: error._errorInfo.data,
    }
  }
  if (prod) {
    return {
      name: 'Error',
      message: 'An error occurred',
      data: {},
    }
  }
  return {
    name: error.name,
    message: error.message,
    data: {},
  }
}
