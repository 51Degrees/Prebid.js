import {
  DEFAULT_FAILURE_TTL,
  DEFAULT_TTL,
  STORAGE_KEY_PREFIX,
  parseParties,
  partiesUrl,
  tdlPartiesFactory,
} from 'libraries/tdlParties/tdlParties.js';

const TERMS = 'https://m4ow.uk/mtm/2.txt';
const PUBLISHER_LIST = 'https://publisher.example/.well-known/tdl/m4ow.uk/mtm/2.txt';
const BIDDER_LIST = 'https://bidder.example/.well-known/tdl/m4ow.uk/mtm/2.txt';

// A place to fetch lists from, which counts how often each address is asked
// for. An address with no body rejects, as a missing file does.
const fakeWeb = (bodies) => {
  const asked = [];
  const get = (url) => {
    asked.push(url);
    return url in bodies ? Promise.resolve(bodies[url]) : Promise.reject(new Error('404'));
  };
  return { asked, get, bodies };
};

// Local storage held in an object, as the storage manager offers it.
const fakeStorage = (enabled = true) => {
  const data = {};
  return {
    data,
    localStorageIsEnabled: () => enabled,
    getDataFromLocalStorage: (key) => (key in data ? data[key] : null),
    setDataInLocalStorage: (key, value) => { data[key] = value; },
  };
};

