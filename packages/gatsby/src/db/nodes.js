const _ = require(`lodash`)
const { store } = require(`../redux`)
const { pluginFieldTracking } = require(`./plugin-fields`)

const backend = process.env.GATSBY_DB_NODES || `redux`
let nodesDb
switch (backend) {
  case `redux`:
    nodesDb = require(`../redux/nodes`)
    break
  case `loki`:
    nodesDb = require(`./loki/nodes`)
    break
  default:
    throw new Error(
      `Unsupported DB nodes backend (value of env var GATSBY_DB_NODES)`
    )
}

module.exports = { ...nodesDb }

/**
 * Get content for a node from the plugin that created it.
 *
 * @param {Object} node
 * @returns {promise}
 */
module.exports.loadNodeContent = node => {
  if (_.isString(node.internal.content)) {
    return Promise.resolve(node.internal.content)
  } else {
    return new Promise(resolve => {
      // Load plugin's loader function
      const plugin = store
        .getState()
        .flattenedPlugins.find(plug => plug.name === node.internal.owner)
      const { loadNodeContent } = require(plugin.resolve)
      if (!loadNodeContent) {
        throw new Error(
          `Could not find function loadNodeContent for plugin ${plugin.name}`
        )
      }

      return loadNodeContent(node).then(content => {
        // TODO update node's content field here.
        resolve(content)
      })
    })
  }
}

/////////////////////////////////////////////////////////////////////
// Run Query
/////////////////////////////////////////////////////////////////////

function hasPluginFields(queryArgs) {
  return _.some(queryArgs.filter, (v, fieldName) =>
    pluginFieldTracking.has(fieldName)
  )
}

function chooseQueryEngine(queryArgs) {
  if (backend === `loki` && !hasPluginFields(queryArgs)) {
    return require(`./loki/nodes`).runQuery
  } else {
    return require(`../redux/run-sift`)
  }
}

/**
 * Runs the query over all nodes of type. It must first select the
 * appropriate query engine. Sift, or Loki. Sift is used if the query
 * includes plugin fields, i.e those declared by plugins during the
 * `setFieldsOnGraphQLNodeType` API. If it does, then we must iterate
 * through all nodes calling the plugin field to make sure it's
 * realized, then we can perform the query. See `query-sift.js` for
 * more.
 *
 * If the query does *not* include plugin fields, then we can perform
 * a much faster pure data query using loki. See `query-loki.js` for
 * more.
 *
 * @param {Object} args. Object with:
 *
 * {Object} gqlType: built during `./build-node-types.js`
 *
 * {Object} rawGqlArgs: The raw graphql query as a js object. E.g `{
 * filter: { fields { slug: { eq: "/somepath" } } } }`
 *
 * {Object} context: The context from the QueryJob
 *
 * {boolean} firstOnly: Whether to return the first found match, or
 * all matching result.
 *
 * @returns {promise} A promise that will eventually be resolved with
 * a collection of matching objects (even if `firstOnly` is true)
 */
function runQuery(args) {
  const queryFunction = chooseQueryEngine(args.queryArgs)

  return queryFunction(args)
}

module.exports.runQuery = runQuery
