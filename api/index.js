var fs          = require('fs')
var pull        = require('pull-stream')
var multicb     = require('multicb')
var pl          = require('pull-level')
var pushable    = require('pull-pushable')
var paramap     = require('pull-paramap')
var cat         = require('pull-cat')
var Notify      = require('pull-notify')
var toPull      = require('stream-to-pull-stream')
var ref         = require('ssb-ref')
var pathlib     = require('path')
var mlib        = require('ssb-msgs')
var threadlib   = require('patchwork-threads')
var u           = require('./util')

exports.name        = 'patchwork'
exports.version     = '1.0.0'
exports.manifest    = require('./manifest')
exports.permissions = require('./permissions')

exports.init = function (sbot, opts) {

  var api = {}
  var patchworkdb = sbot.sublevel('patchwork')
  var db = {
    isread: patchworkdb.sublevel('isread')
  }
  var state = {
    // indexes (lists of {key:, ts:})
    mymsgs: [],
    inbox: u.index('inbox'),
    notices: u.index('notices'),

    // views
    profiles: {},
    names: {}, // ids -> names
    ids: {}, // names -> ids
    actionItems: {}
  }

  // track sync state
  // - processor does async processing for each message that comes in
  // - awaitSync() waits for that processing to finish
  // - pinc() on message arrival, pdec() on message processed
  // - nP === 0 => all messages processed
  var nP = 0, syncCbs = []
  function awaitSync (cb) {
    if (nP > 0)
      syncCbs.push(cb)
    else cb()
  }
  state.pinc = function () { nP++ }
  state.pdec = function () {
    nP--
    if (nP === 0) {
      syncCbs.forEach(function (cb) { cb() })
      syncCbs.length = 0
    }
  }

  // setup sbot log processor
  var isHistorySynced = false // track so we dont emit events for old messages
  var processor = require('./processor')(sbot, db, state, emit)
  awaitSync(function () { // wait for channelwatches to load up
    // create log stream
    pull(pl.read(sbot.sublevel('log'), { live: true, onSync: onHistorySync }), pull.drain(processor))
    state.pinc()
    function onHistorySync () {
      console.log('Log history read...')
      // when all current items finish, consider prehistory synced (and start emitting)
      awaitSync(function () { 
        console.log('Indexes generated')
        isHistorySynced = true
      })
      state.pdec()
    }
  })

  // events stream
  var notify = Notify()
  function emit (type, data) {
    if (!isHistorySynced)
      return
    var e = data || {}
    e.type = type
    if (e.type == 'index-change') {
      api.getIndexCounts(function (err, counts) {
        e.counts = counts
        e.total = counts[e.index]
        e.unread = counts[e.index+'Unread']
        notify(e)
      })
    } else
      notify(e)
  }

  // getters

  api.createEventStream = function () {
    return notify.listen()
  }

  api.getMyProfile = function (cb) {
    awaitSync(function () {
      api.getProfile(sbot.id, cb)
    })
  }

  api.getIndexCounts = function (cb) {
    awaitSync(function () {
      var counts = {
        inboxUnread: state.inbox.filter(function (row) { return !row.isread }).length
      }
      cb(null, counts)
    })
  }

  api.createInboxStream = indexStreamFn(state.inbox)
  api.createNoticeStream = indexStreamFn(state.notices)
  api.createSearchStream = function (opts) {
    opts = opts || {}
    var searchRegex = new RegExp(opts.query||'', 'i')
    return pull(
      sbot.messagesByType({ type: 'post' }),
      pull.asyncMap(function (msg, cb) {
        // decrypt the message, if needed
        threadlib.decryptThread(sbot, msg, cb)
      }),
      pull.filter(function (msg) {
        // filter out palintext
        if (msg.plaintext)
          return false

        // run search filter
        return searchRegex.test(''+msg.value.content.text)
      }),
      opts.limit ? pull.take(opts.limit) : undefined
    )
  }

  function indexMarkRead (indexname, key, keyname) {
    if (Array.isArray(key)) {
      key.forEach(function (k) {
        indexMarkRead(indexname, k, keyname)
      })
      return
    }

    var index = state[indexname]
    var row = index.find(key, keyname)
    if (row) {
      var wasread = row.isread
      row.isread = true
      if (!wasread)
        emit('index-change', { index: indexname })
      return true
    }
  }

  function indexMarkUnread (indexname, key, keyname) {
    if (Array.isArray(key)) {
      key.forEach(function (k) {
        indexMarkUnread(indexname, k, keyname)
      })
      return
    }

    var index = state[indexname]
    var row = index.find(key, keyname)
    if (row) {
      var wasread = row.isread
      row.isread = false
      if (wasread)
        emit('index-change', { index: indexname })
      return true
    }
  }

  api.markRead = function (key, cb) {
    awaitSync(function () {
      indexMarkRead('inbox', key)
      if (Array.isArray(key)) {
        db.isread.batch(key.map(function (k) { return { type: 'put', key: k, value: 1 }}), cb)
        key.forEach(function (key) { emit('isread', { key: key, value: true }) })
      } else {
        db.isread.put(key, 1, cb)
        emit('isread', { key: key, value: true })
      }
    })
  }
  api.markUnread = function (key, cb) {
    awaitSync(function () {
      indexMarkUnread('inbox', key)
      if (Array.isArray(key)) {
        db.isread.batch(key.map(function (k) { return { type: 'del', key: k }}), cb)
        key.forEach(function (key) { emit('isread', { key: key, value: false }) })
      } else {
        db.isread.del(key, cb) 
        emit('isread', { key: key, value: false })
      }
    })
  }
  api.markAllRead = function (indexName, cb) {
    awaitSync(function () {
      var index = state[indexName]
      if (!index || index.name !== indexName)
        return cb(new Error('Invalid index'))

      var done = multicb()
      index
        .filter(function (row) { return !row.isread })
        .forEach(function (row) { 
          var cb = done()
          threadlib.getPostThread(sbot, row.key, { isRead: true }, function (err, thread) {
            if (err)
              return cb()
            threadlib.markThreadRead(sbot, thread, cb)
          })
        })
      done(cb)
    })
  }
  api.toggleRead = function (key, cb) {
    api.isRead(key, function (err, v) {
      if (!v) {
        api.markRead(key, function (err) {
          cb(err, true)
        })
      } else {
        api.markUnread(key, function (err) {
          cb(err, false)
        })
      }
    })
  }
  api.isRead = function (key, cb) {
    if (Array.isArray(key)) {
      var done = multicb({ pluck: 1 })
      key.forEach(function (k, i) {
        var cb = done()
        db.isread.get(k, function (err, v) { cb(null, !!v) })
      })
      done(cb)
    } else {
      db.isread.get(key, function (err, v) {
        cb && cb(null, !!v)
      })
    }
  }
 
  api.addFileToBlobs = function (base64Buff, cb) {
    return pull(
      pull.values([new Buffer(base64Buff, 'base64')]),
      sbot.blobs.add(cb)
    )
  }
  api.saveBlobToFile = function (hash, path, cb) {
    pull(
      sbot.blobs.get(hash),
      toPull.sink(fs.createWriteStream(path), cb)
    )
  }

  var lookupcodeRegex = /(@[a-z0-9\/\+\=]+\.[a-z0-9]+)(?:\[via\])?(.+)?/i
  api.useLookupCode = function (code) {
    var eventPush = pushable()

    // parse and validate the code
    var id, addrs
    var parts = lookupcodeRegex.exec(code)
    var valid = true
    if (parts) {
      id  = parts[1]
      addrs = (parts[2]) ? parts[2].split(',') : []

      // validate id
      if (!ref.isFeedId(id))
        valid = false

      // parse addresses
      addrs = addrs
        .map(function (addr) {
          addr = addr.split(':')
          if (addr.length === 3)
            return { host: addr[0], port: +addr[1], key: addr[2] }
        })
        .filter(Boolean)
    } else
      valid = false

    if (!valid) {
      eventPush.push({ type: 'error', message: 'Invalid lookup code' })
      eventPush.end()
      return eventPush
    }

    // begin the search!
    search(addrs.concat(sbot.gossip.peers()))
    function search (peers) {
      var peer = peers.pop()
      if (!peer)
        return eventPush.end()

      // connect to the peer
      eventPush.push({ type: 'connecting', addr: peer })      
      sbot.connect(peer, function (err, rpc) {
        if (err) {
          eventPush.push({ type: 'error', message: 'Failed to connect', err: err })
          return search(peers)
        }
        // try a sync
        sync(rpc, function (err, seq) { 
          if (seq > 0) {
            // success!
            eventPush.push({ type: 'finished', seq: seq })
            eventPush.end()
          } else
            search(peers) // try next
        })
      })
    }

    function sync (rpc, cb) {
      // fetch the feed
      var seq
      eventPush.push({ type: 'syncing', id: id })
      pull(
        rpc.createHistoryStream({ id: id, keys: false }),
        pull.through(function (msg) {
          seq = msg.sequence
        }),
        sbot.createWriteStream(function (err) {
          cb(err, seq)
        })
      )
    }

    return eventPush
  }

  api.getProfile = function (id, cb) {
    awaitSync(function () { cb(null, state.profiles[id]) })
  }
  api.getAllProfiles = function (cb) {
    awaitSync(function () { cb(null, state.profiles) })
  }
  api.getNamesById = function (cb) {
    awaitSync(function () { cb(null, state.names) })
  }
  api.getIdsByName = function (cb) {
    awaitSync(function () { cb(null, state.ids) })
  }
  api.getName = function (id, cb) {
    awaitSync(function () { cb(null, state.names[id]) })
  }
  api.getActionItems = function (cb) {
    awaitSync(function () { cb(null, state.actionItems) })
  }

  // helper to get an option off an opt function (avoids the `opt || {}` pattern)
  function o (opts, k, def) {
    return opts && opts[k] !== void 0 ? opts[k] : def
  }

  // helper to get messages from an index
  function indexStreamFn (index, getkey) {
    return function (opts) {
      var lastAccessed = index.lastAccessed
      index.touch()

      // emulate the `ssb.createFeedStream` interface
      var lt      = o(opts, 'lt')
      var lte     = o(opts, 'lte')
      var gt      = o(opts, 'gt')
      var gte     = o(opts, 'gte')
      var limit   = o(opts, 'limit')
      var threads = o(opts, 'threads')
      var unread  = o(opts, 'unread')

      // lt, lte, gt, gte should look like:
      // [msg.value.timestamp, msg.value.author]

      // helper to create emittable rows
      function lookup (row) {
        if (!row) return
        var key = (getkey) ? getkey(row) : row.key
        if (key) {
          var rowcopy = { key: key }
          for (var k in row) { // copy index attrs into rowcopy
            if (!rowcopy[k]) rowcopy[k] = row[k]
          }
          return rowcopy
        }
      }

      // helper to fetch rows
      function fetch (row, cb) {
        if (threads) {
          threadlib.getPostSummary(sbot, row.key, { isBookmarked: false, isRead: true, votes: true, mentions: sbot.id }, function (err, thread) {
            for (var k in thread)
              row[k] = thread[k]
            cb(null, row)
          })
        } else {
          sbot.get(row.key, function (err, value) {
            // if (err) {
              // suppress this error
              // the message isnt in the local cache (yet)
              // but it got into the index, likely due to a link
              // instead of an error, we'll put a null there to indicate the gap
            // }
            row.value = value
            cb(null, row)
          })
        }
      }

      // readstream
      var readPush = pushable()
      var read = pull(readPush, paramap(fetch))

      // await sync, then emit the reads
      awaitSync(function () {
        var added = 0
        for (var i=0; i < index.rows.length; i++) {
          var row = index.rows[i]

          if (limit && added >= limit)
            break

          // we're going to only look at timestamp, because that's all that the index tracks
          var invalid = !!(
            (lt  && row.ts >= lt[0]) ||
            (lte && row.ts > lte[0]) ||
            (gt  && row.ts <= gt[0]) ||
            (gte && row.ts < gte[0]) ||
            (unread && row.isread)
          )
          if (invalid)
            continue

          var r = lookup(row)
          if (r) {
            r.isNew = r.ts > lastAccessed
            readPush.push(r)
            added++
          }
        }
        readPush.end()
      })

      if (opts && opts.live) {
        // live stream, concat the live-emitter on the end
        index.on('add', onadd)
        var livePush = pushable(function () { index.removeListener('add', onadd) })
        function onadd (row) { livePush.push(lookup(row)) }
        var live = pull(livePush, paramap(fetch))
        return cat([read, live])
      }
      return read
    }
  }

  return api
}