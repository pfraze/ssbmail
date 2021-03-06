var mlib = require('ssb-msgs')
var multicb = require('multicb')
var EventEmitter = require('events').EventEmitter
var threadlib = require('patchwork-threads')

// constant used to decide if an index-entry was recent enough to emit an 'add' event for
var IS_RECENT_MAX = 1e3 * 60 * 60 * 48 // 2 days

module.exports.index = function (name) {
  var index = new EventEmitter()
  index.name = name
  index.rows = []
  index.lastAccessed = Date.now()

  index.touch = function () {
    index.lastAccessed = Date.now()
  }

  index.sortedInsert = function (ts, key) {
    var row = (typeof ts == 'object') ? ts : { ts: ts, key: key }
    for (var i=0; i < index.rows.length; i++) {
      if (index.rows[i].ts < row.ts) {
        index.rows.splice(i, 0, row)
        if (timestampIsRecent(row.ts))
          index.emit('add', row)
        return row
      }
    }
    index.rows.push(row)
    if (timestampIsRecent(row.ts))
      index.emit('add', row)
    return row
  }

  index.sortedUpdate = function (ts, key) {
    var i = index.indexOf(key)
    if (i !== -1) {
      // readd to index at new TS
      if (index.rows[i].ts < ts) {
        var row = index.rows[i]
        // remove from old position
        index.rows.splice(i, 1)
        // update values
        row.ts = ts
        // reinsert
        index.sortedInsert(row)
        return row
      } else
        return index.rows[i]
    }
  }

  index.sortedUpsert = function (ts, key) {
    var row = index.sortedUpdate(ts, key)
    if (!row) {
      // add to index
      row = index.sortedInsert(ts, key)
    }
    return row
  }

  index.remove = function (key, keyname) {
    var i = index.indexOf(key, keyname)
    if (i !== -1)
      index.rows.splice(i, 1)
  }

  index.indexOf = function (key, keyname) {
    keyname = keyname || 'key'
    for (var i=0; i < index.rows.length; i++) {
      if (index.rows[i][keyname] === key)
        return i
    }
    return -1
  }

  index.find = function (key, keyname) {
    var i = index.indexOf(key, keyname)
    if (i !== -1)
      return index.rows[i]
    return null
  }

  index.contains = function (key) {
    return index.indexOf(index, key) !== -1
  }

  index.filter = index.rows.filter.bind(index.rows)

  // helper to count # of messages that are new
  index.countUntouched = function () {
    // iterate until we find a ts older than lastAccessed, then return that #
    for (var i=0; i < index.rows.length; i++) {
      if (index.rows[i].ts < index.lastAccessed)
        return i
    }
    return 0
  }

  function timestampIsRecent (ts) {
    var now = Date.now()
    var delta = Math.abs(now - ts)
    return (delta < IS_RECENT_MAX)
  }

  return index
}

module.exports.getThreadHasUnread = function (sbot, msg, cb) {
  threadlib.getParentPostSummary(sbot, msg, { isRead: true }, function (err, thread) {
    if (err) return cb(err)
    cb(err, thread.hasUnread)
  })
}

module.exports.findLink = function (links, id) {
  for (var i=0; i < (links ? links.length : 0); i++) {
    if (links[i].link === id)
      return links[i]
  }
}

exports.sortThreadReplies = function (thread) {
  var related = thread.related
  if (!related || related.length == 0)
    return

  // sort by asserted publish time
  related.sort(function (a, b) { return a.value.timestamp - b.value.timestamp })

  // make sure the parents come before the children (using hash links)
  for (var i=0; i < related.length; i++) {
    var branch = mlib.link(related[i].value.content.branch || related[i].value.content.root)
    if (!branch)
      continue // shouldnt happen

    // look for parent above
    for (var j=0; j < related.length; j++) {
      if (related[j].key == branch.link) {
        if (j > i) {
          // swap the messages
          // TODO
          // swapping probably isnt the right way to handle this
          // probably smarter to splice the parent into the position immediately above the child
          // write tests and figure out the right call here
          // -prf
          var r = related[j]
          related[j] = related[i]
          related[i] = r
        }
        break
      }
    }
  }
}