describe('tdlParties', function() {
  describe('partiesUrl', function() {
    it('puts the terms address without its scheme after /.well-known/tdl/', function() {
      expect(partiesUrl('publisher.example', TERMS)).to.equal(PUBLISHER_LIST);
    });

    it('drops any scheme, and any query or fragment', function() {
      expect(partiesUrl('a.example', 'http://terms.example/t/1.txt?x=1#top'))
        .to.equal('https://a.example/.well-known/tdl/terms.example/t/1.txt');
    });

    it('lower cases the party domain', function() {
      expect(partiesUrl(' Publisher.Example ', TERMS)).to.equal(PUBLISHER_LIST);
    });

    it('answers null where the terms document has no address', function() {
      expect(partiesUrl('publisher.example', 'not an address')).to.equal(null);
      expect(partiesUrl('publisher.example', undefined)).to.equal(null);
    });
  });

  describe('parseParties', function() {
    it('reads one domain to a line, without regard to case', function() {
      expect(parseParties('a.example\nB.Example\r\nc.example')).to.deep.equal(['a.example', 'b.example', 'c.example']);
    });

    it('ignores blank lines, comments and repeats', function() {
      expect(parseParties('# parties\n\n a.example # a note\na.example\n')).to.deep.equal(['a.example']);
    });

    it('ignores a line that is not a domain', function() {
      expect(parseParties('a.example\nhttps://b.example/x\nnot a domain\n<html>')).to.deep.equal(['a.example']);
    });

    it('answers an empty list for anything that is not text', function() {
      expect(parseParties(undefined)).to.deep.equal([]);
      expect(parseParties({})).to.deep.equal([]);
    });
  });

  describe('agreed', function() {
    it('is true where each party lists the other', async function() {
      const web = fakeWeb({ [PUBLISHER_LIST]: 'bidder.example', [BIDDER_LIST]: 'other.example\npublisher.example' });
      const parties = tdlPartiesFactory({ get: web.get });
      expect(await parties.agreed('publisher.example', 'bidder.example', [TERMS])).to.equal(true);
    });

    it('is false where the sender does not list the receiver', async function() {
      const web = fakeWeb({ [PUBLISHER_LIST]: 'other.example', [BIDDER_LIST]: 'publisher.example' });
      const parties = tdlPartiesFactory({ get: web.get });
      expect(await parties.agreed('publisher.example', 'bidder.example', [TERMS])).to.equal(false);
    });

    it('is false where the receiver does not list the sender', async function() {
      const web = fakeWeb({ [PUBLISHER_LIST]: 'bidder.example', [BIDDER_LIST]: 'other.example' });
      const parties = tdlPartiesFactory({ get: web.get });
      expect(await parties.agreed('publisher.example', 'bidder.example', [TERMS])).to.equal(false);
    });

    it('is false where a list cannot be fetched', async function() {
      const web = fakeWeb({ [PUBLISHER_LIST]: 'bidder.example' });
      const parties = tdlPartiesFactory({ get: web.get });
      expect(await parties.agreed('publisher.example', 'bidder.example', [TERMS])).to.equal(false);
    });

    it('needs both lists for every terms document named', async function() {
      const second = 'https://publisher.example/tdl.json';
      const web = fakeWeb({
        [PUBLISHER_LIST]: 'bidder.example',
        [BIDDER_LIST]: 'publisher.example',
        'https://publisher.example/.well-known/tdl/publisher.example/tdl.json': 'bidder.example',
      });
      const parties = tdlPartiesFactory({ get: web.get });
      expect(await parties.agreed('publisher.example', 'bidder.example', [TERMS])).to.equal(true);
      expect(await parties.agreed('publisher.example', 'bidder.example', [TERMS, second])).to.equal(false);

      web.bodies['https://bidder.example/.well-known/tdl/publisher.example/tdl.json'] = 'publisher.example';
      const later = tdlPartiesFactory({ get: web.get });
      expect(await later.agreed('publisher.example', 'bidder.example', [TERMS, second])).to.equal(true);
    });

    it('is false where no terms document, sender or receiver is given', async function() {
      const web = fakeWeb({});
      const parties = tdlPartiesFactory({ get: web.get });
      expect(await parties.agreed('publisher.example', 'bidder.example', [])).to.equal(false);
      expect(await parties.agreed('', 'bidder.example', [TERMS])).to.equal(false);
      expect(await parties.agreed('publisher.example', undefined, [TERMS])).to.equal(false);
      expect(web.asked).to.deep.equal([]);
    });
  });

  describe('agreedNow', function() {
    const ask = ['publisher.example', 'bidder.example', [TERMS]];

    it('answers from the lists held, and never fetches', async function() {
      const web = fakeWeb({ [PUBLISHER_LIST]: 'bidder.example', [BIDDER_LIST]: 'publisher.example' });
      const parties = tdlPartiesFactory({ get: web.get });
      expect(parties.agreedNow(...ask)).to.equal(false);
      expect(parties.known(...ask)).to.equal(false);
      expect(web.asked).to.deep.equal([]);

      expect(await parties.agreed(...ask)).to.equal(true);
      expect(parties.agreedNow(...ask)).to.equal(true);
      expect(parties.known(...ask)).to.equal(true);
      expect(parties.agreedNow('publisher.example', 'other.example', [TERMS])).to.equal(false);
      expect(web.asked).to.have.lengthOf(2);
    });

    it('is false, and known, where a list could not be fetched', async function() {
      const web = fakeWeb({ [PUBLISHER_LIST]: 'bidder.example' });
      const parties = tdlPartiesFactory({ get: web.get });
      await parties.agreed(...ask);
      expect(parties.agreedNow(...ask)).to.equal(false);
      expect(parties.known(...ask)).to.equal(true);
    });

    it('is false where a terms document has no address, with nothing to fetch', async function() {
      const web = fakeWeb({});
      const parties = tdlPartiesFactory({ get: web.get });
      expect(parties.agreedNow('publisher.example', 'bidder.example', ['not an address'])).to.equal(false);
      expect(parties.known('publisher.example', 'bidder.example', ['not an address'])).to.equal(true);
      expect(await parties.agreed('publisher.example', 'bidder.example', ['not an address'])).to.equal(false);
      expect(web.asked).to.deep.equal([]);
    });

    it('reads a list another page stored', async function() {
      const storage = fakeStorage();
      const web = fakeWeb({ [PUBLISHER_LIST]: 'bidder.example', [BIDDER_LIST]: 'publisher.example' });
      await tdlPartiesFactory({ storage, get: web.get }).agreed(...ask);
      expect(tdlPartiesFactory({ storage, get: fakeWeb({}).get }).agreedNow(...ask)).to.equal(true);
    });
  });

  describe('the cache', function() {
    let clock;
    const web = () => fakeWeb({ [PUBLISHER_LIST]: 'bidder.example', [BIDDER_LIST]: 'publisher.example' });
    const ask = (parties) => parties.agreed('publisher.example', 'bidder.example', [TERMS]);

    beforeEach(function() {
      clock = { time: 1000000 };
    });

    it('fetches each list once however often it is asked', async function() {
      const w = web();
      const parties = tdlPartiesFactory({ get: w.get, now: () => clock.time });
      for (let i = 0; i < 5; i++) {
        expect(await ask(parties)).to.equal(true);
      }
      expect(w.asked.sort()).to.deep.equal([BIDDER_LIST, PUBLISHER_LIST]);
    });

    it('shares one request between questions asked while it is in flight', async function() {
      const w = web();
      const parties = tdlPartiesFactory({ get: w.get, now: () => clock.time });
      const answers = await Promise.all([ask(parties), ask(parties), ask(parties)]);
      expect(answers).to.deep.equal([true, true, true]);
      expect(w.asked).to.have.lengthOf(2);
    });

    it('fetches a list again once the copy is older than the ttl', async function() {
      const w = web();
      const parties = tdlPartiesFactory({ get: w.get, now: () => clock.time });
      await ask(parties);
      clock.time += DEFAULT_TTL - 1;
      await ask(parties);
      expect(w.asked).to.have.lengthOf(2);

      w.bodies[BIDDER_LIST] = 'someone-else.example';
      clock.time += 1;
      expect(await ask(parties)).to.equal(false);
      expect(w.asked).to.have.lengthOf(4);
    });

    it('remembers a failed fetch for the shorter failure ttl', async function() {
      const w = fakeWeb({ [PUBLISHER_LIST]: 'bidder.example' });
      const parties = tdlPartiesFactory({ get: w.get, now: () => clock.time });
      expect(await ask(parties)).to.equal(false);
      clock.time += DEFAULT_FAILURE_TTL - 1;
      expect(await ask(parties)).to.equal(false);
      expect(w.asked.filter((url) => url === BIDDER_LIST)).to.have.lengthOf(1);

      w.bodies[BIDDER_LIST] = 'publisher.example';
      clock.time += 1;
      expect(await ask(parties)).to.equal(true);
      expect(w.asked.filter((url) => url === BIDDER_LIST)).to.have.lengthOf(2);
      expect(w.asked.filter((url) => url === PUBLISHER_LIST)).to.have.lengthOf(1);
    });

    it('keeps lists in local storage, so a later page does not fetch them', async function() {
      const storage = fakeStorage();
      const first = web();
      await ask(tdlPartiesFactory({ storage, get: first.get, now: () => clock.time }));
      expect(Object.keys(storage.data).sort())
        .to.deep.equal([STORAGE_KEY_PREFIX + BIDDER_LIST, STORAGE_KEY_PREFIX + PUBLISHER_LIST]);

      const second = fakeWeb({});
      const nextPage = tdlPartiesFactory({ storage, get: second.get, now: () => clock.time });
      expect(await ask(nextPage)).to.equal(true);
      expect(second.asked).to.deep.equal([]);
    });

    it('does not use a stored list that is older than the ttl', async function() {
      const storage = fakeStorage();
      await ask(tdlPartiesFactory({ storage, get: web().get, now: () => clock.time }));
      clock.time += DEFAULT_TTL;
      const later = fakeWeb({});
      expect(await ask(tdlPartiesFactory({ storage, get: later.get, now: () => clock.time }))).to.equal(false);
      expect(later.asked).to.have.lengthOf(2);
    });

    it('works from memory alone where local storage is not allowed', async function() {
      const storage = fakeStorage(false);
      const w = web();
      const parties = tdlPartiesFactory({ storage, get: w.get, now: () => clock.time });
      expect(await ask(parties)).to.equal(true);
      expect(await ask(parties)).to.equal(true);
      expect(storage.data).to.deep.equal({});
      expect(w.asked).to.have.lengthOf(2);
    });

    it('fetches again where what is stored cannot be read', async function() {
      const storage = fakeStorage();
      storage.data[STORAGE_KEY_PREFIX + PUBLISHER_LIST] = 'not json';
      storage.data[STORAGE_KEY_PREFIX + BIDDER_LIST] = JSON.stringify({ t: 'yesterday', d: 'publisher.example' });
      const w = web();
      expect(await ask(tdlPartiesFactory({ storage, get: w.get, now: () => clock.time }))).to.equal(true);
      expect(w.asked).to.have.lengthOf(2);
    });
  });
});
