import React from 'react'
import VerticalFilledContainer from 'patchkit-vertical-filled'
import { UserPic, UserLinks } from 'patchkit-links'
import mlib from 'ssb-msgs'
import TopNav from '../com/topnav'
import LeftNav from '../com/leftnav'
import Alert from '../com/alert'
import ContactInfoForm from '../com/form/contact-info'
import DropdownBtn from 'patchkit-dropdown'
import DropdownSelectorBtn from 'patchkit-dropdown-selector'
import MsgList from 'ssbmail-msg-list'
import MsgOneline from 'ssbmail-msg-view/oneline'
import ContactList from 'ssbmail-contact-list'
import ContactOneline from 'ssbmail-contact-view/oneline'
import { SyncStatus } from 'ssbmail-contact-view/oneline'
import u from 'patchkit-util'
import social from 'patchkit-util/social'
import app from '../lib/app'

const VIEW_OPTS = [
  { label: 'Messages', value: 'messages' },
  { label: 'Contacts', value: 'contacts' },
  { label: 'Verifications', value: 'verifications' },
]

class Toolbar extends React.Component {
  constructor(props) {
    super(props)
    this.state = { isContactInfoOpen: false }
  }

  onToggleContactInfo(e) {
    if (e) e.preventDefault()
    this.setState({ isContactInfoOpen: !this.state.isContactInfoOpen })
  }

  render() {
    const EXTRA_LINKS = [{ label: 'Verify', onSelect: ()=>alert('Verifications are TODO, sorry!') }]
    return <div className="toolbar">
      <div className="toolbar-inner">
        <a className="btn toolbar-btn" href="#/contacts"><i className="fa fa-angle-left"/> Contacts</a>
        <DropdownSelectorBtn className="btn toolbar-btn" items={VIEW_OPTS} initValue={this.props.currentView} label="View" onSelect={this.props.onSelectView} />
        <div className="toolbar-divider"/>
        <a className="btn toolbar-btn" href="#" onClick={this.onToggleContactInfo.bind(this)}>Get Contact Info</a>
        <DropdownBtn className="btn toolbar-btn" right items={EXTRA_LINKS}><i className="fa fa-cog" /> <i className="fa fa-angle-down" /></DropdownBtn>
        {''/* TODO reenable when ready <a className="btn toolbar-btn" href={"#/chat?id="+encodeURIComponent(this.props.userId)}>Go to Chat</a>*/}
      </div>
      <Alert className="center-block" Form={ContactInfoForm} formProps={{ userId: this.props.userId }} isOpen={this.state.isContactInfoOpen} onClose={this.onToggleContactInfo.bind(this)} />
    </div>
  }
}

class FollowBtn extends React.Component {
  render() {
    var label, opts
    const name = u.getName(app.users, this.props.id)

    const onSelect = b => () => {
      app.ssb.publish({ type: 'contact', contact: this.props.id, following: b }, function (err) {
        if (err) throw err
        app.fetchLatestState()
        app.emit('notice', (b ? 'You are now following ' : 'You are no longer following ') + name)
      })
    }

    if (social.follows(app.users, app.user.id, this.props.id)) {
      label = 'Following'
      opts = [{ label: <span><i className="fa fa-user-times"/> Unfollow {name}</span>, onSelect: onSelect(false) }]
    } else {
      label = 'Not Following'
      opts = [{ label: <span><i className="fa fa-user-plus"/> Follow {name}</span>, onSelect: onSelect(true) }]
    }
    return <DropdownBtn className="btn highlighted" items={opts}>{label} <i className="fa fa-angle-down" /></DropdownBtn>
  }
}

export default class Profile extends React.Component {
  constructor(props) {
    super(props)
    this.state = { view: 'messages' }
  }

  onSelectView(view) {
    this.setState({ view: view })
  }

  render() {
    const id = this.props.params && this.props.params.id
    const name = u.getName(app.users, id)
    const isYou = id == app.user.id

    const cursor = msg => { if (msg) return [msg.ts, false] }
    const msgFilter = msg => !!findLink(mlib.links(msg.value.content.recps), id)
    const contactFilter = id2 => social.follows(app.users, id, id2)
    const sortByName = (a, b) => u.getName(app.users, a).localeCompare(u.getName(app.users, b))

    var view
    if (this.state.view == 'messages') {
      view = <MsgList
        threads
        ListItem={MsgOneline}
        live={{ gt: [Date.now(), null] }}
        emptyMsg={<div>No messages from {name}.</div>}
        source={app.ssb.patchwork.createInboxStream}
        filter={msgFilter}
        cursor={cursor} />
    } else if (this.state.view == 'contacts') {
      view = <VerticalFilledContainer>
        <ContactList ListItem={ContactOneline} filter={contactFilter} sort={sortByName} />
      </VerticalFilledContainer>
    } else {
      view = <VerticalFilledContainer>
        todo
      </VerticalFilledContainer>
    }

    return <div id="profile" key={'profile:'+id}>
      <TopNav />
      <div className="flex">
        <LeftNav location={this.props.location} />
        <div className="flex-fill">
          <Toolbar userId={id} currentView={this.state.view} onSelectView={this.onSelectView.bind(this)} />
          <div className="profile-header">
            <UserPic id={id} />
            <div className="info">
              <h1>{name} <SyncStatus users={app.users} a={id} b={app.user.id} /></h1>
              { isYou
                ? <div>This is you!</div>
                : <div className="btns">
                    <FollowBtn id={id} />
                  </div> }
              <div>Followed by: <UserLinks limit={2} ids={social.followedFollowers(app.users, app.user.id, id)} /></div>
              <div>Verified by:</div>
            </div>
          </div>
          {view}
        </div>
      </div>
    </div>
  }
}

function findLink (links, id) {
  for (var i=0; i < (links ? links.length : 0); i++) {
    if (links[i].link === id)
      return links[i]
  }
}
