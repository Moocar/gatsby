const _ = require(`lodash`)
const loki = require(`lokijs`)
const db = new loki("loki.json")
const invariant = require(`invariant`)

console.log(`creating db`)

function clearAll() {
  _.forEach(db.listCollections(), collInfo => {
    const coll = db.getCollection(collInfo.name)
    coll.clear({ removeIndices: true })
  })
}

function getNode(id) {
  invariant(id, `id is null`)
  const collInfo = _.find(db.listCollections(), collInfo => {
    const coll = db.getCollection(collInfo.name)
    return coll.by(`id`, id)
  })
  if (collInfo) {
    const coll = db.getCollection(collInfo.name)
    return coll.by(`id`, id)
  }
}

function getNodes() {
  return _.flatMap(db.listCollections(), collInfo => {
    const coll = db.getCollection(collInfo.name)
    return coll.data
  })
}

function getNodeGroups() {
  return _.reduce(
    db.listCollections(),
    (groups, collInfo) => {
      const type = collInfo.name
      groups[type] = db.getCollection(type).data
      return groups
    },
    {}
  )
}

function getNodeAndSavePathDependency(id, path) {
  const {
    createPageDependency,
  } = require(`../redux/actions/add-page-dependency`)
  const node = getNode(id)
  createPageDependency({ path, nodeId: id })
  return node
}

/**
 * Determine if node has changed.
 *
 * @param {string} id
 * @param {string} digest
 * @returns {boolean}
 */
function hasNodeChanged(id, digest) {
  const node = getNode(id)
  if (!node) {
    return true
  } else {
    return node.internal.contentDigest !== digest
  }
}

module.exports = {
  db,
  clearAll,
  getNode,
  getNodes,
  getNodeGroups,
  getNodeAndSavePathDependency,
  hasNodeChanged,
}
