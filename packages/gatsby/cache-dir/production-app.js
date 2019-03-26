import { apiRunner, apiRunnerAsync } from "./api-runner-browser"
import React, { createElement } from "react"
import ReactDOM from "react-dom"
import { Router, navigate } from "@reach/router"
import { ScrollContext } from "gatsby-react-router-scroll"
import domReady from "domready"
import {
  shouldUpdateScroll,
  init as navigationInit,
  RouteUpdates,
} from "./navigation"
import emitter from "./emitter"
import PageRenderer from "./page-renderer"
import asyncRequires from "./async-requires"
import loader, { setApiRunnerForLoader } from "./loader"
import EnsureResources from "./ensure-resources"

window.asyncRequires = asyncRequires
window.___emitter = emitter
window.___loader = loader
window.___compilationHash = window.pageData.compilationHash
console.log(`compilation hash`, window.___compilationHash)

loader.addPageData([window.pageData])
loader.addProdRequires(asyncRequires)
setApiRunnerForLoader(apiRunner)

navigationInit()

// Let the site/plugins run code very early.
apiRunnerAsync(`onClientEntry`).then(() => {
  // Let plugins register a service worker. The plugin just needs
  // to return true.
  if (apiRunner(`registerServiceWorker`).length > 0) {
    require(`./register-service-worker`)
  }

  class RouteHandler extends React.Component {
    render() {
      let { location } = this.props

      return (
        <EnsureResources location={location}>
          {({ pageResources, location }) => (
            <RouteUpdates location={location}>
              <ScrollContext
                location={location}
                shouldUpdateScroll={shouldUpdateScroll}
              >
                <PageRenderer
                  {...this.props}
                  location={location}
                  pageResources={pageResources}
                  {...pageResources.json}
                />
              </ScrollContext>
            </RouteUpdates>
          )}
        </EnsureResources>
      )
    }
  }

  const { pageData, location: browserLoc } = window
  if (
    // Make sure the window.page object is defined
    pageData &&
    // The canonical path doesn't match the actual path (i.e. the address bar)
    __PATH_PREFIX__ + pageData.path !== browserLoc.pathname &&
    // Ignore 404 pages, since we want to keep the same URL
    pageData.path !== `/404.html` &&
    !pageData.path.match(/^\/404\/?$/) &&
    // Also ignore the offline shell (since when using the offline plugin, all
    // pages have this canonical path)
    !pageData.path.match(/^\/offline-plugin-app-shell-fallback\/?$/)
  ) {
    navigate(
      __PATH_PREFIX__ + pageData.path + browserLoc.search + browserLoc.hash,
      { replace: true }
    )
  }

  loader.getResourcesForPathname(browserLoc.pathname).then(() => {
    const Root = () =>
      createElement(
        Router,
        {
          basepath: __PATH_PREFIX__,
        },
        createElement(RouteHandler, { path: `/*` })
      )

    const WrappedRoot = apiRunner(
      `wrapRootElement`,
      { element: <Root /> },
      <Root />,
      ({ result }) => {
        return { element: result }
      }
    ).pop()

    let NewRoot = () => WrappedRoot

    const renderer = apiRunner(
      `replaceHydrateFunction`,
      undefined,
      ReactDOM.hydrate
    )[0]

    domReady(() => {
      renderer(
        <NewRoot />,
        typeof window !== `undefined`
          ? document.getElementById(`___gatsby`)
          : void 0,
        () => {
          apiRunner(`onInitialClientRender`)
        }
      )
    })
  })
})
