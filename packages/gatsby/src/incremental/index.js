const _ = require(`lodash`)
const path = require(`path`)
const tracer = require(`opentracing`).globalTracer()
const report = require(`gatsby-cli/lib/reporter`)
const loadPlugins = require(`../bootstrap/load-plugins`)
const apiRunner = require(`../utils/api-runner-node`)
const { store, flags } = require(`../redux`)
const nodeTracking = require(`../db/node-tracking`)
const { getExampleValues } = require(`../schema/data-tree-utils`)
const nodesDb = require(`../db/nodes`)
const createContentDigest = require(`../utils/create-content-digest`)
const { graphql } = require(`graphql`)
const { boundActionCreators } = require(`../redux/actions`)
const { deletePage } = boundActionCreators
const queryCompiler = require(`../internal-plugins/query-runner/query-compiler`).default
require(`../db`).startAutosave()

async function initLoki({ cacheDirectory }) {
  const loki = require(`../db/loki`)
  const dbSaveFile = `${cacheDirectory}/loki/loki.db`
  try {
    await loki.start({
      saveFile: dbSaveFile,
    })
  } catch (e) {
    report.error(
      `Error starting DB. Perhaps try deleting ${path.dirname(dbSaveFile)}`
    )
  }
}

async function sourceNodes() {
  await apiRunner(`sourceNodes`, {
    traceId: `initial-sourceNodes`,
    waitForCascadingActions: true,
  })
}

function hasExampleValueChanged(type) {
  const nodes = nodesDb.getNodesByType(type)
  const exampleValue = getExampleValues({
    nodes,
    typeName: type,
  })
  const newHash = createContentDigest(exampleValue)
  const oldHash = store.getState().depGraph.exampleValues[type]
  return oldHash != newHash
}

function shouldRunSchema() {
  const flaggedTypes = Object.keys(flags.nodeTypeCollections)
  console.log(`flagged types`, flaggedTypes)
  const changedTypes = flaggedTypes.filter(hasExampleValueChanged)
  console.log(`changed types`, changedTypes)
  return changedTypes.length > 0
}

async function createPages({ activity, bootstrapSpan, graphqlRunner }) {
  // Collect pages.
  activity = report.activityTimer(`createPages`, {
    parentSpan: bootstrapSpan,
  })
  activity.start()
  await apiRunner(`createPages`, {
    graphql: graphqlRunner,
    traceId: `initial-createPages`,
    waitForCascadingActions: true,
    parentSpan: activity.span,
  })
  activity.end()

  // A variant on createPages for plugins that want to
  // have full control over adding/removing pages. The normal
  // "createPages" API is called every time (during development)
  // that data changes.
  activity = report.activityTimer(`createPagesStatefully`, {
    parentSpan: bootstrapSpan,
  })
  activity.start()
  await apiRunner(`createPagesStatefully`, {
    graphql: graphqlRunner,
    traceId: `initial-createPagesStatefully`,
    waitForCascadingActions: true,
    parentSpan: activity.span,
  })
  activity.end()

  const state = store.getState()
  const touched = state.pagesTouched

  for (const [path, page] of state.pages) {
    if (!touched.has(path)) {
      console.log(`found stale page`, page.path)
      deletePage(page)
    }
  }

  // TODO double check rerun schema stuff
}

function shouldRecompileQueries() {
  return flags.schema
}

function saveQuery(components, component, query) {
  if (query.isStaticQuery) {
    boundActionCreators.replaceStaticQuery({
      name: query.name,
      componentPath: query.path,
      id: query.jsonName,
      jsonName: query.jsonName,
      query: query.text,
      hash: query.hash,
    })
    boundActionCreators.deleteComponentsDependencies([query.jsonName])
    // If this is page query
  } else if (components.has(component)) {
    boundActionCreators.replaceComponentQuery({
      query: query.text,
      componentPath: component,
    })
  }
}

async function runQueries({ activity, bootstrapSpan }) {
  activity = report.activityTimer(`onPreExtractQueries`, {
    parentSpan: bootstrapSpan,
  })
  activity.start()
  await apiRunner(`onPreExtractQueries`, { parentSpan: activity.span })
  activity.end()

  // TODO clearInactiveComponents
  if (shouldRecompileQueries()) {
    console.log(`recompiling queries`)
    // Extract queries
    activity = report.activityTimer(`extract queries from components`, {
      parentSpan: bootstrapSpan,
    })
    activity.start()
    const queries = await queryCompiler()
    const components = new Map(store.getState().components)
    queries.forEach((query, component) =>
      saveQuery(components, component, query)
    )
    activity.end()
    const pages = store.getState().pages
    for (const path of pages) {
      flags.queryJob(path)
    }
    for (const jsonName of store.getState().staticQueryComponents) {
      flags.queryJob(jsonName)
    }
  }
}

async function build({ parentSpan }) {
  console.log(`INCREMENTAL`)
  const spanArgs = parentSpan ? { childOf: parentSpan } : {}
  const bootstrapSpan = tracer.startSpan(`bootstrap`, spanArgs)
  const config = store.getState().config
  const { directory } = config
  const cacheDirectory = `${directory}/.cache`
  let activity
  console.log(store.getState().depGraph)

  // Start plugin runner which listens to the store
  // and invokes Gatsby API based on actions.
  require(`../redux/plugin-runner`)

  activity = report.activityTimer(`load plugins`)
  activity.start()
  await loadPlugins(config)
  activity.end()

  // onPreInit
  activity = report.activityTimer(`onPreInit`, {
    parentSpan: bootstrapSpan,
  })
  activity.start()
  await apiRunner(`onPreInit`, { parentSpan: activity.span })
  activity.end()

  if (process.env.GATSBY_DB_NODES === `loki`) {
    activity = report.activityTimer(`start nodes db`, {
      parentSpan: bootstrapSpan,
    })
    activity.start()
    initLoki({ cacheDirectory })
    activity.end()
  }

  // By now, our nodes database has been loaded, so ensure that we
  // have tracked all inline objects
  nodeTracking.trackDbNodes()

  // Source nodes
  activity = report.activityTimer(`source and transform nodes`, {
    parentSpan: bootstrapSpan,
  })
  activity.start()
  await sourceNodes()
  activity.end()

  // Create Schema.
  activity = report.activityTimer(`building schema`, {
    parentSpan: bootstrapSpan,
  })
  activity.start()
  if (shouldRunSchema()) {
    flags.schemaDirty()
    console.log(`schema is dirty`)
  }
  await require(`../schema`).build({ parentSpan: activity.span })
  activity.end()

  const graphqlRunner = (query, context = {}) => {
    const schema = store.getState().schema
    return graphql(schema, query, context, context, context)
  }

  await createPages({ activity, bootstrapSpan, graphqlRunner })

  await runQueries({ activity, bootstrapSpan })
}

module.exports = build
