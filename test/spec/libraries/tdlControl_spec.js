import adapterManager from 'src/adapterManager.js';
import { registerBidder } from 'src/adapters/bidderFactory.js';
import { config } from 'src/config.js';
import { deepClone } from 'src/utils.js';
import { STORAGE_KEY_PREFIX, tdlPartiesFactory } from 'libraries/tdlParties/tdlParties.js';
import {
  installTdlControl,
  prune,
  share,
  tdlControlFactory,
  termsOf,
} from 'libraries/tdlParties/tdlControl.js';

const TERMS = 'https://m4ow.uk/mtm/2.txt';
const OTHER_TERMS = 'https://terms.example/other/1.txt';
const listAt = (domain, terms = TERMS) => `https://${domain}/.well-known/tdl/${terms.replace('https://', '')}`;

// A place to fetch lists from, which counts how often each address is asked
// for. An address with no body rejects, as a missing file does.
const fakeWeb = (bodies) => {
  const asked = [];
  const get = (url) => {
    asked.push(url);
    return url in bodies ? Promise.resolve(bodies[url]) : Promise.reject(new Error('404'));
  };
  return { asked, get };
};

// The publisher and bidder "yes" list each other for TERMS. Bidder "no"
// lists the publisher and is not listed by it. Bidder "silent" declares no
// domain.
const DOMAINS = { yes: 'yes.example', no: 'no.example' };
const LISTS = {
  [listAt('publisher.example')]: 'yes.example',
  [listAt('yes.example')]: 'publisher.example',
  [listAt('no.example')]: 'publisher.example',
};

const entry = (id, tdl) => ({ source: '51d.es', uids: [{ id, atype: 1 }], ...(tdl ? { ext: { tdl } } : {}) });
const adUnitsFor = (...bidders) => [{ code: 'slot', mediaTypes: { banner: { sizes: [[300, 250]] } }, bids: bidders.map((bidder) => ({ bidder, params: {} })) }];

