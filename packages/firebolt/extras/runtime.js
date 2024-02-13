import { produce } from 'immer'
import cookie from 'cookiejs'

import { matcher } from './matcher.js'

const match = matcher()

export function createRuntime({ ssr, routes, stack = [] }) {
  let docHead
  let pageHeads = []
  const headWatchers = new Set()

  const methods = {
    ssr,
    routes,
    push,
    registerPage,
    loadRoute,
    loadRouteByUrl,
    resolveRoute,
    resolveRouteWithParams,
    insertDocHead,
    insertPageHead,
    getPageHeads,
    getDocHead,
    watchPageHeads,
    callRouteFn,
    applyRedirect,
    getLoader,
    setLoaderData,
    getLoaderData,
    getAction,
    getCache,
    getCookie,
    setCookie,
    removeCookie,
  }

  function push(action, ...args) {
    methods[action](...args)
  }

  function registerPage(routeId, Page) {
    const route = routes.find(route => route.id === routeId)
    route.Page = Page
  }

  async function loadRoute(route) {
    if (!route) return
    if (route.Page) return
    if (route.loader) return await route.loader
    route.loader = import(route.file)
    await route.loader
  }

  function loadRouteByUrl(url) {
    const route = resolveRoute(url)
    return loadRoute(route)
  }

  function resolveRoute(url) {
    return routes.find(route => match(route.pattern, url)[0])
  }

  function resolveRouteWithParams(url) {
    if (!url) return []
    for (const route of routes) {
      const [hit, params] = match(route.pattern, url)
      if (hit) return [route, params]
    }
    return []
  }

  // ssr
  function insertDocHead(children) {
    docHead = children
  }

  function getDocHead() {
    return docHead
  }

  function insertPageHead(children) {
    pageHeads = [...pageHeads, children]
    for (const callback of headWatchers) {
      callback(pageHeads)
    }
    return () => {
      pageHeads = pageHeads.filter(t => t !== children)
      for (const callback of headWatchers) {
        callback(pageHeads)
      }
    }
  }

  function getPageHeads() {
    return pageHeads
  }

  function watchPageHeads(callback) {
    headWatchers.add(callback)
    return () => headWatchers.delete(callback)
  }

  async function callRouteFn(routeId, fnName, args) {
    let result
    if (ssr) {
      console.log('TODO: this shouldnt happen yeah?')
      result = await ssr.callRouteFn(routeId, fnName, args)
    } else {
      const res = await fetch('/_firebolt_fn', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          routeId,
          fnName,
          args, // todo: rename fnArgs
        }),
      })
      result = await res.json()
    }
    return result
  }

  function applyRedirect(redirect) {
    if (redirect.type === 'push') {
      history.pushState(null, '', redirect.url)
    }
    if (redirect.type === 'replace') {
      history.replaceState(null, '', redirect.url)
    }
  }

  const loaders = {} // [key]: loader

  function getLoader(routeId, args) {
    const key = `${routeId}|${args.join('|')}`
    const fnName = args[0]
    const fnArgs = args.slice(1)
    if (loaders[key]) return loaders[key]
    let status = 'pending'
    let promise
    let value
    let expiresAt
    const setData = data => {
      if (data) {
        status = 'ready'
        value = data.value
        expiresAt = data.expire ? new Date().getTime() + data.expire * 1000 : null // prettier-ignore
      } else {
        status = 'pending'
        value = null
        expiresAt = null
      }
    }
    setData(getLoaderData(key))
    const loader = {
      key,
      args,
      watchers: new Set(),
      fetching: status === 'pending',
      invalidated: false,
      async fetch() {
        let result
        if (ssr) {
          result = await ssr.callRouteFn(routeId, fnName, fnArgs)
          ssr.inserts.write(`
            <script>
              globalThis.$firebolt.push('setLoaderData', '${key}', ${JSON.stringify(result)})
            </script>
          `)
        } else {
          result = await callRouteFn(routeId, fnName, fnArgs)
        }
        return result
      },
      get() {
        // invalidate if expired
        if (expiresAt !== null) {
          const now = new Date().getTime()
          const expired = now > expiresAt
          if (expired) {
            loader.invalidated = true
          }
        }
        // background fetch if invalidated
        if (loader.invalidated && !loader.fetching) {
          loader.fetching = true
          loader.fetch().then(data => {
            if (data.redirect) {
              // maintain pending state for a blip while we redirect then clear the promise
              return new Promise(() => {
                applyRedirect(data.redirect)
                promise = null
                loader.fetching = false
                loader.invalidated = false
              })
            }
            setData(data)
            loader.fetching = false
            loader.invalidated = false
            loader.notify()
          })
        }
        // read from status
        if (status === 'ready') {
          return value
        }
        if (status === 'pending') {
          if (!promise) {
            promise = loader.fetch().then(data => {
              if (data.redirect) {
                // maintain pending state for a blip while we redirect then clear the promise
                return new Promise(() => {
                  applyRedirect(data.redirect)
                  promise = null
                  loader.fetching = false
                })
              }
              setData(data)
              loader.fetching = false
            })
          }
          throw promise
        }
        if (status === 'error') {
          throw value
        }
      },
      set(value) {
        setData({ value })
        loader.notify()
      },
      edit(fn) {
        const newValue = produce(value, draft => {
          return fn(draft)
        })
        setData({ value: newValue })
        loader.notify()
      },
      async invalidate() {
        loader.invalidated = true
        loader.notify()
      },
      watch(callback) {
        loader.watchers.add(callback)
        return () => loader.watchers.delete(callback)
      },
      notify() {
        for (const notify of loader.watchers) {
          notify()
        }
      },
    }
    loaders[key] = loader
    return loader
  }

  const loaderData = {} // [key]: data

  function setLoaderData(key, data) {
    loaderData[key] = data
  }

  function getLoaderData(key) {
    return loaderData[key]
  }

  const actions = {} // [key]: action

  function getAction(routeId, fnName) {
    const key = `${routeId}|${fnName}`
    if (actions[key]) return actions[key]
    const action = function (...fnArgs) {
      let promise
      if (ssr) {
        promise = ssr.callRouteFn(routeId, fnName, fnArgs)
      } else {
        promise = callRouteFn(routeId, fnName, fnArgs)
      }
      return promise.then(data => {
        if (data.redirect) {
          // cancel action call stack and redirect
          return new Promise(() => {
            applyRedirect(data.redirect)
          })
        } else {
          return data.value
        }
      })
    }
    actions[key] = action
    return action
  }

  const cache = {
    invalidate(...args) {
      // invalidate everything
      if (!args[0]) {
        for (const key in loaders) {
          const loader = loaders[key]
          loader.invalidate()
        }
        return
      }
      // invalidate via predicate
      if (typeof args[0] === 'function') {
        const check = args[0]
        for (const key in loaders) {
          const loader = loaders[key]
          const shouldInvalidate = check(loader.args)
          if (shouldInvalidate) {
            loader.invalidate()
          }
        }
        return
      }
      // invalidate via matching
      for (const key in loaders) {
        const loader = loaders[key]
        let match = true
        for (let i = 0; i < args.length; i++) {
          if (loader.args[i] !== args[i]) {
            match = false
            break
          }
        }
        if (match) {
          loader.invalidate()
        }
      }
    },
  }

  function getCache() {
    return cache
  }

  function getCookie(key) {
    let value = cookie.get(key)
    try {
      value = JSON.parse(value)
    } catch (err) {
      // ...
    }
    console.log('getCookie', key, value)
    return value
  }

  function setCookie(key, value, options) {
    console.log('setCookie', key, value, options)
    try {
      value = JSON.stringify(value)
    } catch (err) {
      // ...
    }
    cookie.set(key, value, options)
  }

  function removeCookie(key) {
    console.log('removeCookie', key)
    cookie.remove(key)
  }

  for (const item of stack) {
    push(item.action, ...item.args)
  }

  return methods
}