describe('tdlControl', function() {
  describe('termsOf', function() {
    it('reads the terms an element names directly and through ext', function() {
      expect(termsOf({ tdl: [TERMS] })).to.deep.equal([TERMS]);
      expect(termsOf({ ext: { tdl: [TERMS, OTHER_TERMS] } })).to.deep.equal([TERMS, OTHER_TERMS]);
      expect(termsOf({ tdl: TERMS, ext: { tdl: [OTHER_TERMS] } })).to.deep.equal([TERMS, OTHER_TERMS]);
    });

    it('names nothing where there is no address', function() {
      [{}, { tdl: [] }, { ext: {} }, { ext: { tdl: [''] } }, { tdl: [5, null, {}] }, { ext: 'tdl' }, 'tdl', null, [TERMS]]
        .forEach((node) => expect(termsOf(node)).to.deep.equal([]));
    });
  });

  describe('prune', function() {
    const only = (...terms) => (named) => named.every((name) => terms.includes(name));

    it('removes an element the receiver may not have, with everything it holds', function() {
      const user = { id: 'u', eids: [entry('open'), { ...entry('closed', [TERMS]), inner: { deep: [1, 2] } }] };
      expect(prune(user, only())).to.equal(true);
      expect(user).to.deep.equal({ id: 'u', eids: [entry('open')] });
    });

    it('removes an element reached through objects only', function() {
      const user = { ext: { data: { segments: ['a'], tdl: [TERMS] }, other: 1 } };
      prune(user, only());
      expect(user).to.deep.equal({ ext: { other: 1 } });
    });

    it('keeps an element the receiver may have, and still checks what it holds', function() {
      const data = { name: 'provider', tdl: [TERMS], segment: [{ id: '1' }, { id: '2', ext: { tdl: [OTHER_TERMS] } }] };
      expect(prune(data, only(TERMS))).to.equal(true);
      expect(data).to.deep.equal({ name: 'provider', tdl: [TERMS], segment: [{ id: '1' }] });
    });

    it('answers false where the part itself may not be had', function() {
      expect(prune(entry('closed', [TERMS]), only())).to.equal(false);
    });

    it('needs every terms document an element names', function() {
      const eids = [entry('both', [TERMS, OTHER_TERMS])];
      prune(eids, only(TERMS));
      expect(eids).to.deep.equal([]);
    });

    it('leaves a part that names no terms as it was', function() {
      const user = { id: 'u', eids: [entry('open')], data: [{ name: 'n', segment: [{ id: '1' }] }] };
      const before = deepClone(user);
      expect(prune(user, only())).to.equal(true);
      expect(user).to.deep.equal(before);
    });
  });

  describe('share', function() {
    const receiversFor = (trees = {}) => ({
      yes: { allowed: () => true, tree: trees.yes },
      no: { allowed: () => false, tree: trees.no },
    });

    it('moves an item of a list that names terms to the receivers that may have it', function() {
      const shared = { site: { page: 'p' }, user: { eids: [entry('open'), entry('closed', [TERMS])] } };
      const receivers = receiversFor();
      share(shared, Object.values(receivers));
      expect(shared).to.deep.equal({ site: { page: 'p' }, user: { eids: [entry('open')] } });
      expect(receivers.yes.tree).to.deep.equal({ user: { eids: [entry('closed', [TERMS])] } });
      expect(receivers.no.tree).to.equal(undefined);
    });

    it('moves an element reached through objects only to the same place', function() {
      const shared = { user: { ext: { data: { segments: ['a'], tdl: [TERMS] }, other: 1 } } };
      const receivers = receiversFor();
      share(shared, Object.values(receivers));
      expect(shared).to.deep.equal({ user: { ext: { other: 1 } } });
      expect(receivers.yes.tree).to.deep.equal({ user: { ext: { data: { segments: ['a'], tdl: [TERMS] } } } });
      expect(receivers.no.tree).to.equal(undefined);
    });

    it('moves the whole item where something inside it names terms', function() {
      const closed = { id: '2', ext: { tdl: [TERMS] } };
      const shared = { user: { data: [{ name: 'provider', segment: [{ id: '1' }, closed] }, { name: 'open', segment: [{ id: '9' }] }] } };
      const receivers = receiversFor();
      share(shared, Object.values(receivers));
      expect(shared).to.deep.equal({ user: { data: [{ name: 'open', segment: [{ id: '9' }] }] } });
      expect(receivers.yes.tree).to.deep.equal({ user: { data: [{ name: 'provider', segment: [{ id: '1' }, closed] }] } });
      expect(receivers.no.tree).to.deep.equal({ user: { data: [{ name: 'provider', segment: [{ id: '1' }] }] } });
    });

    it('takes a list out of the shared data when nothing is left in it', function() {
      const shared = { user: { id: 'u', eids: [entry('closed', [TERMS])] } };
      share(shared, Object.values(receiversFor()));
      expect(shared).to.deep.equal({ user: { id: 'u' } });
    });

    it('lets the data a receiver already has win over what was shared', function() {
      const shared = { user: { ext: { data: { level: 'shared', kept: true, tdl: [TERMS] } } } };
      const receivers = receiversFor({ yes: { user: { ext: { data: { level: 'own' } } }, site: { page: 'p' } } });
      share(shared, Object.values(receivers));
      expect(receivers.yes.tree).to.deep.equal({
        user: { ext: { data: { level: 'own', kept: true, tdl: [TERMS] } } },
        site: { page: 'p' },
      });
    });

    it('moves everything where the shared data itself names terms', function() {
      const shared = { ext: { tdl: [TERMS] }, user: { id: 'u' } };
      const receivers = receiversFor();
      share(shared, Object.values(receivers));
      expect(shared).to.deep.equal({});
      expect(receivers.yes.tree).to.deep.equal({ ext: { tdl: [TERMS] }, user: { id: 'u' } });
      expect(receivers.no.tree).to.equal(undefined);
    });

    it('leaves shared data that names no terms as it was', function() {
      const shared = { site: { page: 'p' }, user: { eids: [entry('open')], data: [{ name: 'n', segment: [{ id: '1' }] }] } };
      const before = deepClone(shared);
      const eids = shared.user.eids;
      const receivers = receiversFor();
      share(shared, Object.values(receivers));
      expect(shared).to.deep.equal(before);
      expect(shared.user.eids).to.equal(eids);
      expect(receivers.yes.tree).to.equal(undefined);
    });
  });

  describe('the hooks', function() {
    let web, parties, settings, control;
    const domainOf = (bidder) => DOMAINS[bidder] || '';
    const fragmentsWith = (...eids) => ({ global: { site: { page: 'p' }, user: { eids } }, bidder: {} });
    // Runs the hook that asks for the lists, and resolves once it lets the
    // auction go on.
    const load = (auction) => new Promise((resolve) => control.loadLists(resolve, auction));
    const apply = (adUnits, ortb2Fragments) => control.applyToRequest(() => ortb2Fragments, adUnits, 0, 'auction', 1000, [], ortb2Fragments);

    beforeEach(function() {
      web = fakeWeb(LISTS);
      parties = tdlPartiesFactory({ get: web.get });
      settings = { domain: 'publisher.example' };
      control = tdlControlFactory({ parties, settings: () => settings, domainOf });
    });

    describe('for the request', function() {
      it('passes an element that names terms only to a bidder each side lists', async function() {
        const adUnits = adUnitsFor('yes', 'no', 'silent');
        const fragments = fragmentsWith(entry('open'), entry('closed', [TERMS]));
        await load({ adUnits, ortb2Fragments: fragments });
        apply(adUnits, fragments);
        expect(fragments.global).to.deep.equal({ site: { page: 'p' }, user: { eids: [entry('open')] } });
        expect(fragments.bidder).to.deep.equal({ yes: { user: { eids: [entry('closed', [TERMS])] } } });
      });

      it('passes it to no one where the publisher has set no domain', async function() {
        settings = {};
        const adUnits = adUnitsFor('yes');
        const fragments = fragmentsWith(entry('closed', [TERMS]));
        await load({ adUnits, ortb2Fragments: fragments });
        apply(adUnits, fragments);
        expect(fragments).to.deep.equal({ global: { site: { page: 'p' }, user: {} }, bidder: {} });
        expect(web.asked).to.deep.equal([]);
      });

      it('passes it to no one before the lists are held, and passes it once they are', async function() {
        const adUnits = adUnitsFor('yes');
        const first = fragmentsWith(entry('closed', [TERMS]));
        apply(adUnits, first);
        expect(first.bidder).to.deep.equal({});
        expect(first.global.user).to.deep.equal({});

        const second = fragmentsWith(entry('closed', [TERMS]));
        await load({ adUnits, ortb2Fragments: second });
        apply(adUnits, second);
        expect(second.bidder).to.deep.equal({ yes: { user: { eids: [entry('closed', [TERMS])] } } });
      });

      it('removes from the data a bidder already has what that bidder may not have', async function() {
        const adUnits = adUnitsFor('yes', 'no');
        const fragments = {
          global: {},
          bidder: {
            yes: { user: { eids: [entry('for yes', [TERMS])] } },
            no: { user: { eids: [entry('for no', [TERMS]), entry('open')] } },
            unlisted: { user: { eids: [entry('for unlisted', [TERMS])] } },
          },
        };
        await load({ adUnits, ortb2Fragments: fragments });
        apply(adUnits, fragments);
        expect(fragments.bidder).to.deep.equal({
          yes: { user: { eids: [entry('for yes', [TERMS])] } },
          no: { user: { eids: [entry('open')] } },
          unlisted: { user: { eids: [] } },
        });
      });

      it('leaves a request in which nothing names terms as it was', function() {
        const adUnits = adUnitsFor('yes', 'no');
        const fragments = { global: { site: { page: 'p' }, user: { eids: [entry('open')] } }, bidder: { no: { user: { id: 'u' } } } };
        const before = deepClone(fragments);
        const own = fragments.bidder.no;
        apply(adUnits, fragments);
        expect(fragments).to.deep.equal(before);
        expect(fragments.bidder.no).to.equal(own);
      });

      it('hands core the arguments it was given and answers with what core answers', function() {
        const seen = [];
        const result = control.applyToRequest((...args) => { seen.push(args); return 'requests'; }, [], 1, 'a', 2, ['l'], undefined, 'metrics');
        expect(result).to.equal('requests');
        expect(seen).to.deep.equal([[[], 1, 'a', 2, ['l'], undefined, 'metrics']]);
      });
    });

    describe('for each impression', function() {
      const impData = () => ({ ext: { data: { open: 1, closed: { v: 2, tdl: [TERMS] } } } });

      it('removes from the copy each bidder has what that bidder may not have', async function() {
        await parties.agreed('publisher.example', 'yes.example', [TERMS]);
        const requests = [
          { bidderCode: 'yes', bids: [{ bidder: 'yes', ortb2Imp: impData() }] },
          { bidderCode: 'no', bids: [{ bidder: 'no', ortb2Imp: impData() }] },
          { bidderCode: 'silent', bids: [{ bidder: 'silent', ortb2Imp: impData() }, { bidder: 'silent' }] },
        ];
        expect(control.applyToImps((result) => result, requests)).to.equal(requests);
        expect(requests[0].bids[0].ortb2Imp).to.deep.equal(impData());
        expect(requests[1].bids[0].ortb2Imp).to.deep.equal({ ext: { data: { open: 1 } } });
        expect(requests[2].bids[0].ortb2Imp).to.deep.equal({ ext: { data: { open: 1 } } });
      });

      it('gives each bidder on an ad unit copied for Prebid Server its own copy', async function() {
        await parties.agreed('publisher.example', 'yes.example', [TERMS]);
        const adUnit = { code: 'slot', ortb2Imp: impData(), bids: [{ bidder: 'yes' }, { bidder: 'no', ortb2Imp: { ext: { own: 1 } } }], s2sBid: { module: 'pbsBidAdapter' } };
        control.applyToImps((result) => result, [{ bidderCode: 'yes', bids: [], adUnitsS2SCopy: [adUnit] }]);
        expect(adUnit.ortb2Imp).to.deep.equal({ ext: { data: { open: 1 } } });
        expect(adUnit.bids[0].ortb2Imp).to.deep.equal({ ext: { data: { closed: { v: 2, tdl: [TERMS] } } } });
        expect(adUnit.bids[1].ortb2Imp).to.deep.equal({ ext: { own: 1 } });
      });
    });

    describe('asking for the lists', function() {
      it('lets the auction go on at once where nothing names terms', function() {
        let went = false;
        control.loadLists(() => { went = true; }, { adUnits: adUnitsFor('yes', 'no'), ortb2Fragments: fragmentsWith(entry('open')) });
        expect(went).to.equal(true);
        expect(web.asked).to.deep.equal([]);
      });

      it('asks once for the lists of the publisher and of each bidder that declares a domain', async function() {
        const auction = { adUnits: adUnitsFor('yes', 'no', 'silent'), ortb2Fragments: fragmentsWith(entry('closed', [TERMS])) };
        await load(auction);
        expect(web.asked.slice().sort()).to.deep.equal([listAt('no.example'), listAt('publisher.example'), listAt('yes.example')]);

        let went = false;
        control.loadLists(() => { went = true; }, auction);
        expect(went).to.equal(true);
        expect(web.asked).to.have.lengthOf(3);
      });

      it('sees terms named in the data of an impression', async function() {
        const adUnits = adUnitsFor('yes');
        adUnits[0].ortb2Imp = { ext: { data: { tdl: [OTHER_TERMS] } } };
        await load({ adUnits, ortb2Fragments: { global: {} } });
        expect(web.asked.slice().sort()).to.deep.equal([listAt('publisher.example', OTHER_TERMS), listAt('yes.example', OTHER_TERMS)]);
      });

      it('waits no longer than the auction delay for a list', async function() {
        const never = tdlControlFactory({
          parties: tdlPartiesFactory({ get: () => new Promise(() => {}) }),
          settings: () => ({ domain: 'publisher.example', auctionDelay: 20 }),
          domainOf,
        });
        const started = Date.now();
        await new Promise((resolve) => never.loadLists(resolve, { adUnits: adUnitsFor('yes'), ortb2Fragments: fragmentsWith(entry('closed', [TERMS])) }));
        expect(Date.now() - started).to.be.within(15, 1000);
      });

      it('does not wait at all where the auction delay is 0, and still asks', async function() {
        settings = { domain: 'publisher.example', auctionDelay: 0 };
        let went = false;
        control.loadLists(() => { went = true; }, { adUnits: adUnitsFor('yes'), ortb2Fragments: fragmentsWith(entry('closed', [TERMS])) });
        expect(went).to.equal(true);
        await new Promise((resolve) => setTimeout(resolve));
        expect(web.asked).to.have.lengthOf(2);
      });
    });

    // The rule as a page has it, with real adapters, the Prebid configuration
    // and lists a page stored earlier, so that core makes each request and
    // nothing is fetched.
    describe('with core', function() {
      const adapter = (code, tdlDomain) => registerBidder({
        code,
        ...(tdlDomain ? { tdlDomain } : {}),
        isBidRequestValid: () => true,
        buildRequests: () => [],
        interpretResponse: () => [],
      });
      const stored = Object.keys(LISTS).map((url) => STORAGE_KEY_PREFIX + url);
      const requestsFor = (adUnits, fragments) => {
        const requests = adapterManager.makeBidRequests(adUnits, Date.now(), 'auction', 1000, [], fragments);
        return (bidder) => requests.find((r) => r.bidderCode === bidder);
      };

      beforeEach(function() {
        installTdlControl();
        config.setConfig({ tdl: { domain: 'Publisher.Example' } });
        adapter('tdlYes', 'Yes.Example');
        adapter('tdlNo', 'no.example');
        adapter('tdlSilent');
        adapterManager.aliasBidAdapter('tdlYes', 'tdlYesAlias');
        Object.keys(LISTS).forEach((url) => {
          localStorage.setItem(STORAGE_KEY_PREFIX + url, JSON.stringify({ t: Date.now(), d: [LISTS[url]] }));
        });
      });

      afterEach(function() {
        config.resetConfig();
        stored.forEach((key) => localStorage.removeItem(key));
        ['tdlYes', 'tdlNo', 'tdlSilent', 'tdlYesAlias'].forEach((code) => {
          delete adapterManager.bidderRegistry[code];
          delete adapterManager.aliasRegistry[code];
        });
      });

      it('reaches each bidder request that core makes', function() {
        const adUnits = adUnitsFor('tdlYes', 'tdlNo', 'tdlSilent', 'tdlYesAlias');
        adUnits[0].ortb2Imp = { ext: { data: { open: 1, closed: { v: 2, tdl: [TERMS] } } } };
        const request = requestsFor(adUnits, fragmentsWith(entry('open'), entry('closed', [TERMS])));

        ['tdlYes', 'tdlYesAlias'].forEach((bidder) => {
          expect(request(bidder).ortb2.user.eids).to.deep.equal([entry('open'), entry('closed', [TERMS])]);
          expect(request(bidder).bids[0].ortb2.user.eids).to.have.lengthOf(2);
          expect(request(bidder).bids[0].ortb2Imp.ext.data).to.deep.equal({ open: 1, closed: { v: 2, tdl: [TERMS] } });
        });
        ['tdlNo', 'tdlSilent'].forEach((bidder) => {
          expect(request(bidder).ortb2.user.eids).to.deep.equal([entry('open')]);
          expect(request(bidder).bids[0].ortb2Imp.ext.data).to.deep.equal({ open: 1 });
        });
        expect(adUnits[0].ortb2Imp.ext.data).to.deep.equal({ open: 1, closed: { v: 2, tdl: [TERMS] } });
      });

      it('passes what names terms to no bidder where the publisher has set no domain', function() {
        config.resetConfig();
        const request = requestsFor(adUnitsFor('tdlYes', 'tdlNo'), fragmentsWith(entry('open'), entry('closed', [TERMS])));
        ['tdlYes', 'tdlNo'].forEach((bidder) => {
          expect(request(bidder).ortb2.user.eids).to.deep.equal([entry('open')]);
        });
      });

      it('makes the requests core makes today where nothing names terms', function() {
        const adUnits = adUnitsFor('tdlYes', 'tdlNo', 'tdlSilent');
        adUnits[0].ortb2Imp = { ext: { data: { open: 1 } } };
        const fragments = { global: { site: { page: 'p' }, user: { eids: [entry('open')] } }, bidder: { tdlNo: { user: { id: 'u' } } } };
        const request = requestsFor(adUnits, fragments);

        expect(request('tdlYes').ortb2.user).to.deep.equal({ eids: [entry('open')] });
        expect(request('tdlNo').ortb2.user).to.deep.equal({ eids: [entry('open')], id: 'u' });
        expect(request('tdlSilent').ortb2.user).to.deep.equal({ eids: [entry('open')] });
        ['tdlYes', 'tdlNo', 'tdlSilent'].forEach((bidder) => {
          expect(request(bidder).ortb2.site).to.deep.equal({ page: 'p' });
          expect(request(bidder).bids[0].ortb2Imp.ext.data).to.deep.equal({ open: 1 });
        });
        expect(fragments).to.deep.equal({ global: { site: { page: 'p' }, user: { eids: [entry('open')] } }, bidder: { tdlNo: { user: { id: 'u' } } } });
      });
    });
  });

  describe('installTdlControl', function() {
    it('attaches its hooks once however often it is called', function() {
      installTdlControl();
      const before = adapterManager.makeBidRequests.getHooks().length;
      installTdlControl();
      expect(adapterManager.makeBidRequests.getHooks().length).to.equal(before);
      expect(before).to.be.greaterThan(1);
    });
  });
});
